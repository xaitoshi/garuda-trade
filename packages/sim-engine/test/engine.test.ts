import { describe, expect, it } from "vitest";
import { PHOENIX_FEES, SimAccount, SimEngine } from "../src/index.js";
import { solBook } from "./helpers.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const mk = (bal = 25_000, opts = {}) => ({
  acct: new SimAccount({ id: "t", startingBalance: bal }),
  eng: new SimEngine(opts),
});

describe("fee schedule", () => {
  it("defaults to Phoenix 0.035% taker / 0.005% maker", () => {
    expect(PHOENIX_FEES.takerFeeRate).toBeCloseTo(0.00035, 10);
    expect(PHOENIX_FEES.makerFeeRate).toBeCloseTo(0.00005, 10);
  });
});

describe("market orders walk the L2 book", () => {
  it("buy across two ask levels: per-level fills, VWAP, taker fee, slippage", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 250, type: "market" }, solBook(), T0);
    expect(r.order.status).toBe("filled");
    expect(r.fills.map((f) => [f.price, f.size])).toEqual([
      [100.05, 100],
      [100.1, 150],
    ]);
    expect(r.avgPrice).toBeCloseTo(100.08, 10);
    const notional = 100 * 100.05 + 150 * 100.1; // 25020
    expect(r.fills.reduce((s, f) => s + f.fee, 0)).toBeCloseTo(notional * 0.00035, 8);
    expect(r.fills.every((f) => f.liquidity === "taker")).toBe(true);
    // arrival mid 100.00 -> 8 bps adverse
    expect(r.slippageBps).toBeCloseTo(8, 6);
    expect(acct.positions.get("SOL")).toEqual({ symbol: "SOL", size: 250, entryPrice: 100.08 });
    expect(acct.balance).toBeCloseTo(25_000 - notional * 0.00035, 8);
  });

  it("sell walks the bids from the best price down", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "sell", size: 150, type: "market" }, solBook(), T0);
    expect(r.fills.map((f) => [f.price, f.size])).toEqual([
      [99.95, 100],
      [99.9, 50],
    ]);
    expect(acct.positionSize("SOL")).toBe(-150);
  });

  it("partially fills and drops the remainder when the book is too thin", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 1000, type: "market" }, solBook(), T0);
    expect(r.order.status).toBe("partially_filled");
    expect(r.fills.reduce((s, f) => s + f.size, 0)).toBe(600);
    expect(r.order.remaining).toBe(0);
    expect(acct.openOrders()).toHaveLength(0);
  });

  it("rejects invalid sizes and wrong-symbol books", () => {
    const { acct, eng } = mk();
    expect(eng.submit(acct, { symbol: "SOL", side: "buy", size: 0, type: "market" }, solBook(), T0).order.rejectReason).toBe(
      "invalid_size",
    );
    expect(eng.submit(acct, { symbol: "BTC", side: "buy", size: 1, type: "market" }, solBook(), T0).order.rejectReason).toBe(
      "book_symbol_mismatch",
    );
  });

  it("latency penalty shifts taker fills adversely", () => {
    const { acct, eng } = mk(25_000, { latencyPenaltyBps: 10 });
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 10, type: "market" }, solBook(), T0);
    expect(r.fills[0]!.price).toBeCloseTo(100.05 * 1.001, 8);
  });
});

