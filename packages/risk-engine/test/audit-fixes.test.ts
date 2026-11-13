import { describe, expect, it } from "vitest";
import { RiskMonitor, limitsForTier } from "../src/index.js";

const D1 = Date.UTC(2026, 10, 4, 9, 0, 0);
const funded = () => new RiskMonitor({ limits: { ...limitsForTier("knight", "funded"), startingBalance: 25_000 }, createdAt: D1 });

describe("a payout sweep keeps today's losses", () => {
  it("moves the daily baseline down by the swept amount, not to the post-payout balance", () => {
    const m = funded(); // start of day 25,000, daily limit 750, floor 24,250
    m.evaluate({ balance: 24_500, equity: 24_500, now: D1 + 1000 }); // lost 500 today
    m.rebaseAfterPayout(24_200, 24_200, D1 + 2000, 300); // 300 swept
    expect(m.state.startOfDayBalance).toBe(24_700);
    // about 241 of room left (the 250 that was left, re-measured at 3% of the lower baseline), not ~726
    expect(24_200 - m.dailyFloor).toBeCloseTo(24_200 - (24_700 - 741), 6);
    expect(m.evaluate({ balance: 23_950, equity: 23_950, now: D1 + 3000 }).map((e) => e.type)).toContain("breach");
  });

  it("a payout reversed the same day puts the baseline back", () => {
    const m = funded();
    m.rebaseAfterPayout(24_200, 24_200, D1 + 2000, 800);
    expect(m.state.startOfDayBalance).toBe(24_200);
    m.restoreAfterReversal(25_000, 25_000, D1 + 3000, 800, D1 + 2000);
    expect(m.state.startOfDayBalance).toBe(25_000);
  });

  it("a payout reversed on a later day leaves that day's baseline alone", () => {
    const m = funded();
    m.rebaseAfterPayout(24_200, 24_200, D1 + 2000, 800);
    const day2 = D1 + 24 * 3_600_000;
    m.evaluate({ balance: 24_200, equity: 24_200, now: day2 });
    expect(m.state.startOfDayBalance).toBe(24_200);
    m.restoreAfterReversal(25_000, 25_000, day2 + 1000, 800, D1 + 2000);
    expect(m.state.startOfDayBalance).toBe(24_200);
  });
});

describe("a payout on a day that is up", () => {
  it("does not leave the paid-out profit as a cushion", () => {
    const m = funded(); // start of day 25,000
    m.evaluate({ balance: 25_400, equity: 25_400, now: D1 + 1000 }); // +400 today
    m.rebaseAfterPayout(25_000, 25_000, D1 + 2000, 400);
    expect(m.state.startOfDayBalance).toBe(25_000); // not 24,600
  });
});

describe("a level-up keeps today's losses", () => {
  it("moves the daily baseline up by the size step only", () => {
    const m = funded(); // start of day 25,000
    m.evaluate({ balance: 24_700, equity: 24_700, now: D1 + 1000 }); // lost 300 today
    m.rescale(30_000, 29_700, 29_700, D1 + 2000); // +5,000 step
    expect(m.state.startOfDayBalance).toBe(30_000);
    // the 300 already lost still counts: 900 limit at the new size, 600 of room
    expect(29_700 - m.dailyFloor).toBeCloseTo(600, 6);
  });
});

describe("the daily floor is whole cents", () => {
  it("rounds like the drawdown floor and the target", () => {
    const m = funded();
    m.evaluate({ balance: 25_000.3367, equity: 25_000.3367, now: D1 + 1000 });
    m.evaluate({ balance: 25_000.3367, equity: 25_000.3367, now: D1 + 24 * 3_600_000 });
    expect(Math.round(m.dailyFloor * 100) / 100).toBe(m.dailyFloor);
  });
});
