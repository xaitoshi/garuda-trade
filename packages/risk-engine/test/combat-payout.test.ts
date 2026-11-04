import { describe, expect, it } from "vitest";
import { fillToCombat, fillsToCombat, quotePayout, riskEventToCombat, usd, type FillLike } from "../src/index.js";

const ctx = { knight: "Sir Pudding", startingBalance: 25_000 };
const closeFill = (over: Partial<FillLike> = {}): FillLike => ({
  ts: 1,
  symbol: "SOL",
  side: "sell",
  price: 100,
  size: 10,
  fee: 0,
  realizedPnl: 312,
  closedSize: 10,
  closedDirection: "long",
  ...over,
});

describe("combat log", () => {
  it("formats profitable closes as strikes with the net amount", () => {
    const e = fillToCombat(ctx, closeFill());
    expect(e.kind).toBe("strike");
    expect(e.text).toBe("Sir Pudding strikes for +$312 (SOL long closed)");
    expect(e.amount).toBe(312);
  });

  it("nets fees and scales intensity with size of the blow", () => {
    expect(fillToCombat(ctx, closeFill({ realizedPnl: 5, fee: 1 })).text).toContain("pokes for +$4.00");
    expect(fillToCombat(ctx, closeFill({ realizedPnl: 1800, fee: 100 })).text).toContain("unleashes a mighty blow for +$1,700");
    expect(fillToCombat(ctx, closeFill({ realizedPnl: 600 })).text).toContain("lands a heavy blow");
  });

  it("formats losses as scorches", () => {
    const e = fillToCombat(ctx, closeFill({ realizedPnl: -120, fee: 4, closedDirection: "short", side: "buy" }));
    expect(e.kind).toBe("scorch");
    expect(e.text).toBe("Sir Pudding is scorched for -$124 (SOL short closed)");
  });

  it("opening fills are advances", () => {
    const e = fillToCombat(ctx, closeFill({ closedSize: 0, closedDirection: undefined, side: "buy", realizedPnl: 0, fee: 3.5, price: 92.88 }));
    expect(e.kind).toBe("advance");
    expect(e.text).toBe("Sir Pudding charges long: 10 SOL @ 92.88 (fee $3.50)");
  });

  it("aggregates a multi-level order into one line, and a flip into a close line plus an open line", () => {
    const lv = (price: number, size: number, extra: Partial<FillLike> = {}): FillLike =>
      closeFill({ orderId: "o1", price, size, closedSize: size, realizedPnl: size * 10, fee: 1, ...extra });
    const one = fillsToCombat(ctx, [lv(100, 5), lv(101, 5)]);
    expect(one).toHaveLength(1);
    expect(one[0]!.text).toBe("Sir Pudding strikes for +$98 (SOL long closed)"); // (50+50) - 2 fees
    const flip = fillsToCombat(ctx, [lv(100, 8, { closedSize: 5, realizedPnl: 50, fee: 2 })]);
    expect(flip.map((e) => e.kind)).toEqual(["strike", "advance"]);
    expect(flip[1]!.text).toContain("3 SOL");
    // separate orders stay separate
    expect(fillsToCombat(ctx, [lv(100, 1), lv(100, 1, { orderId: "o2" })])).toHaveLength(2);
  });

  it("formats risk events", () => {
    const w = riskEventToCombat(ctx, { type: "warning", ts: 1, rule: "daily_loss", level: 0.8, usedPct: 0.8, equity: 24_400, floor: 24_250, remaining: 150 });
    expect(w.text).toContain("HP is at 20%");
    expect(w.text).toContain("$150 left");
    expect(riskEventToCombat(ctx, { type: "breach", ts: 1, rule: "max_drawdown", equity: 23_490, floor: 23_500, dailyFloor: 1, drawdownFloor: 23_500 }).text).toContain("falls, Wounded");
    expect(riskEventToCombat(ctx, { type: "pass", ts: 1, equity: 27_510, targetEquity: 27_500 }).text).toContain("slays the boss");
    expect(riskEventToCombat(ctx, { type: "day_reset", ts: 1, dayKey: "x", startOfDayBalance: 25_000, dailyLossLimit: 750, dailyFloor: 24_250 }).kind).toBe("dawn");
  });

  it("usd() helper", () => {
    expect(usd(-5)).toBe("-$5.00");
    expect(usd(1234.5, { sign: true })).toBe("+$1,235");
  });
});

describe("payout quote", () => {
  it("rulebook example: $25,000 -> $28,000 pays $2,400, resets to $25,000", () => {
    const q = quotePayout({ startingBalance: 25_000, balance: 28_000 });
    expect(q).toMatchObject({ grossProfit: 3000, traderShare: 2400, firmShare: 600, eligible: true, newBalance: 25_000 });
  });
  it("enforces $20 minimum, profit and flat book", () => {
    expect(quotePayout({ startingBalance: 25_000, balance: 25_020 })).toMatchObject({ eligible: false, reason: "below_minimum" });
    expect(quotePayout({ startingBalance: 25_000, balance: 25_025 }).eligible).toBe(true); // 80% = $20.00
    expect(quotePayout({ startingBalance: 25_000, balance: 24_000 })).toMatchObject({ eligible: false, reason: "no_profit" });
    expect(quotePayout({ startingBalance: 25_000, balance: 28_000, hasOpenPositions: true })).toMatchObject({ eligible: false, reason: "open_positions" });
  });
});
