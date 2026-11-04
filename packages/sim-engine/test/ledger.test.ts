import { describe, expect, it } from "vitest";
import { SimAccount, SimEngine, type L2Book } from "../src/index.js";
import { solBook } from "./helpers.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

const shifted = (k: number, ts = T0): L2Book => {
  const b = solBook(ts);
  return { ...b, bids: b.bids.map(([p, s]) => [p * k, s] as const), asks: b.asks.map(([p, s]) => [p * k, s] as const) };
};

/** A messy but deterministic session: adds, partial closes, a flip, a resting limit that fills later, funding. */
function session() {
  const acct = new SimAccount({ id: "led", startingBalance: 25_000 });
  const eng = new SimEngine();
  eng.submit(acct, { symbol: "SOL", side: "buy", size: 250, type: "market" }, solBook(T0), T0);
  eng.accrueFunding(acct, "SOL", 100, 0.0001, T0 + HOUR);
  eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "market" }, shifted(1.01, T0 + 2 * HOUR), T0 + 2 * HOUR);
  eng.accrueFunding(acct, "SOL", 101, 0.00007, T0 + 3 * HOUR);
  eng.submit(acct, { symbol: "SOL", side: "sell", size: 120, type: "market" }, shifted(1.02, T0 + 3 * HOUR), T0 + 3 * HOUR);
  eng.submit(acct, { symbol: "SOL", side: "sell", size: 500, type: "market" }, shifted(0.99, T0 + 4 * HOUR), T0 + 4 * HOUR); // flips short
  eng.submit(acct, { symbol: "SOL", side: "buy", size: 50, type: "limit", limitPrice: 95 }, shifted(1, T0 + 5 * HOUR), T0 + 5 * HOUR); // rests
  eng.accrueFunding(acct, "SOL", 99, -0.00002, T0 + 5 * HOUR);
  eng.onBook(acct, shifted(0.94, T0 + 6 * HOUR), T0 + 6 * HOUR); // fills the resting buy as maker
  acct.setMark("SOL", 94);
  return acct;
}

describe("SimAccount.restore (ledger replay)", () => {
  it("rebuilds balance, fees, funding, realized PnL, positions and equity from the ledger", () => {
    const live = session();
    const back = SimAccount.restore({
      id: "led",
      startingBalance: 25_000,
      orders: [...live.orders.values()],
      fills: live.fills,
      fundingPayments: live.fundingPayments,
      marks: Object.fromEntries(live.marks),
      fundingAccruedTo: Object.fromEntries(live.fundingAccruedTo),
      seq: live.seq,
    });
    expect(back.balance).toBeCloseTo(live.balance, 9);
    expect(back.realizedPnl).toBeCloseTo(live.realizedPnl, 9);
    expect(back.feesPaid).toBeCloseTo(live.feesPaid, 9);
    expect(back.fundingPaid).toBeCloseTo(live.fundingPaid, 9);
    expect(back.equity()).toBeCloseTo(live.equity(), 9);
    expect([...back.positions.values()]).toEqual([...live.positions.values()]);
    expect(back.fills).toHaveLength(live.fills.length);
    expect(back.openOrders()).toEqual(live.openOrders());
    expect(back.nextId("ord")).toBe(live.nextId("ord")); // id sequence continues, no collisions
  });

  it("derives balance from the ledger alone (orders and marks are optional)", () => {
    const live = session();
    const back = SimAccount.restore({ id: "led", startingBalance: 25_000, orders: [], fills: live.fills, fundingPayments: live.fundingPayments });
    expect(back.balance).toBeCloseTo(live.balance, 9);
    expect(back.balance).toBeCloseTo(25_000 + live.realizedPnl - live.feesPaid - live.fundingPaid, 9);
  });

  it("an empty ledger restores to the starting balance", () => {
    const a = SimAccount.restore({ id: "x", startingBalance: 5_000, orders: [], fills: [], fundingPayments: [] });
    expect(a.balance).toBe(5_000);
    expect(a.positions.size).toBe(0);
  });
});

