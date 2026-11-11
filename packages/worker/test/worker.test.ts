import { describe, expect, it } from "vitest";
import { buildApp } from "@garuda/api";
import { ManualFeed, PollingFeed } from "@garuda/market-data";
import { RiskWorker } from "../src/index.js";
import { DAY, fakeTimers, makeRig } from "./rig.js";

const W = "WalletA1111111111111111111111111111111111111";

const setup = async (opts: { staleAfterMs?: number } = {}) => {
  const rig = makeRig();
  const feed = new ManualFeed(() => rig.clock.t);
  const ft = fakeTimers();
  const errors: unknown[] = [];
  const worker = new RiskWorker({ service: rig.svc, feed, now: () => rig.clock.t, timers: ft.timers, onError: (e, ctx) => errors.push([ctx, e]), ...opts });
  await worker.start();
  return { ...rig, feed, worker, ft, errors };
};

describe("RiskWorker: breaches between ticks", () => {
  it("catches a dip that has fully recovered by the next poll, which tick-only monitoring misses", async () => {
    const s = await setup();
    const streamed = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(streamed.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });

    // The market gaps down 8% for one update and snaps back before anyone polls.
    s.market.setMove("SOL", -0.08);
    const dip = await s.market.snapshot("SOL");
    s.market.setMove("SOL", 0);

    // Streaming worker sees the dip as it happens: it processes the update for every challenge with exposure.
    await s.feed.push(dip);
    expect((await s.svc.getState(streamed.id, { refresh: false })).status).toBe("wounded");
    expect(s.worker.metrics().breachesCaught).toBeGreaterThanOrEqual(1);
    // Control: an identical account on a service that only polls, and polls after the recovery.
    const solo = makeRig();
    const c = await solo.svc.create({ tier: "knight", wallet: W });
    await solo.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });
    const polled = await solo.svc.tick(c.id); // poll after the recovery
    expect(polled.status).toBe("active"); // the breach was invisible to tick-only monitoring
  });

  it("breached accounts leave the symbol index, so the feed stops watching them", async () => {
    const s = await setup();
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });
    expect(s.feed.watched()).toEqual(["SOL"]);
    s.market.setMove("SOL", -0.1);
    await s.feed.push(await s.market.snapshot("SOL"));
    expect(s.feed.watched()).toEqual([]);
  });

  it("applies resting limit fills (with the leverage re-check) from the stream", async () => {
    const s = await setup();
    const c = await s.svc.create({ tier: "knight", wallet: W });
    const mark = (await s.market.snapshot("SOL")).markPrice;
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: +(mark * 0.99).toFixed(2) });
    expect(s.feed.watched()).toEqual(["SOL"]); // a resting order alone puts the symbol on the watch list
    s.market.setMove("SOL", -0.02);
    await s.feed.push(await s.market.snapshot("SOL"));
    const st = await s.svc.getState(c.id, { refresh: false });
    expect(st.positions[0]).toMatchObject({ size: 100 });
    expect(s.worker.metrics().restingFills).toBe(1);
  });
});

