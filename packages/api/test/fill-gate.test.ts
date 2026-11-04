import { describe, expect, it } from "vitest";
import { makeRig } from "./helpers.js";

const W = "WalletA1111111111111111111111111111111111111";

/**
 * A resting limit order passes the leverage check when placed. By the time it fills, equity has moved, so the
 * check runs again at fill time and trims what no longer fits (rulebook 12).
 */
describe("resting limit fill: leverage re-check at fill time", () => {
  const setup = async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const pos = 200; // small, so the move does not threaten the $750 daily limit
    const first = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: pos, type: "market" });
    expect(first.accepted).toBe(true);
    const total = Math.floor((0.9995 * 10 * first.state.account.equity) / mark); // right at the 10x cap when placed
    const rest = total - pos;
    const limit = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: rest, type: "limit", limitPrice: +(mark * 0.992).toFixed(2) });
    expect(limit.accepted).toBe(true); // legal at placement
    expect(limit.order?.status).toBe("open");
    return { rig, c, mark, rest, pos, orderId: limit.order!.id };
  };

  it("trims the fill so the account never exceeds its leverage cap, and cancels the rest", async () => {
    const { rig, c, rest, orderId } = await setup();
    rig.market.setMove("SOL", -0.009);
    const snap = await rig.market.snapshot("SOL");
    const results = await rig.svc.onMarketUpdate(snap);
    expect(results).toHaveLength(1);
    const st = await rig.svc.getState(c.id, { refresh: false });
    expect(st.status).toBe("active");
    expect(st.account.grossNotional).toBeLessThanOrEqual(10 * st.account.equity * (1 + 1e-9));
    const o = st.recentFills.filter((f) => f.orderId === orderId);
    const filled = o.reduce((s, f) => s + f.size, 0);
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(rest);
    expect(st.openOrders).toHaveLength(0); // remainder cancelled, not left resting
    expect(st.combatLog.some((e) => /trimmed .*leverage cap/.test(e.text))).toBe(true);
  });

  it("is the same through the polling tick path", async () => {
    const { rig, c, rest } = await setup();
    rig.market.setMove("SOL", -0.009);
    const st = await rig.svc.tick(c.id);
    expect(st.status).toBe("active");
    expect(st.positions[0]!.size).toBeLessThan(200 + rest);
    expect(st.account.grossNotional).toBeLessThanOrEqual(10 * st.account.equity * (1 + 1e-9));
    expect(st.openOrders).toHaveLength(0);
  });

  it("fills in full when the account still has room", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const placed = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: +(mark * 0.99).toFixed(2) });
    rig.market.setMove("SOL", -0.02);
    await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    const st = await rig.svc.getState(c.id, { refresh: false });
    expect(st.positions[0]).toMatchObject({ size: 100 });
    expect(st.recentFills.every((f) => f.orderId === placed.order!.id)).toBe(true);
  });

  it("reduce-only resting orders always fill in full", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 200, type: "market" });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "sell", size: 200, type: "limit", limitPrice: +(mark * 1.01).toFixed(2), reduceOnly: true });
    rig.market.setMove("SOL", 0.02);
    await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    const st = await rig.svc.getState(c.id, { refresh: false });
    expect(st.positions).toHaveLength(0);
  });
});

describe("streaming updates", () => {
  it("catches a breach from a pushed snapshot with no API call, and drops the challenge from the index", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });
    expect(rig.svc.activeSymbols()).toEqual(["SOL"]);
    rig.market.setMove("SOL", -0.1);
    const res = await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    expect(res[0]!.status).toBe("wounded");
    expect(res[0]!.events.some((e) => e.type === "breach")).toBe(true);
    expect(rig.svc.activeSymbols()).toEqual([]);
    expect((await rig.svc.getState(c.id, { refresh: false })).positions).toHaveLength(0);
  });

  it("ignores a snapshot older than the book it already holds", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1000, type: "market" });
    const old = await rig.market.snapshot("SOL");
    rig.market.setMove("SOL", -0.1);
    await new Promise((r) => setTimeout(r, 2));
    const newer = await rig.market.snapshot("SOL");
    await rig.svc.onMarketUpdate(newer); // breach at the new price
    expect((await rig.svc.getState(c.id, { refresh: false })).status).toBe("wounded");
    const c2 = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c2.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    await rig.svc.onMarketUpdate(newer);
    const before = (await rig.svc.getState(c2.id, { refresh: false })).positions[0]!.markPrice;
    await rig.svc.onMarketUpdate(old); // stale, out of order
    expect((await rig.svc.getState(c2.id, { refresh: false })).positions[0]!.markPrice).toBe(before);
  });

  it("halted feed refuses new exposure but still lets a position be closed", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    rig.svc.setFeedHalted("SOL", true);
    const open = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect(open).toMatchObject({ accepted: false, reason: "feed_halted" });
    const close = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true });
    expect(close.accepted).toBe(true);
  });
});
