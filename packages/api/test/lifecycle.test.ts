import { describe, expect, it } from "vitest";
import { ServiceError, StubPaymentProvider } from "../src/index.js";
import { DAY, HOUR, breach, makeRig } from "./helpers.js";

const W = "WalletA1111111111111111111111111111111111111";
const W2 = "WalletB1111111111111111111111111111111111111";

const failsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  return err as ServiceError;
};

describe("account caps (rulebook 20)", () => {
  it("caps aggregate evaluation size at $200k per wallet and counts only live accounts", async () => {
    const { svc } = makeRig();
    await svc.create({ tier: "ascended", wallet: W });
    const b = await svc.create({ tier: "ascended", wallet: W });
    const e = await failsWith(svc.create({ tier: "squire", wallet: W }), "evaluation_cap_exceeded");
    expect(e.status).toBe(403);
    expect(e.detail).toMatchObject({ cap: 200_000, used: 200_000, requested: 10_000 });
    // another wallet is unaffected
    await svc.create({ tier: "ascended", wallet: W2 });
    expect(b.tier).toBe("ascended");
  });

  it("frees cap room when an account is breached", async () => {
    const rig = makeRig();
    const { svc } = rig;
    await svc.create({ tier: "ascended", wallet: W });
    const k = await svc.create({ tier: "ascended", wallet: W });
    await failsWith(svc.create({ tier: "knight", wallet: W }), "evaluation_cap_exceeded");
    await breach(rig, k.id, 3000);
    const again = await svc.create({ tier: "knight", wallet: W });
    expect(again.tier).toBe("knight");
  });

  it("caps aggregate funded size at $300k, separately from evaluation", async () => {
    const { svc } = makeRig();
    for (let i = 0; i < 3; i++) await svc.create({ tier: "ascended", stage: "funded", wallet: W });
    await failsWith(svc.create({ tier: "squire", stage: "funded", wallet: W }), "funded_cap_exceeded");
    // evaluation room is independent
    expect((await svc.create({ tier: "ascended", wallet: W })).stage).toBe("evaluation");
  });

  it("archived funded accounts stop counting toward the funded cap", async () => {
    const { svc, clock } = makeRig();
    for (let i = 0; i < 3; i++) await svc.create({ tier: "ascended", stage: "funded", wallet: W });
    await failsWith(svc.create({ tier: "squire", stage: "funded", wallet: W }), "funded_cap_exceeded");
    clock.t += 90 * DAY + 1;
    await svc.sweepLifecycle();
    clock.t += 365 * DAY + 1;
    await svc.sweepLifecycle();
    expect((await svc.create({ tier: "ascended", stage: "funded", wallet: W })).lifecycle).toBe("active");
  });

  it("serialises concurrent creates for one wallet so the cap cannot be raced", async () => {
    const { svc } = makeRig();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => svc.create({ tier: "ascended", wallet: W })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });
});

describe("free demo account", () => {
  it("is $5k, has no NFT, no knight id and no payouts", async () => {
    const { svc } = makeRig();
    const d = await svc.create({ tier: "demo", wallet: W, nftLevels: ["knight"] });
    expect(d).toMatchObject({ demo: true, tier: "demo", payoutsEnabled: false, knightId: undefined });
    expect(d.account.startingBalance).toBe(5_000);
    await failsWith(svc.payoutQuote(d.id), "payouts_unavailable");
  });

  it("allows one active demo per wallet, and a different wallet its own", async () => {
    const { svc } = makeRig();
    await svc.create({ tier: "demo", wallet: W });
    await failsWith(svc.create({ tier: "demo", wallet: W }), "demo_exists");
    expect((await svc.create({ tier: "demo", wallet: W2 })).demo).toBe(true);
  });

  it("does not count toward the evaluation cap and is evaluation-only", async () => {
    const { svc } = makeRig();
    await svc.create({ tier: "ascended", wallet: W });
    await svc.create({ tier: "ascended", wallet: W });
    expect((await svc.create({ tier: "demo", wallet: W })).demo).toBe(true);
    await failsWith(svc.create({ tier: "demo", stage: "funded", wallet: W2 }), "demo_evaluation_only");
  });

  it("restarts for free one hour after a breach, and not before", async () => {
    const rig = makeRig();
    const d = await rig.svc.create({ tier: "demo", wallet: W });
    await breach(rig, d.id, 400);
    rig.clock.t += 30 * 60_000;
    const e = await failsWith(rig.svc.create({ tier: "demo", wallet: W }), "demo_cooldown");
    expect(e.status).toBe(429);
    rig.clock.t += 31 * 60_000;
    const again = await rig.svc.create({ tier: "demo", wallet: W });
    expect(again.status).toBe("active");
  });

  it("cannot be revived", async () => {
    const rig = makeRig();
    const d = await rig.svc.create({ tier: "demo", wallet: W });
    await breach(rig, d.id, 400);
    rig.clock.t += 2 * DAY;
    await failsWith(rig.svc.revive(d.id), "demo_no_revive");
  });

  it("can require a wallet when configured (HTTP server default)", async () => {
    const { svc } = makeRig({ requireWalletForDemo: true });
    await failsWith(svc.create({ tier: "demo" }), "wallet_required");
  });
});

