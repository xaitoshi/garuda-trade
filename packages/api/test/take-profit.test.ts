import { describe, expect, it } from "vitest";
import { makeRig } from "./helpers.js";

const W = "WalletA1111111111111111111111111111111111111";

/** A take-profit attached to an entry order is placed for whatever fills, including a resting limit entry that fills later. */
describe("take-profit attached to an entry", () => {
  it("a resting limit entry gets its TP when it fills, not before", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const entry = +(mark * 0.99).toFixed(2);
    const tp = +(mark * 1.01).toFixed(2);
    const placed = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: entry, takeProfit: tp });
    expect(placed.accepted).toBe(true);
    expect(placed.state.openOrders).toHaveLength(1); // only the entry: no TP without a position
    rig.market.setMove("SOL", -0.02);
    await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    const st = await rig.svc.getState(c.id, { refresh: false });
    expect(st.positions[0]).toMatchObject({ side: "long", size: 100 });
    const tpOrder = st.openOrders.find((o) => o.reduceOnly);
    expect(tpOrder).toMatchObject({ side: "sell", size: 100, limitPrice: tp });
  });

  it("a market entry gets its TP straight away", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const res = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 50, type: "market", takeProfit: +(mark * 1.02).toFixed(2) });
    expect(res.accepted).toBe(true);
    expect(res.state.openOrders.find((o) => o.reduceOnly)).toMatchObject({ side: "sell", size: 50 });
  });

  it("rejects a TP on the wrong side of the entry", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const res = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 50, type: "market", takeProfit: +(mark * 0.98).toFixed(2) });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("take_profit_wrong_side");
  });
});
