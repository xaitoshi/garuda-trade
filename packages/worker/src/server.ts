/**
 * Garuda server: HTTP API and streaming risk worker in ONE process (they share the challenge cache, so a breach the
 * worker catches is what the next API read returns). Environment: see .env.example.
 */
import { AuthService, ChallengeService, InMemoryAuthStore, InMemoryChallengeStore, PgAuthStore, PgChallengeStore, buildApp, type AuthStore, type ChallengeStore } from "@garuda/api";
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
let storage = "memory (state is lost on restart: set DATABASE_URL)";
let closeDb: () => Promise<void> = async () => {};
if (env.DATABASE_URL) {
  const db = await openDb(env.DATABASE_URL);
  store = new PgChallengeStore(db);
  authStore = new PgAuthStore(db);
  closeDb = () => db.close();
  storage = "postgres";
}

const service = new ChallengeService({ market, store, requireWalletForDemo: !authOff });

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
  logger: true,
  builderCodeConfigured: Boolean(env.PHOENIX_BUILDER_CODE),
  auth: authOff ? undefined : new AuthService({ store: authStore, domain: env.GARUDA_AUTH_DOMAIN ?? "garuda" }),
  trustProxy: env.GARUDA_TRUST_PROXY === "1",
  health: () => ({ storage, worker: worker.metrics().running, market: market.name }),
  metrics: () => worker.metrics(),
});

const shutdown = async () => {
  await worker.stop();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port, host: "0.0.0.0" });
console.log(
  `[garuda] listening on :${port} | market ${market.name} | storage ${storage} | auth ${authOff ? "OFF (dev only)" : "wallet sign-in"} | worker ${env.GARUDA_WORKER === "off" ? "off" : `polling every ${env.GARUDA_POLL_MS ?? 1000}ms`} | SIMULATED accounts`,
);