describe("RiskWorker: replay with zero missed breaches", () => {
  it("detects each breach on exactly the update an independent equity oracle says it happens", async () => {
    const { mulberry32 } = await import("./rig.js");
    const s = await setup();
    const rand = mulberry32(20261104);
    const cases = [
      { side: "buy" as const, size: 400 },
      { side: "sell" as const, size: 400 },
      { side: "buy" as const, size: 160 },
      { side: "sell" as const, size: 160 },
      { side: "buy" as const, size: 48 },
      { side: "sell" as const, size: 48 },
      { side: "buy" as const, size: 800 },
    ];
    const accounts = [] as { id: string; signed: number; entry: number; balance0: number }[];
    for (const c of cases) {
      const ch = await s.svc.create({ tier: "knight", wallet: W });
      const r = await s.svc.placeOrder(ch.id, { symbol: "SOL", side: c.side, size: c.size, type: "market" });
      expect(r.accepted).toBe(true);
      const p = r.state.positions[0]!;
      accounts.push({ id: ch.id, signed: c.side === "buy" ? c.size : -c.size, entry: p.entryPrice, balance0: r.state.account.balance });
    }
    const base = (await s.market.snapshot("SOL")).book;
    const mid0 = (base.bids[0]![0] + base.asks[0]![0]) / 2;

    // Seeded random walk, 600 updates, about 0.25% per step.
    const mids: number[] = [];
    const detectedAt = new Map<string, number>();
    let level = 0;
    for (let step = 0; step < 600; step++) {
      level += (rand() - 0.5) * 0.0087;
      s.market.setMove("SOL", level);
      const snap = await s.market.snapshot("SOL");
      mids.push((snap.book.bids[0]![0] + snap.book.asks[0]![0]) / 2);
      s.clock.t += 1000;
      const results = await s.worker.handle(snap);
      for (const r of results) if (r.status === "wounded" && !detectedAt.has(r.challengeId)) detectedAt.set(r.challengeId, step);
    }

    const floor = 10_000 - 600; // static max drawdown floor; the daily floor (9,700) is higher and binds first
    const dailyFloor = 9_700;
    let breachedCount = 0;
    for (const a of accounts) {
      const eq = mids.map((m) => a.balance0 + a.signed * (m - a.entry));
      const hi = Math.max(floor, dailyFloor);
      const surely = eq.findIndex((e) => e < hi - 0.5); // clearly through the floor
      const maybe = eq.findIndex((e) => e <= hi + 0.5); // touching it
      const got = detectedAt.get(a.id);
      if (surely === -1 && maybe === -1) {
        expect(got, `account ${a.id} should have survived`).toBeUndefined();
      } else {
        breachedCount++;
        expect(got, `account ${a.id} breached at step ${surely} but was never caught`).toBeDefined();
        expect(got!).toBeGreaterThanOrEqual(maybe);
        expect(got!).toBeLessThanOrEqual(surely === -1 ? maybe : surely);
      }
    }
    // the scenario must actually exercise both outcomes
    expect(breachedCount).toBeGreaterThan(0);
    expect(breachedCount).toBeLessThan(accounts.length);
    expect(s.worker.metrics().breachesCaught).toBe(breachedCount);
    expect(s.errors).toEqual([]);
  });
});

describe("RiskWorker: stale feed kill switch", () => {
  it("halts new exposure when a watched symbol goes quiet, still allows closing, and recovers on the next update", async () => {
    const s = await setup({ staleAfterMs: 10_000 });
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    expect(s.worker.checkStale()).toEqual([]); // starts the clock
    s.clock.t += 9_000;
    expect(s.worker.checkStale()).toEqual([]);
    s.clock.t += 2_000;
    expect(s.worker.checkStale()).toEqual(["SOL"]);
    expect(s.svc.haltedFeeds()).toEqual(["SOL"]);
    expect(s.worker.metrics().haltedSymbols).toEqual(["SOL"]);
    const open = await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect(open).toMatchObject({ accepted: false, reason: "feed_halted" });
    expect((await s.svc.placeOrder(c.id, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true })).accepted).toBe(true);
  });

  it("an update lifts the halt", async () => {
    const s = await setup({ staleAfterMs: 5_000 });
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    s.worker.checkStale();
    s.clock.t += 6_000;
    s.worker.checkStale();
    expect(s.svc.haltedFeeds()).toEqual(["SOL"]);
    await s.feed.push(await s.market.snapshot("SOL"));
    expect(s.svc.haltedFeeds()).toEqual([]);
    expect((await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" })).accepted).toBe(true);
  });

  it("the halt is dropped when no account has exposure in the symbol any more", async () => {
    const s = await setup({ staleAfterMs: 1_000 });
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    s.worker.checkStale();
    s.clock.t += 2_000;
    s.worker.checkStale();
    expect(s.svc.haltedFeeds()).toEqual(["SOL"]);
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true });
    s.worker.checkStale();
    expect(s.svc.haltedFeeds()).toEqual([]);
  });

  it("the stale timer runs the check", async () => {
    const s = await setup({ staleAfterMs: 1_000 });
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    const [staleTimer] = [...s.ft.fns.values()];
    staleTimer!();
    s.clock.t += 2_000;
    staleTimer!();
    expect(s.svc.haltedFeeds()).toEqual(["SOL"]);
  });
});