describe("limit orders", () => {
  it("crossing limit fills immediately as taker up to its limit, remainder rests", () => {
    const { acct, eng } = mk();
    // buy 250 @ 100.10: takes 100@100.05 and 150@100.10 (all within limit) -> fully filled
    const full = eng.submit(acct, { symbol: "SOL", side: "buy", size: 250, type: "limit", limitPrice: 100.1 }, solBook(), T0);
    expect(full.order.status).toBe("filled");
    // buy 400 @ 100.10: only 300 available <= 100.10 (100 + 200), 100 rests
    const { acct: a2, eng: e2 } = mk();
    const r = e2.submit(a2, { symbol: "SOL", side: "buy", size: 400, type: "limit", limitPrice: 100.1 }, solBook(), T0);
    expect(r.fills.reduce((s, f) => s + f.size, 0)).toBe(300);
    expect(r.order.status).toBe("partially_filled");
    expect(r.order.remaining).toBe(100);
    expect(a2.openOrders()).toHaveLength(1);
  });

  it("a non-crossing limit rests, then fills as maker at its limit when the book crosses", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 50, type: "limit", limitPrice: 99.5 }, solBook(), T0);
    expect(r.order.status).toBe("open");
    expect(r.fills).toHaveLength(0);
    // book unchanged: still no fill
    expect(eng.onBook(acct, solBook(), T0 + 1000)).toHaveLength(0);
    // price falls: asks now at/below our limit
    const dropped = {
      ...solBook(),
      asks: [
        [99.4, 30],
        [99.5, 40],
        [99.6, 500],
      ] as [number, number][],
      bids: [[99.3, 100]] as [number, number][],
    };
    const fills = eng.onBook(acct, dropped, T0 + 2000);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.liquidity).toBe("maker");
    expect(fills[0]!.price).toBe(99.5);
    expect(fills[0]!.size).toBe(50);
    expect(fills[0]!.fee).toBeCloseTo(50 * 99.5 * 0.00005, 10);
    expect(acct.orders.get(r.order.id)!.status).toBe("filled");
    expect(acct.positionSize("SOL")).toBe(50);
  });

  it("resting fills are capped by the crossing size available", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "sell", size: 100, type: "limit", limitPrice: 101 }, solBook(), T0);
    const up = { ...solBook(), bids: [[101.2, 40], [101, 20], [100.9, 1000]] as [number, number][], asks: [[101.3, 10]] as [number, number][] };
    const fills = eng.onBook(acct, up, T0 + 1);
    expect(fills[0]!.size).toBe(60);
    const o = [...acct.orders.values()][0]!;
    expect(o.status).toBe("partially_filled");
    expect(o.remaining).toBe(40);
  });

  it("post-only that would cross is rejected", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 1, type: "limit", limitPrice: 100.05, postOnly: true }, solBook(), T0);
    expect(r.order.status).toBe("rejected");
    expect(r.order.rejectReason).toBe("post_only_would_cross");
  });

  it("cancel stops a resting order from filling", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 5, type: "limit", limitPrice: 90 }, solBook(), T0);
    eng.cancel(acct, r.order.id, T0 + 1);
    const crash = { ...solBook(), asks: [[89, 100]] as [number, number][], bids: [[88.9, 10]] as [number, number][] };
    expect(eng.onBook(acct, crash, T0 + 2)).toHaveLength(0);
  });
});

describe("reduce-only", () => {
  it("rejects with no position and clamps to position size", () => {
    const { acct, eng } = mk();
    const none = eng.submit(acct, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true }, solBook(), T0);
    expect(none.order.rejectReason).toBe("reduce_only_no_position");
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 20, type: "market" }, solBook(), T0);
    const r = eng.submit(acct, { symbol: "SOL", side: "sell", size: 500, type: "market", reduceOnly: true }, solBook(), T0 + 1);
    expect(r.fills.reduce((s, f) => s + f.size, 0)).toBe(20);
    expect(acct.positionSize("SOL")).toBe(0);
  });
});

