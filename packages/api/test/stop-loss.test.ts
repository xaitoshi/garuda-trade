import { describe, expect, it } from "vitest";
import { makeRig } from "./helpers.js";

const W = "WalletA1111111111111111111111111111111111111";

describe("stop orders through the service", () => {
  it("a market entry with TP and SL gets both protective orders", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const res = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 50, type: "market", takeProfit: +(mark * 1.02).toFixed(2), stopLoss: +(mark * 0.98).toFixed(2) });
    expect(res.accepted).toBe(true);
    const kinds = res.state.openOrders.map((o) => `${o.type}:${o.side}:${o.reduceOnly}`).sort();
    expect(kinds).toEqual(["limit:sell:true", "stop:sell:true"]);
  });

  it("the stop-loss closes the position when the price falls, and the TP goes with it", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 50, type: "market", takeProfit: +(mark * 1.02).toFixed(2), stopLoss: +(mark * 0.99).toFixed(2) });
    rig.market.setMove("SOL", -0.012);
    await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    await rig.svc.onMarketUpdate(await rig.market.snapshot("SOL"));
    const st = await rig.svc.getState(c.id, { refresh: false });
    expect(st.positions).toHaveLength(0);
    expect(st.openOrders).toHaveLength(0);
  });

  it("rejects a stop-loss on the wrong side and a stop without a trigger", async () => {
    const rig = makeRig();
    const c = await rig.svc.create({ tier: "knight", wallet: W });
    const mark = (await rig.market.snapshot("SOL")).markPrice;
    const a = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 5, type: "market", stopLoss: +(mark * 1.02).toFixed(2) });
    expect(a.reason).toBe("stop_loss_wrong_side");
    const b = await rig.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 5, type: "stop" });
    expect(b.accepted).toBe(false);
  });
});
