import { PhoenixSdkProvider, ReplayProvider, loadRecordedMarkets, type MarketDataProvider } from "@garuda/market-data";
import { buildApp } from "./app.js";
import { ChallengeService } from "./service.js";

const port = Number(process.env.PORT ?? 3000);

let market: MarketDataProvider = new PhoenixSdkProvider();
if (!(await market.ping())) {
  console.warn("[garuda-api] Phoenix unreachable, falling back to RECORDED books (replay). Prices will not move.");
  market = new ReplayProvider(loadRecordedMarkets());
}

const service = new ChallengeService({ market });
const app = buildApp({ service, logger: true });
await app.listen({ port, host: "0.0.0.0" });
console.log(`[garuda-api] listening on :${port} (market data: ${market.name}, SIMULATED accounts)`);
