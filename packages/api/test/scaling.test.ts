import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, stopEmbeddedPostgres } from "@garuda/db";
import { FakeKnights } from "@garuda/chain";
import { ChallengeService, PgChallengeStore, type ChallengeState } from "../src/index.js";
import { DAY, HOUR, breach, makeRig, passEvaluation, type Rig } from "./helpers.js";
import { NO_BEST_DAY, WALLET_A, earn, makePayoutRig, type PayoutRig } from "./payout-helpers.js";

afterAll(() => stopEmbeddedPostgres());

const scaling = (st: ChallengeState) => st.scaling!;

/** Earn realized profit in small winning trades until the level-up profit condition holds. */
async function earnLevelProfit(rig: Rig, id: string) {
  for (let i = 0; i < 60; i++) {
    const st = await rig.svc.getState(id, { refresh: false });
    if (scaling(st).profitMet) return st;
    await earn(rig, id, { size: Math.max(5, Math.round(st.account.startingBalance / 250)), move: 0.04 });
  }
  throw new Error("could not earn the level-up profit");
}

/** Request a payout and let the fake treasury pay it. */
async function payOut(rig: PayoutRig, id: string) {
  const out = await rig.payouts.request(id, { actorWallet: WALLET_A });
  await rig.payouts.idle();
  expect((await rig.payouts.get(out.id)).status).toBe("paid");
  return out;
}

/** One full level: earn 5% of the current size, then a completed payout. */
async function levelUp(rig: PayoutRig, id: string) {
  await earnLevelProfit(rig, id);
  rig.clock.t += HOUR;
  await payOut(rig, id);
  rig.clock.t += HOUR;
  return rig.svc.getState(id);
}

