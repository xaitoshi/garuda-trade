import { describe, expect, it } from "vitest";
import { ManualFeed, PollingFeed, ReplayProvider, loadRecordedMarkets, type MarketSnapshot } from "../src/index.js";

const fakeTimers = () => {
  const fns: (() => void)[] = [];
  const cleared: unknown[] = [];
  return {
    fns,
    cleared,
    timers: {
      set: (fn: () => void) => {
        fns.push(fn);
        return fns.length;
      },
      clear: (h: unknown) => void cleared.push(h),
    },
  };
};

describe("PollingFeed", () => {
  it("polls only the symbols asked for, on every cycle, and reports health", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    const got: string[] = [];
    let watch = ["SOL"];
    const ft = fakeTimers();
    const feed = new PollingFeed({ provider: p, intervalMs: 250, timers: ft.timers });
    feed.start({ symbols: () => watch, onSnapshot: (s) => void got.push(s.symbol) });
    expect(feed.health().running).toBe(true);
    await feed.pollOnce();
    watch = ["SOL", "ETH"];
    await feed.pollOnce();
    expect(got).toEqual(["SOL", "SOL", "ETH"]);
    expect(feed.health()).toMatchObject({ delivered: 3, errors: 0 });
    expect(Object.keys(feed.health().lastSeen).sort()).toEqual(["ETH", "SOL"]);
  });

  it("the interval timer drives pollOnce, and stop() clears it", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    const ft = fakeTimers();
    let n = 0;
    const feed = new PollingFeed({ provider: p, timers: ft.timers });
    feed.start({ symbols: () => ["SOL"], onSnapshot: () => void n++ });
    ft.fns[0]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(1);
    feed.stop();
    expect(ft.cleared).toEqual([1]);
    await feed.pollOnce(); // stopped: no-op
    expect(n).toBe(1);
    expect(feed.health().running).toBe(false);
  });

  it("a failing symbol is counted and reported without stopping the others", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    const got: string[] = [];
    const errs: string[] = [];
    const feed = new PollingFeed({ provider: p, timers: fakeTimers().timers });
    feed.start({ symbols: () => ["NOPE", "SOL"], onSnapshot: (s) => void got.push(s.symbol), onError: (s) => void errs.push(s) });
    await feed.pollOnce();
    expect(got).toEqual(["SOL"]);
    expect(errs).toEqual(["NOPE"]);
    expect(feed.health()).toMatchObject({ delivered: 1, errors: 1 });
    expect(feed.health().lastError).toMatch(/no recording/);
  });

  it("a handler that throws is an error, not a crash", async () => {
    const feed = new PollingFeed({ provider: new ReplayProvider(loadRecordedMarkets()), timers: fakeTimers().timers });
    feed.start({
      symbols: () => ["SOL"],
      onSnapshot: () => {
        throw new Error("boom");
      },
    });
    await expect(feed.pollOnce()).resolves.toBeUndefined();
    expect(feed.health().errors).toBe(1);
  });

  it("skips a cycle while the previous one is still in flight", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const feed = new PollingFeed({ provider: p, timers: fakeTimers().timers });
    feed.start({
      symbols: () => ["SOL"],
      onSnapshot: async () => {
        calls++;
        await gate;
      },
    });
    const first = feed.pollOnce();
    await feed.pollOnce(); // overlapping: skipped
    release();
    await first;
    expect(calls).toBe(1);
  });
});

describe("ManualFeed", () => {
  it("delivers pushed snapshots to the consumer and awaits it", async () => {
    const p = new ReplayProvider(loadRecordedMarkets());
    const feed = new ManualFeed();
    const seen: MarketSnapshot[] = [];
    await feed.push(await p.snapshot("SOL")); // not started: dropped
    feed.start({ symbols: () => ["SOL"], onSnapshot: async (s) => void seen.push(s) });
    await feed.push(await p.snapshot("SOL"));
    expect(seen).toHaveLength(1);
    expect(feed.watched()).toEqual(["SOL"]);
    expect(feed.health().delivered).toBe(1);
    feed.stop();
    expect(feed.watched()).toEqual([]);
  });
});
