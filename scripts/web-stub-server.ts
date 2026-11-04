/**
 * Stub Garuda server for the web app and its screenshots: the real API, real risk engine and real purchase flow, but
 * with in-memory fakes where devnet would be (FakeKnights, FakeUsdc) and recorded Phoenix books that drift a little
 * so charts and PnL move. No network, no keys, no money.
 *
 *   pnpm web:stub            serves on :3000 (PORT to change); the web dev server proxies /api to it
 *
 * Extra routes that exist ONLY here (they bypass payment and move the market, so the real server never has them):
 *   POST /dev/stub-pay  { orderId }                       registers a simulated USDC transfer for the quote
 *   POST /dev/seed      { wallet, scenario }              wounded | passed | funded accounts for that wallet
 *   POST /dev/seed      { challengeId, scenario: "history" }  a few closed trades, for a fuller combat log
 */
import { randomBytes } from "node:crypto";
import {
  AuthService,
  ChallengeService,
  InMemoryAuthStore,
  InMemoryChallengeStore,
  PayoutService,
  PaymentRequiredProvider,
  PurchaseService,
  buildApp,
} from "@garuda/api";
import { FakeKnights, FakePayoutExecutor, FakeUsdc } from "@garuda/chain";
import { PollingFeed, ReplayProvider, loadRecordedMarkets } from "@garuda/market-data";
import { RiskWorker } from "@garuda/worker";

const port = Number(process.env.PORT ?? 3000);
/** Stub clock: a wounded seed jumps it forward a day so the revive cooldown has passed (lets the screens revive for real). */
let skewMs = 0;
const market = new ReplayProvider(loadRecordedMarkets());
const knights = new FakeKnights();
const usdc = new FakeUsdc();
const service = new ChallengeService({
  market,
  store: new InMemoryChallengeStore(),
  now: () => Date.now() + skewMs,
  requireWalletForDemo: true,
  knights,
  requirePayment: true,
  payments: new PaymentRequiredProvider(),
});
const purchases = new PurchaseService({ service, usdc });
// Payouts run for real through the service and ledger; only the USDC transfer is a fake (instant, no chain).
const payouts = new PayoutService({ service, executor: new FakePayoutExecutor({ name: "stub-treasury" }) });

const feed = new PollingFeed({ provider: market, intervalMs: 1000 });
const worker = new RiskWorker({ service, feed, onError: (e, ctx) => console.error(`[stub-worker] ${ctx}:`, e instanceof Error ? e.message : e) });
await worker.start();

const app = buildApp({
  service,
  purchases,
  payouts,
  logger: false,
  corsOrigins: process.env.GARUDA_CORS_ORIGIN ? process.env.GARUDA_CORS_ORIGIN.split(",") : undefined,
  auth: new AuthService({ store: new InMemoryAuthStore(), domain: "garuda" }),
  health: () => ({ storage: "memory", worker: worker.metrics().running, market: market.name, chain: "stub" }),
  metrics: () => worker.metrics(),
});

// ------------------------------------------------------------------ a little price motion
const SYMS = ["BTC", "ETH", "SOL"];
const level = new Map(SYMS.map((s) => [s, 0]));
if (process.env.STUB_STATIC !== "1") {
  setInterval(() => {
    for (const s of SYMS) {
      const cur = level.get(s)!;
      const next = cur * 0.96 + (Math.random() - 0.5) * 0.0014; // mean-reverting walk around the recording
      level.set(s, next);
      market.setMove(s, next);
    }
  }, 1500).unref();
}
const setLevel = (s: string, v: number) => {
  level.set(s, v);
  market.setMove(s, v);
};

// ------------------------------------------------------------------ stub-only routes
app.post<{ Body: { orderId?: string } }>("/dev/stub-pay", async (req, reply) => {
  const order = await purchases.get(String(req.body?.orderId ?? ""));
  const signature = randomBytes(64).toString("hex").slice(0, 88);
  usdc.addPayment({ signature, wallet: order.wallet, reference: order.reference, amountBaseUnits: BigInt(order.amountBaseUnits), at: Date.now() });
  return reply.send({ signature });
});

const paid = () => ({ orderId: `seed-${randomBytes(6).toString("hex")}`, ref: `seed-${randomBytes(4).toString("hex")}` });
const notional = async (symbol: string, usd: number) => Number((usd / (await market.snapshot(symbol)).markPrice).toFixed(3));

async function openLong(id: string, usd: number) {
  const r = await service.placeOrder(id, { symbol: "SOL", side: "buy", size: await notional("SOL", usd), type: "market" });
  if (!r.accepted) throw new Error(`seed order rejected: ${r.reason}`);
}

app.post<{ Body: { wallet?: string; challengeId?: string; scenario?: string } }>("/dev/seed", async (req, reply) => {
  const { wallet, challengeId, scenario } = req.body ?? {};
  if (scenario === "history" && challengeId) {
    const trade = async (symbol: string, usd: number, move: number, side: "buy" | "sell") => {
      const size = await notional(symbol, usd);
      await service.placeOrder(challengeId, { symbol, side, size, type: "market" });
      setLevel(symbol, level.get(symbol)! + move);
      await service.tick(challengeId);
      await service.placeOrder(challengeId, { symbol, side: side === "buy" ? "sell" : "buy", size, type: "market", reduceOnly: true });
    };
    await trade("SOL", 2600, 0.012, "buy");
    await trade("ETH", 2000, 0.006, "buy");
    await trade("BTC", 1800, -0.004, "sell");
    for (const s of SYMS) setLevel(s, 0);
    return reply.send({ ok: true });
  }
  if (!wallet) return reply.code(400).send({ error: "wallet required" });
  if (scenario === "wounded") {
    const c = await service.create({ tier: "squire", wallet, knight: "Sir Pudding" }, { paid: paid() });
    await openLong(c.id, 9000);
    setLevel("SOL", -0.1);
    const st = await service.tick(c.id);
    setLevel("SOL", 0);
    skewMs += 25 * 3_600_000; // revive has a 24h cooldown after the breach
    return reply.send({ id: c.id, status: st.status });
  }
  if (scenario === "passed" || scenario === "funded") {
    const c = await service.create({ tier: "knight", wallet, knight: "Lady Ember" }, { paid: paid() });
    await openLong(c.id, 24000);
    setLevel("SOL", 0.15);
    const st = await service.tick(c.id);
    setLevel("SOL", 0);
    return reply.send({ id: c.id, status: st.status });
  }
  return reply.code(400).send({ error: "unknown scenario" });
});

await app.listen({ port, host: "0.0.0.0" });
console.log(`[garuda-stub] http://localhost:${port}  (fake knights + fake USDC, recorded Phoenix books)`);