describe("funded scaling", () => {
  it("a funded account opens at Lv.1 of its tier with the tier's size and the next level shown", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    expect(scaling(f)).toMatchObject({ tier: "squire", level: 1, label: "Squire Lv.1", size: 5_000, profitTarget: 250, payoutsSinceLevel: 0, payoutsNeeded: 1, eligible: false, next: { tier: "squire", level: 2, size: 6_666.67, label: "Squire Lv.2" } });
    const ev = await rig.svc.create({ tier: "knight", wallet: WALLET_A });
    expect(ev.scaling).toBeNull();
  });

  it("needs BOTH conditions: profit alone does not level, a payout alone does not level", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    // a payout first, with too little profit (about $45): counts the payout, no level-up
    await earn(rig, f.id, { size: 10, move: 0.05 });
    await payOut(rig, f.id);
    let st = await rig.svc.getState(f.id);
    expect(scaling(st)).toMatchObject({ level: 1, payoutsSinceLevel: 1, profitMet: false, eligible: false });
    // now the profit: realized since the level opened, INCLUDING what was paid out, reaches 5% -> levels up on the next flat refresh
    st = await earnLevelProfit(rig, f.id);
    st = await rig.svc.getState(f.id);
    expect(scaling(st)).toMatchObject({ level: 2, label: "Squire Lv.2", size: 6_666.67, payoutsSinceLevel: 0, profitSinceLevel: 0 });
  });

  it("level-up at payout completion: size steps up, the 6% floor and 3% daily limit reset to the NEW size, profit above the size is kept", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    await earnLevelProfit(rig, f.id);
    rig.clock.t += HOUR;
    await payOut(rig, f.id);
    const st = await rig.svc.getState(f.id, { refresh: false });
    expect(scaling(st)).toMatchObject({ level: 2, size: 6_666.67, history: [{ fromTier: "squire", fromLevel: 1, fromSize: 5_000, toTier: "squire", toLevel: 2, toSize: 6_666.67, payouts: 1 }] });
    expect(st.account.startingBalance).toBe(6_666.67);
    expect(st.account.balance).toBeCloseTo(6_666.67, 6); // swept to $5,000, then +$1,666.67
    expect(st.risk.drawdownFloor).toBe(6_266.67);
    expect(st.risk.dailyFloor).toBeCloseTo(6_466.67, 2);
    expect(st.account.paidOut).toBeGreaterThan(0); // the level-up step is not a payout
    expect(st.combatLog.some((c) => /levels up to Squire Lv\.2/.test(c.text))).toBe(true);
    expect(st.payoutsEnabled).toBe(true);
  });

  it("Squire Lv.3 levelling up graduates to Knight Lv.1 at $10,000; Knight and Paladin graduate the same way", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    let st = await levelUp(rig, f.id);
    expect(scaling(st)).toMatchObject({ level: 2, size: 6_666.67 });
    st = await levelUp(rig, f.id);
    expect(scaling(st)).toMatchObject({ level: 3, size: 8_333.33, next: { tier: "knight", level: 1, size: 10_000, graduates: true } });
    st = await levelUp(rig, f.id);
    expect(st.tier).toBe("knight");
    expect(scaling(st)).toMatchObject({ tier: "knight", level: 1, label: "Knight Lv.1", size: 10_000 });
    expect(st.account.startingBalance).toBe(10_000);
    expect(st.risk.drawdownFloor).toBe(9_400);
    expect(scaling(st).history.map((h) => `${h.toTier}:${h.toLevel}`)).toEqual(["squire:2", "squire:3", "knight:1"]);
    expect(st.combatLog.some((c) => /graduates from Squire Lv\.3 to Knight Lv\.1/.test(c.text))).toBe(true);
  });

  it("a payout requested BEFORE the level-up does not count toward the next one", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    await earnLevelProfit(rig, f.id);
    await payOut(rig, f.id);
    const st = await rig.svc.getState(f.id);
    expect(scaling(st)).toMatchObject({ level: 2, payoutsSinceLevel: 0 });
  });

  it("an earned level-up waits for a flat book, then applies", async () => {
    const rig = makePayoutRig();
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
    await earnLevelProfit(rig, f.id);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect((await rig.svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 2, type: "market" })).accepted).toBe(true);
    await rig.payouts.idle();
    expect((await rig.payouts.get(out.id)).status).toBe("paid");
    let st = await rig.svc.getState(f.id);
    expect(scaling(st)).toMatchObject({ level: 1, eligible: true, waitingForFlat: true });
    await rig.svc.placeOrder(f.id, { symbol: "SOL", side: "sell", size: 2, type: "market", reduceOnly: true });
    st = await rig.svc.getState(f.id);
    expect(scaling(st)).toMatchObject({ level: 2, waitingForFlat: false });
  });

  it("Ascended steps +$5,000 per level and stops at Lv.16 ($100,000)", async () => {
    const rig = makePayoutRig({ deps: { payoutPolicy: { ...NO_BEST_DAY, autoMaxUsd: 100_000 } } });
    const f = await rig.svc.create({ tier: "ascended", stage: "funded", wallet: WALLET_A });
    const st = await levelUp(rig, f.id);
    expect(scaling(st)).toMatchObject({ tier: "ascended", level: 2, size: 30_000, next: { level: 3, size: 35_000 } });
    expect(st.risk.drawdownFloor).toBe(28_200);
  });

  it("a level-up that would pass the $300,000 funded aggregate cap is held until there is room", async () => {
    const rig = makePayoutRig();
    for (let i = 0; i < 11; i++) await rig.svc.create({ tier: "ascended", stage: "funded", wallet: WALLET_A });
    await rig.svc.create({ tier: "paladin", stage: "funded", wallet: WALLET_A });
    const k = await rig.svc.create({ tier: "knight", stage: "funded", wallet: WALLET_A }); // 275k + 15k + 10k = 300k
    const st = await levelUp(rig, k.id);
    expect(scaling(st)).toMatchObject({ level: 1, eligible: true, capHeld: true });
    expect(st.combatLog.some((c) => /held/.test(c.text))).toBe(true);
  });

  it("breach on a funded account: lost and Wounded; the revive is a challenge at the CURRENT tier, re-funding starts at Lv.1", async () => {
    const knights = new FakeKnights();
    const rig = makePayoutRig({ deps: { knights } });
    const c = await rig.svc.create({ tier: "squire", wallet: WALLET_A });
    await passEvaluation(rig, c.id);
    const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A, knightAsset: c.knightId });
    expect(await knights.get(c.knightId!)).toMatchObject({ tier: "squire", level: 1, status: "funded", frozen: true });
    let st = await levelUp(rig, f.id);
    expect(await knights.get(c.knightId!)).toMatchObject({ tier: "squire", level: 2, status: "funded" });
    st = await levelUp(rig, f.id);
    st = await levelUp(rig, f.id);
    expect(st.tier).toBe("knight");
    // graduation moved the knight's tier (art and metadata follow it)
    expect(await knights.get(c.knightId!)).toMatchObject({ tier: "knight", level: 1, status: "funded", uri: "http://fake/nft/metadata/knight.json" });
    await breach(rig, f.id);
    expect(await knights.get(c.knightId!)).toMatchObject({ tier: "knight", status: "wounded", frozen: false });
    rig.clock.t += 25 * HOUR;
    const info = await rig.svc.reviveInfo(f.id);
    expect(info).toMatchObject({ eligible: true, tier: "knight", fee: 63.2 });
    const rv = await rig.svc.revive(f.id, { actorWallet: WALLET_A });
    expect(rv.state).toMatchObject({ tier: "knight", stage: "evaluation", scaling: null, account: { startingBalance: 10_000 } });
    await passEvaluation(rig, rv.state.id);
    rig.clock.t += DAY;
    const f2 = await rig.svc.create({ tier: "knight", stage: "funded", wallet: WALLET_A, knightAsset: c.knightId });
    expect(scaling(f2)).toMatchObject({ tier: "knight", level: 1, size: 10_000 });
    expect(await knights.get(c.knightId!)).toMatchObject({ tier: "knight", level: 1, status: "funded" });
  });

  it("survives a restart on Postgres: size, tier, level, floors and the ledger replay agree", async () => {
    const t = await createTestDb();
    try {
      const store = new PgChallengeStore(t.db);
      const base = makeRig({ store, payoutPolicy: NO_BEST_DAY });
      const rig = { ...base };
      const f = await rig.svc.create({ tier: "squire", stage: "funded", wallet: WALLET_A });
      // level twice through the service hooks (the PayoutService is covered above)
      for (let i = 0; i < 2; i++) {
        await earnLevelProfit(rig, f.id);
        rig.clock.t += HOUR;
        const id = `po_${i}`;
        await rig.svc.payoutReserve(f.id, WALLET_A, { create: async () => ({ id }), debited: async (x) => x });
        await rig.svc.payoutPaid(f.id, { payoutId: id, requestedAt: rig.clock.t });
        rig.clock.t += HOUR;
      }
      const before = await rig.svc.getState(f.id);
      expect(scaling(before)).toMatchObject({ level: 3, size: 8_333.33 });
      const store2 = new PgChallengeStore(t.db);
      const svc2 = new ChallengeService({ market: rig.market, now: () => rig.clock.t, store: store2, payoutPolicy: NO_BEST_DAY });
      const after = await svc2.getState(f.id, { refresh: false });
      expect(after.account.startingBalance).toBe(8_333.33);
      expect(after.account.balance).toBeCloseTo(before.account.balance, 6);
      expect(after.account.paidOut).toBeCloseTo(before.account.paidOut, 6);
      expect(after.risk.drawdownFloor).toBe(7_833.33);
      expect(scaling(after)).toMatchObject({ level: 3, tier: "squire", history: [{ toLevel: 2 }, { toLevel: 3 }] });
      expect((await store2.summaries({ wallet: WALLET_A }))[0]).toMatchObject({ size: 8_333.33, fundedLevel: 3 });
      expect(await store2.verifyLedger(f.id)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });
});
