/**
 * Record real Phoenix books/marks/funding to packages/market-data/fixtures/phoenix-books.json.
 * Used for deterministic tests and as the offline fallback for the demo.
 * Usage: pnpm fixtures:record
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PhoenixSdkProvider, type RecordedMarket } from "@garuda/market-data";

const SYMBOLS = ["SOL", "BTC", "ETH", "HYPE", "SPY", "NVDA", "GOLD"];
const out = fileURLToPath(new URL("../packages/market-data/fixtures/phoenix-books.json", import.meta.url));

const p = new PhoenixSdkProvider({ maxLevels: 60 });
const rows: RecordedMarket[] = [];
for (const symbol of SYMBOLS) {
  const s = await p.snapshot(symbol);
  rows.push({
    symbol,
    recordedAt: new Date(s.fetchedAt).toISOString(),
    slot: s.slot,
    markPrice: s.markPrice,
    fundingRateHourly: s.fundingRateHourly,
    bids: s.book.bids.map(([a, b]) => [a, b]),
    asks: s.book.asks.map(([a, b]) => [a, b]),
  });
  console.log(`recorded ${symbol}: mark ${s.markPrice}, ${s.book.bids.length}x${s.book.asks.length} levels`);
}
mkdirSync(fileURLToPath(new URL("../packages/market-data/fixtures", import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
await p.close();
console.log("wrote", out);
