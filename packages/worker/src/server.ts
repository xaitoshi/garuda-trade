/**
 * Garuda server: HTTP API and streaming risk worker in ONE process (they share the challenge cache, so a breach the
 * worker catches is what the next API read returns). Environment: see .env.example.
 */
import {
  AuthService,
  PrivyServerVerifier,
  ChallengeService,
  InMemoryAuthStore,
  InMemoryChallengeStore,
  InMemoryOrderStore,
  PaymentRequiredProvider,
  PgAuthStore,
  PgChallengeStore,
  PgOrderStore,
  PgPayoutStore,
  InMemoryPayoutStore,
  PayoutService,
  PurchaseService,
  buildApp,
  type AuthStore,
  type ChallengeStore,
  type OrderStore,
  type PayoutStore,
  MIN_ADMIN_TOKEN_LENGTH,
  EarlyAccessService,
  InMemoryEarlyStore,
  PgEarlyStore,
  type EarlyStore,
  isSolanaAddress,
} from "@garuda/api";
import { DEFAULT_ART_DIR, HttpRpc, MetaplexCoreKnights, SolanaTreasuryPayout, SolanaUsdc, assertDevnetCluster, loadKeypairFile } from "@garuda/chain";
import { EarlyRpc, MAINNET_USDC_MINT, MetaplexEarlyMinter, assertEarlyCluster, keypairFromSecret, verifyUsdcPayment, type EarlyCluster } from "@garuda/chain";
import { openDb } from "@garuda/db";
import { payoutPolicyFromEnv } from "@garuda/risk-engine";
import { PhoenixSdkProvider, PollingFeed, ReplayProvider, loadRecordedMarkets, type MarketDataProvider } from "@garuda/market-data";
import { InMemoryRoutingStore, PgRoutingStore, createRouterFromEnv, type PhoenixRouter, type RoutingStore } from "@garuda/router";
import { RiskWorker } from "./worker.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);
const authOff = env.GARUDA_AUTH === "off";

// Privy sign-in (email -> embedded Solana wallet, or an external wallet through Privy). Off unless PRIVY_APP_ID is set.
// The owner supplies PRIVY_APP_ID and PRIVY_APP_SECRET from the Privy dashboard; nothing here has a default.
const privyAppId = env.PRIVY_APP_ID?.trim();
const privySecret = env.PRIVY_APP_SECRET?.trim();
if (Boolean(privyAppId) !== Boolean(privySecret)) {
  console.error("[garuda] set BOTH PRIVY_APP_ID and PRIVY_APP_SECRET (or neither, to run on wallet sign-in only)");
  process.exit(1);
}
const privy = privyAppId && privySecret ? new PrivyServerVerifier({ appId: privyAppId, appSecret: privySecret }) : undefined;

let market: MarketDataProvider = new PhoenixSdkProvider();
if (!(await market.ping())) {
  console.warn("[garuda] Phoenix unreachable, falling back to RECORDED books (replay). Prices will not move.");
  market = new ReplayProvider(loadRecordedMarkets());
}

let store: ChallengeStore = new InMemoryChallengeStore();
let authStore: AuthStore = new InMemoryAuthStore();
let orderStore: OrderStore = new InMemoryOrderStore();
let payoutStore: PayoutStore = new InMemoryPayoutStore();
let routingStore: RoutingStore = new InMemoryRoutingStore();
let earlyStore: EarlyStore = new InMemoryEarlyStore();
let storage = "memory (state is lost on restart: set DATABASE_URL)";
let closeDb: () => Promise<void> = async () => {};
if (env.DATABASE_URL) {
  const db = await openDb(env.DATABASE_URL);
  store = new PgChallengeStore(db);
  authStore = new PgAuthStore(db);
  orderStore = new PgOrderStore(db);
  payoutStore = new PgPayoutStore(db);
  routingStore = new PgRoutingStore(db);
  earlyStore = new PgEarlyStore(db);
  closeDb = () => db.close();
  storage = "postgres";
}

