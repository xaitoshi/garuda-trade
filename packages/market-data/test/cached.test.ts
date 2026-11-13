import { describe, expect, it } from "vitest";
import { CachedProvider } from "../src/cached.js";
import type { MarketDataProvider, MarketSnapshot } from "../src/types.js";

const snap = (n: number): MarketSnapshot => ({ symbol: "SOL", book: { symbol: "SOL", bids: [[n, 1]], asks: [[n + 1, 1]], ts: n }, markPrice: n, fundingRateHourly: 0, tradable: true, fetchedAt: n, source: "phoenix-live" });

function rig() {
  let t = 0;
  let calls = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const inner: MarketDataProvider = {
    name: "fake",
    snapshot: async () => {
      calls++;
      const n = calls;
      if (hold) await new Promise<void>((ok) => (release = ok));
      return snap(n);
    },
    listMarkets: async () => [],
    candles: async () => {
      calls++;
      return { candles: [], source: "phoenix-live" };
    },
    ping: async () => true,
    close: async () => {},
  };
  const p = new CachedProvider(inner, { now: () => t });
  return { p, tick: (ms: number) => (t += ms), calls: () => calls, hold: (v: boolean) => (hold = v), release: () => release?.() };
}

describe("CachedProvider", () => {
  it("shares one upstream request between concurrent callers and caches it briefly", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.p.snapshot("SOL"), r.p.snapshot("SOL")]);
    expect(a).toBe(b);
    await r.p.snapshot("SOL");
    expect(r.calls()).toBe(1);
    r.tick(1000);
    await r.p.snapshot("SOL");
    expect(r.calls()).toBe(2);
  });

  it("serves the last value while a slow refresh runs, but waits once that value is too old", async () => {
    const r = rig();
    await r.p.snapshot("SOL");
    r.hold(true);
    r.tick(1500);
    const s = await r.p.snapshot("SOL"); // refresh started, last value served at once
    expect(s.markPrice).toBe(1);
    r.tick(5000);
    const late = r.p.snapshot("SOL"); // too old now: joins the refresh
    r.release();
    expect((await late).markPrice).toBe(2);
    expect(r.calls()).toBe(2);
  });

  it("caches candles per key", async () => {
    const r = rig();
    await r.p.candles!("SOL", "1h", 200);
    await r.p.candles!("SOL", "1h", 200);
    await r.p.candles!("SOL", "1h", 500);
    expect(r.calls()).toBe(2);
  });
});
