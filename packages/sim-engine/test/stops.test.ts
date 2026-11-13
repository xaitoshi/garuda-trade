import { describe, expect, it } from "vitest";
import { SimAccount, SimEngine, type L2Book } from "../src/index.js";
import { solBook } from "./helpers.js";

const T0 = 1_700_000_000_000;
const mk = () => ({ acct: new SimAccount({ id: "a", startingBalance: 100_000 }), eng: new SimEngine() });
/** solBook shifted so its mid is `mid` (spread 0.10). */
const bookAt = (mid: number, ts = T0): L2Book => {
  const b = solBook(ts);
  const d = mid - 100;
  return { ...b, bids: b.bids.map(([p, q]) => [p + d, q] as const), asks: b.asks.map(([p, q]) => [p + d, q] as const) };
};

describe("stop-market orders", () => {
  it("rests until the mark reaches the trigger, then fills as a market order", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 10, type: "stop", triggerPrice: 102 }, bookAt(100), T0);
    expect(r.order.status).toBe("open");
    expect(r.fills).toHaveLength(0);
    expect(eng.onBook(acct, bookAt(101, T0 + 1), T0 + 1)).toHaveLength(0);
    const fills = eng.onBook(acct, bookAt(102.5, T0 + 2), T0 + 2);
    expect(fills.reduce((n, f) => n + f.size, 0)).toBeCloseTo(10, 8);
    expect(fills[0]!.liquidity).toBe("taker");
    expect(acct.positionSize("SOL")).toBeCloseTo(10, 8);
    expect(acct.orders.get(r.order.id)!.status).toBe("filled");
  });

  it("a stop that would trigger at once is refused", () => {
    const { acct, eng } = mk();
    const r = eng.submit(acct, { symbol: "SOL", side: "sell", size: 1, type: "stop", triggerPrice: 101 }, bookAt(100), T0);
    expect(r.order.status).toBe("rejected");
    expect(r.order.rejectReason).toBe("stop_would_trigger");
  });

  it("a reduce-only stop-loss closes the position when the price falls through it", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 20, type: "market" }, bookAt(100), T0);
    eng.submit(acct, { symbol: "SOL", side: "sell", size: 20, type: "stop", triggerPrice: 97, reduceOnly: true }, bookAt(100, T0 + 1), T0 + 1);
    eng.onBook(acct, bookAt(98, T0 + 2), T0 + 2);
    expect(acct.positionSize("SOL")).toBeCloseTo(20, 8);
    eng.onBook(acct, bookAt(96.9, T0 + 3), T0 + 3);
    expect(acct.positionSize("SOL")).toBeCloseTo(0, 8);
  });

  it("TP and SL act as a pair: when one closes the position the other is cancelled", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 10, type: "market" }, bookAt(100), T0);
    const tp = eng.submit(acct, { symbol: "SOL", side: "sell", size: 10, type: "limit", limitPrice: 103, reduceOnly: true }, bookAt(100, T0 + 1), T0 + 1);
    const sl = eng.submit(acct, { symbol: "SOL", side: "sell", size: 10, type: "stop", triggerPrice: 97, reduceOnly: true }, bookAt(100, T0 + 1), T0 + 1);
    eng.onBook(acct, bookAt(103.2, T0 + 2), T0 + 2); // TP fills
    expect(acct.orders.get(tp.order.id)!.status).toBe("filled");
    eng.onBook(acct, bookAt(103.2, T0 + 3), T0 + 3); // flat book: the SL goes
    expect(acct.orders.get(sl.order.id)!.status).toBe("cancelled");
    expect(acct.openOrders("SOL")).toHaveLength(0);
  });
});