// M3/M4: knight NFTs and USDC checkout on Solana DEVNET. Off unless GARUDA_CHAIN=devnet (mainnet is refused by the chain code).
const chainOn = env.GARUDA_CHAIN === "devnet";
let knights: MetaplexCoreKnights | undefined;
let usdc: SolanaUsdc | undefined;
let payoutExecutor: SolanaTreasuryPayout | undefined;
const publicUrl = env.GARUDA_PUBLIC_URL ?? `http://localhost:${port}`;
if (chainOn) {
  const rpcUrl = env.GARUDA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required when GARUDA_CHAIN=devnet (run scripts/chain-setup.ts)`); })();
  // GARUDA_CHAIN_ALLOW_LOCAL=1 skips the genesis check for a LOCAL validator on loopback (dry runs only). Mainnet URLs are always refused.
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpcUrl);
  if (!(env.GARUDA_CHAIN_ALLOW_LOCAL === "1" && loopback)) await assertDevnetCluster(new HttpRpc(rpcUrl));
  const authority = loadKeypairFile(env.GARUDA_KEYPAIR_PATH ?? ".keys/platform.json");
  knights = new MetaplexCoreKnights({ rpcUrl, authority, baseUrl: publicUrl, collection: need("GARUDA_KNIGHT_COLLECTION") });
  usdc = new SolanaUsdc({ rpcUrl, rpc: new HttpRpc(rpcUrl), mint: need("GARUDA_USDC_MINT"), treasury: authority });
  // M8 payouts: the treasury sends USDC from the platform key on devnet. "squads" (multisig proposals) is a stub that
  // is refused here until it is built, so a mainnet launch cannot silently run on a hot key.
  const executorKind = env.GARUDA_PAYOUT_EXECUTOR ?? "treasury-key";
  if (executorKind === "squads") {
    console.error("[garuda] GARUDA_PAYOUT_EXECUTOR=squads is not implemented yet (use treasury-key on devnet)");
    process.exit(1);
  }
  if (executorKind !== "treasury-key") {
    console.error(`[garuda] unknown GARUDA_PAYOUT_EXECUTOR "${executorKind}" (treasury-key)`);
    process.exit(1);
  }
  payoutExecutor = new SolanaTreasuryPayout({ rpcUrl, rpc: new HttpRpc(rpcUrl), mint: usdc.mint, treasury: authority });
}

// Payout policy: GARUDA_PAYOUT_SPLIT (default 0.8), GARUDA_PAYOUT_AUTO_MAX (default 500 USD). Invalid values stop the boot.
let payoutPolicy;
try {
  payoutPolicy = payoutPolicyFromEnv(env);
} catch (e) {
  console.error(`[garuda] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
// Garuda Beta Access (/early, docs/early-mint.md). Waitlist only unless EARLY_MINT_ENABLED=true. When enabled it runs on
// EARLY_CLUSTER (default mainnet-beta): buyers pay EARLY_PRICE_USD in USDC to EARLY_TREASURY and the mint authority
// (EARLY_MINT_KEYPAIR) mints a Metaplex Core asset into EARLY_COLLECTION. Any missing or wrong setting keeps it OFF.
const earlyCluster: EarlyCluster = env.EARLY_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";
const earlyBase = {
  store: earlyStore,
  priceUsd: Number(env.EARLY_PRICE_USD ?? 1.69),
  maxSupply: Number(env.EARLY_MAX_SUPPLY ?? 1000),
  cluster: earlyCluster,
  imageUrl: env.EARLY_IMAGE_URL ?? "https://garuda.markets/early/garuda-beta-access.png",
  metadataUri: env.EARLY_METADATA_URI ?? "https://garuda.markets/early/metadata.json",
  log: (m: string) => console.log(m),
};
// Owner's treasury for the $1.69 USDC proceeds (its USDC associated token account receives them; the buyer's transaction
// creates that account idempotently if it is missing). Receive-only: the server never holds this wallet's key.
const DEFAULT_EARLY_TREASURY = "CCezKqU697kanduvFk8GPwD484DGtKH46tfV9o7T2xKq";
const earlyTreasury = (env.EARLY_MINT_TREASURY ?? env.EARLY_TREASURY ?? DEFAULT_EARLY_TREASURY).trim();
if (!isSolanaAddress(earlyTreasury)) {
  console.error(`[garuda-early] EARLY_MINT_TREASURY "${earlyTreasury}" is not a valid Solana address`);
  process.exit(1);
}
let early: EarlyAccessService;
let earlyLabel = "waitlist";
try {
  if (env.EARLY_MINT_ENABLED !== "true") throw Object.assign(new Error("EARLY_MINT_ENABLED is not true"), { quiet: true });
  const need = (k: string) => env[k]?.trim() || (() => { throw new Error(`${k} is required when EARLY_MINT_ENABLED=true`); })();
  const rpcUrl = need("EARLY_RPC_URL");
  const rpc = new EarlyRpc(rpcUrl);
  await assertEarlyCluster(rpc, earlyCluster);
  const secret = JSON.parse(need("EARLY_MINT_KEYPAIR")) as number[];
  if (!Array.isArray(secret) || secret.length !== 64) throw new Error("EARLY_MINT_KEYPAIR must be a 64-byte JSON array (Solana CLI keypair file contents)");
  const usdcMint = env.EARLY_USDC_MINT?.trim() || (earlyCluster === "mainnet-beta" ? MAINNET_USDC_MINT : need("EARLY_USDC_MINT"));
  const treasury = earlyTreasury;
  const authority = keypairFromSecret(Uint8Array.from(secret));
  const minter = new MetaplexEarlyMinter({ rpcUrl, cluster: earlyCluster, authority, collection: need("EARLY_COLLECTION"), metadataUri: earlyBase.metadataUri, soulbound: env.EARLY_SOULBOUND !== "false" });
  early = new EarlyAccessService({ ...earlyBase, enabled: true, minter, payment: { mint: usdcMint, treasury, verify: (i) => verifyUsdcPayment(rpc, { mint: usdcMint, treasury }, i) } });
  earlyLabel = `minting on ${earlyCluster} $${earlyBase.priceUsd} cap ${earlyBase.maxSupply}`;
} catch (e) {
  if (!(e as { quiet?: boolean }).quiet) console.error(`[garuda-early] minting config rejected, /early stays waitlist only: ${e instanceof Error ? e.message : e}`);
  early = new EarlyAccessService({ ...earlyBase, enabled: false });
}

// Admin API (approve, reject and retry payouts). Off (routes answer 404) unless GARUDA_ADMIN_TOKEN is set.
const adminToken = env.GARUDA_ADMIN_TOKEN?.trim() || undefined;
if (adminToken && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
  console.error(`[garuda] GARUDA_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters (openssl rand -hex 32)`);
  process.exit(1);
}

// Phase 2 Phoenix routing (packages/router, docs/phoenix-routing.md). OFF unless ROUTING_ENABLED=true; DRY_RUN by default
// once enabled. Bound late because the router reads books through the service and the service feeds it fills.
let router: PhoenixRouter | undefined;

const service = new ChallengeService({
  onFills: (ev) => router?.onFills(ev),
  // Path to Funded (rulebook section 9): KYC and the risk review are manual ops steps unless set to "auto" (dev only).
  kycMode: env.GARUDA_KYC_MODE === "auto" ? "auto" : "manual",
  fundedReview: env.GARUDA_FUNDED_REVIEW === "auto" ? "auto" : "manual",
  market,
  store,
  payoutPolicy,
  requireWalletForDemo: !authOff,
  ...(knights ? { knights, requirePayment: true, payments: new PaymentRequiredProvider() } : {}),
});
try {
  router = await createRouterFromEnv(env, {
    store: routingStore,
    log: (m) => console.log(`[garuda-router] ${m}`),
    traderBook: async (id) => {
      const st = await service.getState(id, { refresh: false }).catch(() => undefined);
      if (!st) return undefined;
      return {
        stage: st.stage,
        demo: st.demo,
        wallet: st.wallet,
        status: st.status,
        positions: Object.fromEntries(st.positions.map((p) => [p.symbol, { size: p.side === "long" ? p.size : -p.size, markPrice: p.markPrice }])),
      };
    },
  });
} catch (e) {
  // A bad routing config must not take the API down: report it and run with routing off.
  console.error(`[garuda-router] routing config rejected, routing stays OFF: ${e instanceof Error ? e.message : e}`);
  router = undefined;
}
if (router?.mode !== "disabled") router?.start();
const payouts = payoutExecutor ? new PayoutService({ service, executor: payoutExecutor, store: payoutStore }) : undefined;
const purchases = usdc ? new PurchaseService({ service, usdc, store: orderStore }) : undefined;

// Heal anything an RPC outage left half done: knights whose onchain state lags, paid orders not fulfilled, refunds owed.
const reconcileEveryMs = Number(env.GARUDA_RECONCILE_MS ?? 30_000);
let reconciler: ReturnType<typeof setInterval> | undefined;
if (chainOn) {
  const run = async () => {
    try {
      const k = await service.reconcileKnights();
      const p = await purchases!.reconcile();
      if (k.synced || k.failed || p.fulfilled || p.refunded || p.stillOwed) console.log(`[garuda-chain] reconcile knights ${JSON.stringify(k)} orders ${JSON.stringify(p)}`);
      const o = await payouts!.reconcile();
      if (o.paid || o.failed) console.log(`[garuda-chain] reconcile payouts ${JSON.stringify(o)}`);
    } catch (e) {
      console.error("[garuda-chain] reconcile failed:", e instanceof Error ? e.message : e);
    }
  };
  // Resume payouts a crash or an RPC outage left half done: finishes debits, resolves "sending" by chain lookup.
  void payouts!.reconcile().then((o) => console.log(`[garuda-chain] startup payout reconcile ${JSON.stringify(o)}`), (e) => console.error("[garuda-chain] startup payout reconcile failed:", e instanceof Error ? e.message : e));
  void service.reconcileKnights({ all: true }).catch((e) => console.error("[garuda-chain] startup sync failed:", e instanceof Error ? e.message : e));
  reconciler = setInterval(() => void run(), reconcileEveryMs);
}

const feed = new PollingFeed({ provider: market, intervalMs: Number(env.GARUDA_POLL_MS ?? 1000) });
const worker = new RiskWorker({
  service,
  feed,
  staleAfterMs: Number(env.GARUDA_STALE_FEED_MS ?? 10_000),
  onError: (err, ctx) => console.error(`[garuda-worker] ${ctx}:`, err instanceof Error ? err.message : err),
  onResults: (snap, results) => {
    for (const r of results) if (r.events.length) console.log(`[garuda-worker] ${snap.symbol} ${r.challengeId} ${r.events.map((e) => e.type).join(",")}`);
  },
});
if (env.GARUDA_WORKER !== "off") await worker.start();

const app = buildApp({
  service,
  purchases,
  payouts,
  adminToken,
  nft: knights ? { baseUrl: publicUrl, artDir: env.GARUDA_ART_DIR ?? DEFAULT_ART_DIR } : undefined,
  logger: true,
  routing: router,
  early,
  builderCodeConfigured: Boolean(env.PHOENIX_BUILDER_CODE),
  auth: authOff ? undefined : new AuthService({ store: authStore, domain: env.GARUDA_AUTH_DOMAIN ?? "garuda", allowedOrigins: env.GARUDA_CORS_ORIGIN === "*" ? "*" : (env.GARUDA_CORS_ORIGIN ?? "").split(",").map((o) => o.trim()).filter(Boolean), privy }),
  trustProxy: env.GARUDA_TRUST_PROXY === "1",
  corsOrigins: env.GARUDA_CORS_ORIGIN === "*" ? "*" : env.GARUDA_CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean),
  health: () => ({
    storage,
    worker: worker.metrics().running,
    market: market.name,
    early: earlyLabel,
    chain: chainOn ? { cluster: "devnet", collection: knights!.collection, usdcMint: usdc!.mint, treasury: usdc!.treasury, dirtyKnights: service.dirtyKnightIds().length } : "off",
  }),
  metrics: () => worker.metrics(),
});

const shutdown = async () => {
  if (reconciler) clearInterval(reconciler);
  await payouts?.idle();
  await router?.stop();
  await worker.stop();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port, host: "0.0.0.0" });
console.log(
  `[garuda] listening on :${port} | market ${market.name} | storage ${storage} | auth ${authOff ? "OFF (dev only)" : privy ? "Privy (email + wallets) and wallet signature" : "wallet signature"} | worker ${env.GARUDA_WORKER === "off" ? "off" : `polling every ${env.GARUDA_POLL_MS ?? 1000}ms`} | payouts ${payouts ? `${payoutExecutor!.name} split ${payoutPolicy.split} auto<=$${payoutPolicy.autoMaxUsd}${adminToken ? " admin on" : " admin OFF"}` : "off"} | chain ${chainOn ? "solana DEVNET (knights + USDC)" : "off"} | early ${earlyLabel} | routing ${router?.healthLabel() ?? "disabled"}${router?.modeReason && router.mode === "disabled" && router.config.enabled ? ` (${router.modeReason})` : ""} | SIMULATED accounts`,
);
