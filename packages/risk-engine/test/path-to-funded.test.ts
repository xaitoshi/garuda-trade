import { describe, expect, it } from "vitest";
import { COMMON_RULES, TIERS, bestDayCheck, dailyLedger, fillOpensOrCloses, fundedProgress, limitsForTier, type LedgerFill } from "../src/index.js";

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 10, 4, 9, 0, 0);
const fill = (ts: number, side: "buy" | "sell", size: number, positionAfter: number, realizedPnl = 0, fee = 0): LedgerFill => ({ ts, side, size, positionAfter, realizedPnl, fee });
/** A round trip on `day` (open then close) netting `pnl`. */
const roundTrip = (day: number, pnl: number): LedgerFill[] => [fill(D1 + day * DAY, "buy", 10, 10), fill(D1 + day * DAY + 1000, "sell", 10, 0, pnl, 0)];

describe("Path to Funded constants (rulebook section 9)", () => {
  it("one step: 10% target, 3% daily, 6% static, 80% split, $20 minimum, 3 trading days, 50% best day", () => {
    expect(COMMON_RULES).toMatchObject({ profitTargetPct: 0.1, dailyLossPct: 0.03, maxDrawdownPct: 0.06, profitSplit: 0.8, minPayoutUsd: 20, minTradingDays: 3, bestDayMaxShare: 0.5 });
    expect(limitsForTier("knight")).toMatchObject({ minTradingDays: 3, bestDayMaxShare: 0.5, profitTargetPct: 0.1 });
    expect(limitsForTier("knight", "funded").profitTargetPct).toBeNull();
  });
  it("tiers: Squire $5K/$39, Knight $10K/$79, Paladin $15K/$119, Ascended $25K/$200", () => {
    expect([TIERS.squire, TIERS.knight, TIERS.paladin, TIERS.ascended].map((t) => [t.accountSize, t.fee])).toEqual([
      [5_000, 39],
      [10_000, 79],
      [15_000, 119],
      [25_000, 200],
    ]);
  });
});

describe("rule 3: trading days", () => {
  it("a day counts when a position is opened or closed (flips count); adding or trimming alone does not", () => {
    expect(fillOpensOrCloses(fill(D1, "buy", 1, 1))).toBe(true); // open
    expect(fillOpensOrCloses(fill(D1, "buy", 1, 2))).toBe(false); // add
    expect(fillOpensOrCloses(fill(D1, "sell", 1, 1))).toBe(false); // trim (2 -> 1)
    expect(fillOpensOrCloses(fill(D1, "sell", 1, 0))).toBe(true); // close
    expect(fillOpensOrCloses(fill(D1, "sell", 3, -2))).toBe(true); // flip long 1 -> short 2
  });
  it("counts distinct UTC days, non-consecutive is fine", () => {
    const l = dailyLedger([...roundTrip(0, 100), ...roundTrip(0, 50), ...roundTrip(4, 100), ...roundTrip(9, 100)]);
    expect(l.tradingDays).toEqual(["2026-11-04", "2026-11-08", "2026-11-13"]);
  });
  it("a day with only an add (no open or close) is not a trading day", () => {
    const l = dailyLedger([fill(D1, "buy", 1, 1), fill(D1 + DAY, "buy", 1, 2), fill(D1 + 2 * DAY, "sell", 2, 0, 10)]);
    expect(l.tradingDays).toEqual(["2026-11-04", "2026-11-06"]);
  });
  it("day P&L is fills net of fees minus funding paid, and `since` starts a new cycle", () => {
    const fills = [fill(D1, "buy", 1, 1, 0, 1), fill(D1 + 1000, "sell", 1, 0, 101, 1), ...roundTrip(1, 40)];
    const l = dailyLedger(fills, [{ ts: D1 + 500, amount: 9 }]);
    expect(l.dayPnl["2026-11-04"]).toBeCloseTo(90, 8);
    expect(dailyLedger(fills, [], D1 + 2000).dayPnl).toEqual({ "2026-11-05": 40 });
  });
});

describe("rule 4: best-day rule", () => {
  it("best day <= 50% of the profitable days' total; losing days are ignored", () => {
    expect(bestDayCheck({ a: 500, b: 300, c: 200 })).toMatchObject({ bestDay: 500, profitableTotal: 1000, share: 0.5, ok: true });
    expect(bestDayCheck({ a: 600, b: 300, c: 100 })).toMatchObject({ share: 0.6, ok: false });
    // a losing day neither helps nor hurts
    expect(bestDayCheck({ a: 500, b: 500, c: -900 })).toMatchObject({ profitableTotal: 1000, share: 0.5, ok: true });
  });
  it("a single profitable day is 100% of the total and fails; no profit at all also fails", () => {
    expect(bestDayCheck({ a: 1000 }).ok).toBe(false);
    expect(bestDayCheck({}).share).toBeNull();
    expect(bestDayCheck({ a: -5 }).ok).toBe(false);
  });
});

describe("fundedProgress: all four rules together", () => {
  const base = { startingBalance: 10_000, openPositions: 0 };
  const three = dailyLedger([...roundTrip(0, 340), ...roundTrip(1, 330), ...roundTrip(2, 335)]);
  it("eligible only when target (closed), flat, 3 days and best day all hold", () => {
    expect(fundedProgress({ ...base, balance: 11_005, ledger: three })).toMatchObject({ targetMet: true, flat: true, tradingDays: 3, daysMet: true, eligible: true, targetBalance: 11_000 });
  });
  it("rule 1 fails below the closed target", () => {
    expect(fundedProgress({ ...base, balance: 10_999, ledger: three })).toMatchObject({ targetMet: false, eligible: false });
  });
  it("rule 2 fails with an open position", () => {
    expect(fundedProgress({ ...base, balance: 11_005, openPositions: 1, ledger: three })).toMatchObject({ flat: false, eligible: false });
  });
  it("rule 3 fails with two trading days, even with the target hit", () => {
    const two = dailyLedger([...roundTrip(0, 500), ...roundTrip(1, 505)]);
    expect(fundedProgress({ ...base, balance: 11_005, ledger: two })).toMatchObject({ tradingDays: 2, daysMet: false, eligible: false });
  });
  it("rule 4 fails when one lucky day carries the profit", () => {
    const lucky = dailyLedger([...roundTrip(0, 900), ...roundTrip(1, 50), ...roundTrip(2, 55)]);
    const p = fundedProgress({ ...base, balance: 11_005, ledger: lucky });
    expect(p.bestDay.ok).toBe(false);
    expect(p.bestDay.share).toBeCloseTo(900 / 1005, 8);
    expect(p.eligible).toBe(false);
  });
});