describe("RiskWorker: metrics and resilience", () => {
  it("reports update counts and latency percentiles from snapshot time to persisted evaluation", async () => {
    const s = await setup();
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    for (const lag of [5, 5, 5, 5, 5, 5, 5, 5, 5, 400]) {
      const snap = await s.market.snapshot("SOL");
      await s.worker.handle({ ...snap, fetchedAt: s.clock.t - lag });
      s.clock.t += 1; // book timestamps stay monotonic
    }
    const m = s.worker.metrics();
    expect(m.updates).toBe(10);
    expect(m.latencyMs.samples).toBe(10);
    expect(m.latencyMs.p50).toBeLessThan(20);
    expect(m.latencyMs.p99).toBeGreaterThanOrEqual(400);
    expect(m.latencyMs.max).toBeGreaterThanOrEqual(400);
    expect(m.liveChallenges).toBe(1);
    expect(m.watchedSymbols).toEqual(["SOL"]);
    expect(m.ageMs.SOL).toBeDefined();
    expect(m.running).toBe(true);
  });

  it("an error in one update is counted and reported but the worker keeps going", async () => {
    const s = await setup();
    const c = await s.svc.create({ tier: "knight", wallet: W });
    await s.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    const original = s.svc.onMarketUpdate.bind(s.svc);
    let first = true;
    s.svc.onMarketUpdate = async (snap) => {
      if (first) {
        first = false;
        throw new Error("db down");
      }
      return original(snap);
    };
    await s.feed.push(await s.market.snapshot("SOL"));
    await s.feed.push(await s.market.snapshot("SOL"));
    const m = s.worker.metrics();
    expect(m.errors).toBe(1);
    expect(m.updates).toBe(1);
    expect(s.errors).toHaveLength(1);
  });

  it("loads live challenges from the store on start", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    const fresh = new (rig.svc.constructor as new (d: object) => typeof rig.svc)({ market: rig.market, now: () => rig.clock.t, store: rig.svc.store, enforceGating: false });
    expect(fresh.activeSymbols()).toEqual([]);
    const w = new RiskWorker({ service: fresh, feed: new ManualFeed(), now: () => rig.clock.t, timers: fakeTimers().timers });
    await w.start();
    expect(fresh.activeSymbols()).toEqual(["SOL"]);
    await w.stop();
    expect(w.metrics().running).toBe(false);
  });

  it("stop() clears its timers and stops the feed", async () => {
    const s = await setup();
    expect(s.ft.fns.size).toBe(2);
    await s.worker.stop();
    expect(s.ft.fns.size).toBe(0);
    expect(s.feed.health().running).toBe(false);
  });

  it("is served at GET /metrics", async () => {
    const s = await setup();
    const app = buildApp({ service: s.svc, rateLimits: false, metrics: () => s.worker.metrics() });
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ running: true, feed: "manual", updates: 0 });
  });
});

describe("RiskWorker: dormancy sweep", () => {
  it("runs the lifecycle sweep on its timer and on start", async () => {
    const s = await setup();
    const f = await s.svc.create({ tier: "knight", stage: "funded", wallet: W });
    s.clock.t += 91 * DAY;
    const lifecycleTimer = [...s.ft.fns.values()][1]!;
    lifecycleTimer();
    await new Promise((r) => setTimeout(r, 20));
    expect((await s.svc.getState(f.id, { refresh: false })).lifecycle).toBe("dormant");
    expect(s.worker.metrics().lifecycleSweeps).toBeGreaterThanOrEqual(2);
    const changes = await s.worker.sweepLifecycle();
    expect(changes).toEqual([]);
  });
});

describe("RiskWorker with PollingFeed (end to end)", () => {
  it("polls Phoenix marks and catches a breach with no API request", async () => {
    const rig = makeRig();
    const ft = fakeTimers();
    const feed = new PollingFeed({ provider: rig.market, intervalMs: 500, timers: ft.timers, now: () => rig.clock.t });
    const worker = new RiskWorker({ service: rig.svc, feed, now: () => rig.clock.t, timers: ft.timers });
    await worker.start();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });
    await feed.pollOnce();
    expect((await rig.svc.getState(c.id, { refresh: false })).status).toBe("active");
    rig.market.setMove("SOL", -0.1);
    rig.clock.t += 500;
    await feed.pollOnce();
    expect((await rig.svc.getState(c.id, { refresh: false })).status).toBe("wounded");
    expect(worker.metrics().breachesCaught).toBe(1);
    await worker.stop();
  });
});