describe("dormancy and archive (rulebook 18)", () => {
  it("funded accounts go dormant after 90 idle days, not before, and challenge accounts never do", async () => {
    const { svc, clock } = makeRig();
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    const e = await svc.create({ tier: "knight", wallet: W });
    clock.t += 89 * DAY;
    expect(await svc.sweepLifecycle()).toEqual([]);
    clock.t += 2 * DAY;
    const changes = await svc.sweepLifecycle();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: f.id, from: "active", to: "dormant" });
    expect((await svc.getState(f.id, { refresh: false })).lifecycle).toBe("dormant");
    expect((await svc.getState(e.id, { refresh: false })).lifecycle).toBe("active");
  });

  it("an order is activity and resets the 90-day clock", async () => {
    const { svc, clock } = makeRig();
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    clock.t += 60 * DAY;
    await svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    clock.t += 60 * DAY;
    expect(await svc.sweepLifecycle()).toEqual([]);
    clock.t += 31 * DAY;
    expect(await svc.sweepLifecycle()).toHaveLength(1);
  });

  it("a payout request counts as activity", async () => {
    const { svc, clock } = makeRig();
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    clock.t += 80 * DAY;
    await svc.recordPayoutRequest(f.id);
    clock.t += 80 * DAY;
    expect(await svc.sweepLifecycle()).toEqual([]);
  });

  it("dormant accounts reactivate for free, by request or by trading", async () => {
    const { svc, clock } = makeRig();
    const a = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    const b = await svc.create({ tier: "knight", stage: "funded", wallet: W2 });
    clock.t += 100 * DAY;
    await svc.sweepLifecycle();
    expect((await svc.reactivate(a.id)).lifecycle).toBe("active");
    const r = await svc.placeOrder(b.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect(r.accepted).toBe(true);
    expect(r.state.lifecycle).toBe("active");
    expect(r.state.dormantSince).toBeUndefined();
  });

  it("archives 365 days after going dormant: flat, not tradable, not reactivatable, out of the worker index", async () => {
    const { svc, clock } = makeRig();
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    await svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
    expect(svc.activeSymbols()).toEqual(["SOL"]);
    clock.t += 91 * DAY;
    await svc.sweepLifecycle();
    expect(svc.activeSymbols()).toEqual(["SOL"]); // dormant accounts keep their risk checks
    expect(svc.liveChallengeIds()).toContain(f.id);
    clock.t += 363 * DAY;
    expect(await svc.sweepLifecycle()).toEqual([]);
    clock.t += 2 * DAY;
    const changes = await svc.sweepLifecycle();
    expect(changes[0]).toMatchObject({ id: f.id, from: "dormant", to: "archived" });
    const st = await svc.getState(f.id, { refresh: false });
    expect(st.lifecycle).toBe("archived");
    expect(st.positions).toHaveLength(0);
    expect(svc.activeSymbols()).toEqual([]);
    expect(svc.liveChallengeIds()).not.toContain(f.id);
    await failsWith(svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 1, type: "market" }), "account_archived");
    await failsWith(svc.reactivate(f.id), "account_archived");
  });

  it("a long outage skips straight through dormant to archived in one sweep", async () => {
    const { svc, clock } = makeRig();
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    clock.t += 600 * DAY;
    const changes = await svc.sweepLifecycle();
    expect(changes.map((c) => c.to)).toEqual(["dormant", "archived"]);
    expect((await svc.getState(f.id, { refresh: false })).lifecycle).toBe("archived");
  });
});

