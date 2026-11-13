import { describe, expect, it } from "vitest";
import { SimAccount, SimEngine } from "../src/index.js";
import { solBook } from "./helpers.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const mk = () => ({ acct: new SimAccount({ id: "a", startingBalance: 100_000 }), eng: new SimEngine() });

describe("funding clock restarts when a position reopens from flat", () => {
  it("does not bill the new position for the hours the book was flat", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 10, type: "market" }, solBook(), T0);
    eng.accrueFunding(acct, "SOL", 100, 0.0001, T0 + HOUR);
    eng.submit(acct, { symbol: "SOL", side: "sell", size: 10, type: "market" }, solBook(), T0 + HOUR);
    // flat for 10 hours, then a bigger position
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0 + 11 * HOUR);
    const p = eng.accrueFunding(acct, "SOL", 100, 0.0001, T0 + 11 * HOUR + 60_000)!;
    // one minute of 1bp/h on 10k notional, not eleven hours
    expect(p.amount).toBeCloseTo(100 * 100 * 0.0001 * (1 / 60), 8);
  });
});

describe("one book snapshot's liquidity is used once per account", () => {
  it("splitting a market order does not refill the top level", () => {
    const { acct, eng } = mk();
    const book = solBook(); // asks: 100 @ 100.05, 200 @ 100.10, 300 @ 100.20
    const a = eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, book, T0);
    const b = eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, book, T0);
    expect(a.fills.map((f) => f.price)).toEqual([100.05]);
    // the second slice starts where the first one stopped
    expect(b.fills[0]!.price).toBeCloseTo(100.1, 8);
  });

  it("a fresh snapshot starts with the full book again", () => {
    const { acct, eng } = mk();
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(), T0);
    const b = eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, solBook(T0 + 1000), T0 + 1000);
    expect(b.fills[0]!.price).toBeCloseTo(100.05, 8);
  });

  it("resting orders on one side share the crossed depth", () => {
    const { acct, eng } = mk();
    // two resting buys at 100.05, each for the whole 100 lots resting at that level
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: 99.0 }, solBook(), T0);
    eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: 99.0 }, solBook(), T0);
    for (const o of acct.openOrders("SOL")) o.limitPrice = 100.05;
    const fills = eng.onBook(acct, solBook(T0 + 1000), T0 + 1000);
    const total = fills.reduce((n, f) => n + f.size, 0);
    expect(total).toBeCloseTo(100, 8);
  });
});