describe("resting-order fill gate", () => {
  const rest = () => {
    const acct = new SimAccount({ id: "g", startingBalance: 25_000 });
    const eng = new SimEngine();
    const r = eng.submit(acct, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: 99 }, solBook(T0), T0);
    expect(r.order.status).toBe("open");
    return { acct, eng, id: r.order.id };
  };

  it("without a gate nothing changes: the whole crossing size fills", () => {
    const { acct, eng } = rest();
    const fills = eng.onBook(acct, shifted(0.98), T0 + 1);
    expect(fills.map((f) => f.size)).toEqual([100]);
  });

  it("a gate that allows everything fills as usual", () => {
    const { acct, eng } = rest();
    const fills = eng.onBook(acct, shifted(0.98), T0 + 1, (_o, size) => ({ size }));
    expect(fills.reduce((s, f) => s + f.size, 0)).toBe(100);
    expect(acct.openOrders()).toHaveLength(0);
  });

  it("a gate that trims fills the allowed part and cancels the rest with the reason", () => {
    const { acct, eng, id } = rest();
    const fills = eng.onBook(acct, shifted(0.98), T0 + 1, () => ({ size: 40, reason: "leverage_cap_exceeded" }));
    expect(fills.reduce((s, f) => s + f.size, 0)).toBe(40);
    expect(acct.positionSize("SOL")).toBe(40);
    const o = acct.orders.get(id)!;
    expect(o).toMatchObject({ status: "cancelled", remaining: 0, rejectReason: "leverage_cap_exceeded" });
    expect(acct.openOrders()).toHaveLength(0);
  });

  it("a gate that refuses outright cancels the order with no fill", () => {
    const { acct, eng, id } = rest();
    const fills = eng.onBook(acct, shifted(0.98), T0 + 1, () => ({ size: 0, reason: "leverage_cap_exceeded" }));
    expect(fills).toHaveLength(0);
    expect(acct.orders.get(id)).toMatchObject({ status: "cancelled", rejectReason: "leverage_cap_exceeded" });
    expect(acct.positionSize("SOL")).toBe(0);
  });

  it("the gate is not consulted while the book does not cross the limit", () => {
    const { acct, eng } = rest();
    let calls = 0;
    eng.onBook(acct, solBook(T0 + 1), T0 + 1, () => {
      calls++;
      return { size: 0 };
    });
    expect(calls).toBe(0);
    expect(acct.openOrders()).toHaveLength(1);
  });
});

describe("balance adjustments (payout sweep and reversal)", () => {
  it("move the balance, are idempotent by id, and replay through restore", () => {
    const acct = session();
    const before = acct.balance;
    expect(acct.applyAdjustment({ id: "payout_sweep:p1", kind: "payout_sweep", amount: -1000, ref: "p1", ts: T0 })).toBe(true);
    expect(acct.applyAdjustment({ id: "payout_sweep:p1", kind: "payout_sweep", amount: -1000, ref: "p1", ts: T0 + 1 })).toBe(false);
    expect(acct.balance).toBeCloseTo(before - 1000, 9);
    expect(acct.payoutsSwept()).toBe(1000);
    acct.applyAdjustment({ id: "payout_reversal:p1", kind: "payout_reversal", amount: 1000, ref: "p1", ts: T0 + 2 });
    expect(acct.payoutsSwept()).toBe(0);
    acct.applyAdjustment({ id: "payout_sweep:p2", kind: "payout_sweep", amount: -250, ref: "p2", ts: T0 + 3 });
    const back = SimAccount.restore({ id: "led", startingBalance: 25_000, orders: [...acct.orders.values()], fills: acct.fills, fundingPayments: acct.fundingPayments, adjustments: acct.adjustments });
    expect(back.balance).toBeCloseTo(acct.balance, 9);
    expect(back.adjustments).toHaveLength(3);
    expect(back.payoutsSwept()).toBe(250);
  });
});
