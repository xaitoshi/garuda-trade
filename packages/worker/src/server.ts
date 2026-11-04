/**
 * Garuda server: HTTP API and streaming risk worker in ONE process (they share the challenge cache, so a breach the
 * worker catches is what the next API read returns). Environment: see .env.example.
 */
import {
  AuthService,
  ChallengeService,
  InMemoryAuthStore,
  InMemoryChallengeStore,
  InMemoryOrderStore,
  PaymentRequiredProvider,
  PgAuthStore,
  PgChallengeStore,
  PgOrderStore,
  PurchaseService,
  buildApp,
  type AuthStore,
  type ChallengeStore,
  type OrderStore,
} from "@garuda/api";
import { DEFAULT_ART_DIR, HttpRpc, MetaplexCoreKnights, SolanaUsdc, assertDevnetCluster, loadKeypairFile } from "@garuda/chain";
import { openDb } from "@garuda/db";
import { PhoenixSdkProvider, PollingFeed, ReplayProvider, loadRecordedMarkets, type MarketDataProvider } from "@garuda/market-data";
import { RiskWorker } from "./worker.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);
const authOff = env.GARUDA_AUTH === "off";

let market: MarketDataProvider = new PhoenixSdkProvider();
if (!(await market.ping())) {
  console.warn("[garuda] Phoenix unreachable, falling back to RECORDED books (replay). Prices will not move.");
  market = new ReplayProvider(loadRecordedMarkets());
}

let store: ChallengeStore = new InMemoryChallengeStore();
let authStore: AuthStore = new InMemoryAuthStore();
let orderStore: OrderStore = new InMemoryOrderStore();
let storage = "memory (state is lost on restart: set DATABASE_URL)";
let closeDb: () => Promise<void> = async () => {};
if (env.DATABASE_URL) {
  const db = await openDb(env.DATABASE_URL);
  store = new PgChallengeStore(db);
  authStore = new PgAuthStore(db);
  orderStore = new PgOrderStore(db);
  closeDb = () => db.close();
  storage = "postgres";
}

// M3/M4: knight NFTs and USDC checkout on Solana DEVNET. Off unless GARUDA_CHAIN=devnet (mainnet is refused by the chain code).
const chainOn = env.GARUDA_CHAIN === "devnet";
let knights: MetaplexCoreKnights | undefined;
let usdc: SolanaUsdc | undefined;
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
}

const service = new ChallengeService({
  market,
  store,
  requireWalletForDemo: !authOff,
  ...(knights ? { knights, requirePayment: true, payments: new PaymentRequiredProvider() } : {}),
});
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
    } catch (e) {
      console.error("[garuda-chain] reconcile failed:", e instanceof Error ? e.message : e);
    }
  };
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
  nft: knights ? { baseUrl: publicUrl, artDir: env.GARUDA_ART_DIR ?? DEFAULT_ART_DIR } : undefined,
  logger: true,
  builderCodeConfigured: Boolean(env.PHOENIX_BUILDER_CODE),
  auth: authOff ? undefined : new AuthService({ store: authStore, domain: env.GARUDA_AUTH_DOMAIN ?? "garuda" }),
  trustProxy: env.GARUDA_TRUST_PROXY === "1",
  health: () => ({
    storage,
    worker: worker.metrics().running,
    market: market.name,
    chain: chainOn ? { cluster: "devnet", collection: knights!.collection, usdcMint: usdc!.mint, treasury: usdc!.treasury, dirtyKnights: service.dirtyKnightIds().length } : "off",
  }),
  metrics: () => worker.metrics(),
});

const shutdown = async () => {
  if (reconciler) clearInterval(reconciler);
  await worker.stop();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port, host: "0.0.0.0" });
console.log(
  `[garuda] listening on :${port} | market ${market.name} | storage ${storage} | auth ${authOff ? "OFF (dev only)" : "wallet sign-in"} | worker ${env.GARUDA_WORKER === "off" ? "off" : `polling every ${env.GARUDA_POLL_MS ?? 1000}ms`} | chain ${chainOn ? "solana DEVNET (knights + USDC)" : "off"} | SIMULATED accounts`,
);