describe("positions, PnL and equity", () => {
  it("long round trip realises (exit - entry) * size, minus both fees", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0); // 100 @ 100.05
    const up = {
      ...solBook(),
      bids: [[103, 1000]] as [number, number][],
      asks: [[103.1, 1000]] as [number, number][],
    };
    const r = eng.submit(acct, { symbol: "SOL", side: "sell", size: 100, type: "market" }, up, T0 + 1000);
    const f = r.fills[0]!;
    expect(f.realizedPnl).toBeCloseTo((103 - 100.05) * 100, 8);
    expect(f.closedDirection).toBe("long");
    expect(f.closedSize).toBe(100);
    const fees = 100 * 100.05 * 0.00035 + 100 * 103 * 0.00035;
    expect(acct.balance).toBeCloseTo(25_000 + 295 - fees, 8);
    expect(acct.positions.size).toBe(0);
    expect(acct.equity()).toBeCloseTo(acct.balance, 10);
  });

  it("short profits when price falls", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "sell", size: 100, type: "market" }, solBook(), T0); // @99.95
    const down = { ...solBook(), bids: [[95, 1000]] as [number, number][], asks: [[95.1, 1000]] as [number, number][] };
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, down, T0 + 1);
    expect(r.fills[0]!.realizedPnl).toBeCloseTo((95.1 - 99.95) * 100 * -1, 8);
    expect(r.fills[0]!.closedDirection).toBe("short");
  });

  it("flipping closes the old side and opens the remainder at the fill price", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 50, type: "market" }, solBook(), T0); // long 50 @100.05
    const r = eng.submit(acct, { symbol: "SOL", side: "sell", size: 80, type: "market" }, solBook(), T0 + 1);
    // 80 sold into bid 99.95: closes 50 long, opens 30 short
    expect(r.fills[0]!.closedSize).toBe(50);
    expect(r.fills[0]!.realizedPnl).toBeCloseTo((99.95 - 100.05) * 50, 8);
    expect(acct.positions.get("SOL")).toEqual({ symbol: "SOL", size: -30, entryPrice: 99.95 });
  });

  it("adding blends the entry price", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0); // 100.05
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, { ...solBook(), asks: [[102, 500]] as [number, number][] }, T0 + 1);
    expect(acct.positions.get("SOL")!.entryPrice).toBeCloseTo(101.025, 8);
  });

  it("equity = balance + unrealised at the latest mark", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0);
    acct.setMark("SOL", 101.05);
    expect(acct.unrealizedPnl()).toBeCloseTo(100, 8);
    expect(acct.equity()).toBeCloseTo(acct.balance + 100, 8);
    acct.setMark("SOL", 99.05);
    expect(acct.unrealizedPnl()).toBeCloseTo(-100, 8);
  });
});

describe("funding", () => {
  it("long pays a positive rate, pro rata over time", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0);
    const before = acct.balance;
    const p = eng.accrueFunding(acct, "SOL", 100, 0.0001, T0 + 2.5 * HOUR)!; // 1bp/h for 2.5h on 10k notional
    expect(p.amount).toBeCloseTo(100 * 100 * 0.0001 * 2.5, 10);
    expect(acct.balance).toBeCloseTo(before - 2.5, 10);
    expect(acct.fundingPaid).toBeCloseTo(2.5, 10);
  });

  it("short receives a positive rate; pays a negative one", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "sell", size: 100, type: "market" }, solBook(), T0);
    const b0 = acct.balance;
    eng.accrueFunding(acct, "SOL", 100, 0.0001, T0 + HOUR);
    expect(acct.balance).toBeCloseTo(b0 + 1, 8);
    const b1 = acct.balance;
    eng.accrueFunding(acct, "SOL", 100, -0.0002, T0 + 2 * HOUR);
    expect(acct.balance).toBeCloseTo(b1 - 2, 8);
  });

  it("does nothing without a position or when time has not advanced", () => {
    const { acct, eng } = mk();
    expect(eng.accrueFunding(acct, "SOL", 100, 0.001, T0)).toBeUndefined();
    expect(eng.accrueFunding(acct, "SOL", 100, 0.001, T0 + HOUR)).toBeUndefined();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 1, type: "market" }, solBook(), T0 + HOUR);
    expect(eng.accrueFunding(acct, "SOL", 100, 0.001, T0 + HOUR)).toBeUndefined();
  });
});

describe("closeAll", () => {
  it("flattens positions, cancels orders, flags fills as forced", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0);
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 10, type: "limit", limitPrice: 90 }, solBook(), T0);
    const fills = eng.closeAll(acct, new Map([["SOL", solBook()]]), T0 + 1);
    expect(fills.every((f) => f.forced)).toBe(true);
    expect(acct.positions.size).toBe(0);
    expect(acct.openOrders()).toHaveLength(0);
  });

  it("closes the remainder at mark minus a haircut when the book is too thin", () => {
    const { acct, eng } = mk(1_000_000);
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 500, type: "market" }, solBook(), T0);
    const thin = { ...solBook(), bids: [[99, 100]] as [number, number][] };
    const fills = eng.closeAll(acct, new Map([["SOL", thin]]), T0 + 1);
    expect(fills).toHaveLength(2);
    expect(fills[1]!.size).toBe(400);
    expect(fills[1]!.price).toBeCloseTo(100 * 0.99, 6); // mark = last mid (100) minus 100 bps
  });
});