describe("revive (rulebook 17)", () => {
  const knightWounded = async (rig = makeRig()) => {
    const k = await rig.svc.create({ tier: "knight", knight: "Sir Lance", wallet: W });
    await breach(rig, k.id);
    return { rig, k };
  };

  it("is locked for 24 hours after the breach", async () => {
    const { rig, k } = await knightWounded();
    const info = await rig.svc.reviveInfo(k.id);
    expect(info).toMatchObject({ eligible: false, reason: "revive_cooldown", fee: 220, revivesLeft: 3 });
    expect(info.availableAt).toBe(rig.clock.t + 24 * HOUR);
    const e = await failsWith(rig.svc.revive(k.id), "revive_cooldown");
    expect(e.status).toBe(429);
    rig.clock.t += 24 * HOUR - 1;
    await failsWith(rig.svc.revive(k.id), "revive_cooldown");
    rig.clock.t += 1;
    expect((await rig.svc.reviveInfo(k.id)).eligible).toBe(true);
  });

  it("charges 20 percent off the same tier and starts a fresh challenge for the same knight", async () => {
    const payments = new StubPaymentProvider();
    const { rig, k } = await knightWounded(makeRig({ payments }));
    rig.clock.t += 25 * HOUR;
    const res = await rig.svc.revive(k.id);
    expect(res.feeUsd).toBe(220); // 275 * 0.8
    expect(payments.charges).toHaveLength(1);
    expect(payments.charges[0]).toMatchObject({ amountUsd: 220, kind: "revive", wallet: W });
    expect(res.state).toMatchObject({ tier: "knight", stage: "evaluation", status: "active", knight: "Sir Lance", knightId: k.knightId, reviveOf: k.id, scars: 1 });
    expect(res.state.id).not.toBe(k.id);
    expect(res.state.account.balance).toBe(25_000);
    const old = await rig.svc.getState(k.id, { refresh: false });
    expect(old.status).toBe("wounded");
    expect(old.revivedBy).toBe(res.state.id);
    await failsWith(rig.svc.revive(k.id), "already_revived");
  });

  it("charges the discounted fee for each tier", async () => {
    for (const [tier, fee] of [["squire", 95.2], ["paladin", 399.2], ["ascended", 719.2]] as const) {
      const rig = makeRig();
      const c = await rig.svc.create({ tier, wallet: W });
      await breach(rig, c.id, 600);
      rig.clock.t += 25 * HOUR;
      expect((await rig.svc.revive(c.id)).feeUsd).toBe(fee);
    }
  });

  it("allows at most 3 revives per knight, then refuses", async () => {
    const rig = makeRig();
    let cur = (await rig.svc.create({ tier: "squire", knight: "Sir Cat", wallet: W })).id;
    for (let i = 1; i <= 3; i++) {
      await breach(rig, cur, 200);
      rig.clock.t += 25 * HOUR;
      const r = await rig.svc.revive(cur);
      expect(r.state.scars).toBe(i);
      expect(r.revive.revivesLeft).toBe(3 - i);
      cur = r.state.id;
    }
    await breach(rig, cur, 200);
    rig.clock.t += 25 * HOUR;
    const info = await rig.svc.reviveInfo(cur);
    expect(info).toMatchObject({ eligible: false, reason: "revive_cap_reached", revivesLeft: 0 });
    await failsWith(rig.svc.revive(cur), "revive_cap_reached");
  });

  it("the cap is per knight: another knight of the same wallet is not affected", async () => {
    const rig = makeRig();
    const a = await rig.svc.create({ tier: "squire", wallet: W });
    const b = await rig.svc.create({ tier: "squire", wallet: W });
    await breach(rig, a.id, 200);
    await breach(rig, b.id, 200);
    rig.clock.t += 25 * HOUR;
    expect((await rig.svc.revive(a.id)).revive.revivesLeft).toBe(2);
    expect((await rig.svc.reviveInfo(b.id)).revivesLeft).toBe(3);
  });

  it("only wounded accounts can be revived", async () => {
    const { svc } = makeRig();
    const k = await svc.create({ tier: "knight", wallet: W });
    await failsWith(svc.revive(k.id), "not_wounded");
  });

  it("an idempotency key makes a retry return the first result without charging twice", async () => {
    const payments = new StubPaymentProvider();
    const { rig, k } = await knightWounded(makeRig({ payments }));
    rig.clock.t += 25 * HOUR;
    const first = await rig.svc.revive(k.id, { idempotencyKey: "abc-123" });
    const second = await rig.svc.revive(k.id, { idempotencyKey: "abc-123" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.state.id).toBe(first.state.id);
    expect(payments.charges).toHaveLength(1);
    // the same key on a different challenge is a client bug
    const other = await rig.svc.create({ tier: "knight", wallet: W });
    await breach(rig, other.id);
    rig.clock.t += 25 * HOUR;
    await failsWith(rig.svc.revive(other.id, { idempotencyKey: "abc-123" }), "idempotency_key_reused");
  });

  it("a failed payment creates nothing and leaves the knight revivable", async () => {
    const payments = new StubPaymentProvider();
    const { rig, k } = await knightWounded(makeRig({ payments }));
    rig.clock.t += 25 * HOUR;
    payments.failWith = "card_declined";
    const e = await failsWith(rig.svc.revive(k.id), "payment_failed");
    expect(e.status).toBe(402);
    expect(await rig.svc.list({ wallet: W })).toHaveLength(1);
    payments.failWith = undefined;
    expect((await rig.svc.revive(k.id)).state.status).toBe("active");
  });

  it("respects the evaluation cap for the replacement account", async () => {
    const rig = makeRig();
    const a = await rig.svc.create({ tier: "ascended", wallet: W });
    await breach(rig, a.id, 3500);
    await rig.svc.create({ tier: "ascended", wallet: W });
    await rig.svc.create({ tier: "ascended", wallet: W });
    rig.clock.t += 25 * HOUR;
    await failsWith(rig.svc.revive(a.id), "evaluation_cap_exceeded");
  });
});

describe("payouts and the funded stage", () => {
  it("quotes a payout for funded accounts only", async () => {
    const { svc } = makeRig();
    const e = await svc.create({ tier: "knight", wallet: W });
    await failsWith(svc.payoutQuote(e.id), "payouts_unavailable");
    const f = await svc.create({ tier: "knight", stage: "funded", wallet: W });
    expect((await svc.payoutQuote(f.id)).kycRequired).toBe(true);
  });
});
