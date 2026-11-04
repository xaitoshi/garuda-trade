import { describe, expect, it } from "vitest";
import { PhoenixSdkProvider, ReplayProvider, loadRecordedMarkets } from "../src/index.js";

describe("recorded fixtures", () => {
  const rec = loadRecordedMarkets();
  it("contain sane real books", () => {
    expect(rec.map((r) => r.symbol)).toEqual(expect.arrayContaining(["SOL", "BTC", "ETH"]));
    for (const m of rec) {
      expect(m.bids[0]![0]).toBeLessThan(m.asks[0]![0]);
      expect(m.bids.length).toBeGreaterThan(10);
    }
  });
});

describe("ReplayProvider", () => {
  it("shifts books and marks by a fraction", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    const a = await p.snapshot("SOL");
    p.setMove("SOL", 0.01);
    const b = await p.snapshot("SOL");
    expect(b.book.bids[0]![0]).toBeCloseTo(a.book.bids[0]![0] * 1.01, 8);
    expect(b.markPrice).toBeCloseTo(a.markPrice * 1.01, 8);
    expect(b.source).toBe("replay");
    await expect(p.snapshot("NOPE")).rejects.toThrow();
  });
});

describe("PhoenixSdkProvider.tradableState", () => {
  it("maps market and tradfi session status", () => {
    expect(PhoenixSdkProvider.tradableState({ symbol: "SOL", marketStatus: "active" }).tradable).toBe(true);
    expect(PhoenixSdkProvider.tradableState({ symbol: "X", marketStatus: "paused" })).toEqual({ tradable: false, reason: "market_paused" });
    expect(
      PhoenixSdkProvider.tradableState({ symbol: "SPY", marketStatus: "active", commodityMetadata: { status: "active", isAfterHours: true } }),
    ).toEqual({ tradable: false, reason: "after_hours" });
    expect(PhoenixSdkProvider.tradableState(undefined).reason).toBe("unknown_market");
  });
});

// Live smoke test: only when explicitly enabled (needs network). `LIVE=1 pnpm test`
describe.runIf(process.env.LIVE === "1")("PhoenixSdkProvider (live)", () => {
  it("returns a real SOL book, mark and funding", async () => {
    const p = new PhoenixSdkProvider();
    const s = await p.snapshot("SOL-PERP");
    expect(s.source).toBe("phoenix-live");
    expect(s.book.bids[0]![0]).toBeLessThan(s.book.asks[0]![0]);
    expect(s.markPrice).toBeGreaterThan(0);
    expect(Math.abs(s.fundingRateHourly)).toBeLessThan(0.01);
    await p.close();
  });
});
