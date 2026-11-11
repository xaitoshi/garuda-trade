import { describe, expect, it } from "vitest";
import { FakeKnights } from "@garuda/chain";
import { DEFAULT_PAYOUT_POLICY } from "@garuda/risk-engine";
import { ServiceError, buildApp } from "../src/index.js";
import { DAY, makeRig, passEvaluation, type Rig } from "./helpers.js";
import { WALLET_A, makePayoutRig } from "./payout-helpers.js";

const A = "WalletA1111111111111111111111111111111111111";
const ADMIN = "admin-token-for-tests-0123456789abcdef";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof ServiceError) return `${e.status}:${e.code}`;
    throw e;
  }
}

/** One closed round trip in SOL on the current day. `move` sets the size of the win (or loss). */
async function roundTrip(rig: Rig, id: string, move: number, size?: number) {
  const start = (await rig.svc.getState(id, { refresh: false })).account.startingBalance;
  const sz = size ?? Math.round((start * 2400) / 25_000);
  const b = await rig.svc.placeOrder(id, { symbol: "SOL", side: "buy", size: sz, type: "market" });
  if (!b.accepted) throw new Error(`buy rejected: ${b.reason}`);
  rig.market.setMove("SOL", move);
  const s = await rig.svc.placeOrder(id, { symbol: "SOL", side: "sell", size: sz, type: "market", reduceOnly: true });
  rig.market.setMove("SOL", 0);
  if (!s.accepted) throw new Error(`sell rejected: ${s.reason}`);
  return s.state;
}

describe("Path to Funded: the four pass requirements (service)", () => {
  it("rule 1 + 2: +10% of OPEN profit does not pass and the position is NOT auto-closed", async () => {
    const r = makeRig();
    const c = await r.svc.create({ tier: "knight" });
    await r.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 960, type: "market" });
    r.market.setMove("SOL", 0.014);
    const st = await r.svc.tick(c.id);
    expect(st.account.equity).toBeGreaterThan(11_000);
    expect(st.status).toBe("active");
    expect(st.positions).toHaveLength(1);
    expect(st.pathToFunded).toMatchObject({ targetMet: false, flat: false, openPositions: 1, next: "trade" });
  });

  it("rule 3: the closed target on day one is not enough; three trading days are", async () => {
    const r = makeRig();
    const c = await r.svc.create({ tier: "knight" });
    // day 1: a big closed win already above +10%
    let st = await roundTrip(r, c.id, 0.016);
    expect(st.account.balance).toBeGreaterThan(11_000);
    expect(st.status).toBe("active");
    expect(st.pathToFunded).toMatchObject({ targetMet: true, flat: true, tradingDays: 1, daysMet: false, next: "trade" });
    // days 2 and 3 (non-consecutive is fine): comparable wins so the best-day rule also holds
    r.clock.t += DAY;
    st = await roundTrip(r, c.id, 0.016);
    expect(st.status).toBe("active");
    expect(st.pathToFunded!.tradingDays).toBe(2);
    r.clock.t += 3 * DAY;
    st = await roundTrip(r, c.id, 0.016);
    expect(st.pathToFunded!.tradingDays).toBe(3);
    expect(st.status).toBe("passed");
  });

  it("rule 4: one lucky day blocks the pass (soft gate, never a breach) until later days spread the profit", async () => {
    const r = makeRig();
    const c = await r.svc.create({ tier: "knight" });
    let st = await roundTrip(r, c.id, 0.016); // big day
    for (let d = 0; d < 2; d++) {
      r.clock.t += DAY;
      st = await roundTrip(r, c.id, 0.002); // small days
    }
    expect(st.pathToFunded).toMatchObject({ targetMet: true, flat: true, daysMet: true });
    expect(st.pathToFunded!.bestDay.ok).toBe(false);
    expect(st.pathToFunded!.bestDay.share!).toBeGreaterThan(0.5);
    expect(st.status).toBe("active"); // not wounded, not passed: keep trading
    for (let d = 0; d < 10 && st.status === "active"; d++) {
      r.clock.t += DAY;
      st = await roundTrip(r, c.id, 0.008);
    }
    expect(st.status).toBe("passed");
    expect(st.pathToFunded!.bestDay.share!).toBeLessThanOrEqual(0.5);
  });

  it("a loss can still breach while the soft gates are unmet (limits stay on equity)", async () => {
    const r = makeRig();
    const c = await r.svc.create({ tier: "knight" });
    await roundTrip(r, c.id, 0.016);
    await r.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 960, type: "market" });
    r.market.setMove("SOL", -0.08);
    const st = await r.svc.tick(c.id);
    expect(st.status).toBe("wounded");
  });
});

describe("Path to Funded: claim, KYC and risk review", () => {
  const manual = () => {
    const knights = new FakeKnights();
    const rig = makeRig({ knights, enforceGating: true, kycMode: "manual", fundedReview: "manual" });
    return { ...rig, knights };
  };

  it("cannot claim before every rule is met", async () => {
    const r = manual();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    expect(await code(r.svc.claimFunded(c.id, { actorWallet: A }))).toBe("409:not_eligible");
  });

  it("claim -> KYC pending -> under review -> funded on approval; the pass never promotes the knight; the funded account opens at Lv.1 of its tier on the same knight", async () => {
    const r = manual();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    const passed = await passEvaluation(r, c.id);
    expect(passed.pathToFunded).toMatchObject({ eligible: true, next: "claim" });
    // passed (rules 1 to 4 met): a win, no promotion, unlocked until the funded account opens
    expect(await r.knights.get(c.knightId!)).toMatchObject({ tier: "squire", level: 1, wins: 1, frozen: false });
    // no direct door to a funded account
    expect(await code(r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId }))).toBe("403:claim_required");

    let st = await r.svc.claimFunded(c.id, { actorWallet: A });
    expect(st.pathToFunded).toMatchObject({ next: "verify_identity", claim: { status: "kyc_pending", kyc: "pending" } });
    // idempotent
    expect((await r.svc.claimFunded(c.id, { actorWallet: A })).pathToFunded!.claim!.claimedAt).toBe(st.pathToFunded!.claim!.claimedAt);
    // review cannot jump the identity check
    expect(await code(r.svc.reviewClaim(c.id, { decision: "approve" }))).toBe("409:claim_not_under_review");

    st = await r.svc.setClaimKyc(c.id, { decision: "approve", actor: "ops" });
    expect(st.pathToFunded).toMatchObject({ next: "under_review", claim: { status: "under_review", kyc: "approved", kycBy: "ops" } });
    expect((await r.svc.listClaims("under_review")).map((x) => x.challengeId)).toEqual([c.id]);

    st = await r.svc.reviewClaim(c.id, { decision: "approve", actor: "ops" });
    expect(st.pathToFunded).toMatchObject({ next: "funded", claim: { status: "approved" } });
    const fundedId = st.pathToFunded!.claim!.fundedId!;
    const f = await r.svc.getState(fundedId, { refresh: false });
    // challenge profit is never carried over: the funded account starts at the same starting balance, no target
    expect(f).toMatchObject({ stage: "funded", status: "active", knightId: c.knightId, wallet: A, pathToFunded: null });
    expect(f.account.balance).toBe(5_000);
    expect(f.risk.targetEquity).toBeNull();
    expect(await r.knights.get(c.knightId!)).toMatchObject({ status: "funded", frozen: true, tier: "squire", level: 1 });
  });

  it("KYC rejection and review rejection end the claim", async () => {
    const r = manual();
    const c1 = await r.svc.create({ tier: "squire", wallet: A });
    await passEvaluation(r, c1.id);
    await r.svc.claimFunded(c1.id, { actorWallet: A });
    const st1 = await r.svc.setClaimKyc(c1.id, { decision: "reject", reason: "document unreadable" });
    expect(st1.pathToFunded).toMatchObject({ next: "rejected", claim: { status: "rejected", kyc: "rejected", reason: "document unreadable" } });
    expect(await code(r.svc.claimFunded(c1.id, { actorWallet: A }))).toBe("409:claim_rejected");

    const r2 = manual();
    const c2 = await r2.svc.create({ tier: "squire", wallet: A });
    await passEvaluation(r2, c2.id);
    await r2.svc.claimFunded(c2.id, { actorWallet: A });
    await r2.svc.setClaimKyc(c2.id, { decision: "approve" });
    const st2 = await r2.svc.reviewClaim(c2.id, { decision: "reject", reason: "hedged across accounts" });
    expect(st2.pathToFunded!.claim).toMatchObject({ status: "rejected", reason: "hedged across accounts" });
    expect((await r2.svc.list({ wallet: A })).filter((x) => x.stage === "funded")).toHaveLength(0);
  });

  it("only the knight holder can claim", async () => {
    const r = manual();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await passEvaluation(r, c.id);
    expect(await code(r.svc.claimFunded(c.id, { actorWallet: "WalletB1111111111111111111111111111111111111" }))).toBe("403:not_knight_owner");
  });

  it("an account funded before Path to Funded is recorded on claim, never opened twice", async () => {
    const knights = new FakeKnights();
    const r = makeRig({ knights, enforceGating: true });
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await passEvaluation(r, c.id);
    const old = await r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId }); // the pre v1.1 door
    const st = await r.svc.claimFunded(c.id, { actorWallet: A });
    expect(st.pathToFunded).toMatchObject({ next: "funded", claim: { status: "approved", fundedId: old.id, reviewedBy: "legacy" } });
    expect((await r.svc.list({ wallet: A })).filter((x) => x.stage === "funded")).toHaveLength(1);
  });

  it("auto modes (dev, tests) open the funded account on claim", async () => {
    const r = makeRig();
    const c = await r.svc.create({ tier: "knight", wallet: A });
    await passEvaluation(r, c.id);
    const st = await r.svc.claimFunded(c.id);
    expect(st.pathToFunded).toMatchObject({ next: "funded", claim: { status: "approved", kyc: "approved", kycBy: "auto", reviewedBy: "auto" } });
  });
});

describe("Path to Funded over HTTP", () => {
  it("POST /challenges/:id/claim and the admin queue (KYC, approve) behind GARUDA_ADMIN_TOKEN", async () => {
    const rig = makeRig({ kycMode: "manual", fundedReview: "manual" });
    const app = buildApp({ service: rig.svc, adminToken: ADMIN, rateLimits: false });
    const admin = { authorization: `Bearer ${ADMIN}` };
    const c = await rig.svc.create({ tier: "knight", wallet: A });
    expect((await app.inject({ method: "POST", url: `/challenges/${c.id}/claim` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/challenges", payload: { tier: "knight", stage: "funded" } })).json().error ?? "").toBeDefined();
    await passEvaluation(rig, c.id);
    const cl = await app.inject({ method: "POST", url: `/challenges/${c.id}/claim` });
    expect(cl.statusCode).toBe(200);
    expect(cl.json().pathToFunded.claim.status).toBe("kyc_pending");
    expect((await app.inject({ method: "GET", url: "/admin/claims" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/claims?status=kyc_pending", headers: admin })).json().claims).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/admin/claims/${c.id}/kyc`, headers: admin, payload: { decision: "maybe" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/claims/${c.id}/kyc`, headers: admin, payload: { decision: "approve" } })).json().pathToFunded.claim.status).toBe("under_review");
    const ok = await app.inject({ method: "POST", url: `/admin/claims/${c.id}/approve`, headers: { ...admin, "x-admin-actor": "ops@garuda" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pathToFunded.claim).toMatchObject({ status: "approved", reviewedBy: "ops@garuda" });
    const rules = (await app.inject({ method: "GET", url: "/rules" })).json();
    expect(rules.pathToFunded).toMatchObject({ targetCounts: "closed_balance", mustBeFlat: true, minTradingDays: 3, bestDayMaxShare: 0.5, kyc: "manual", riskReview: "manual", payoutWaitingPeriodDays: 0 });
  });

  it("POST /challenges with stage funded is refused (403 claim_required) when the claim gate is on", async () => {
    const rig = makeRig({ kycMode: "manual" });
    const app = buildApp({ service: rig.svc, rateLimits: false });
    const r = await app.inject({ method: "POST", url: "/challenges", payload: { tier: "knight", stage: "funded" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "claim_required" });
  });
});

describe("rule 8: first payout on demand with the best-day rule (rulebook default 0.5)", () => {
  it("one profitable day is refused (best_day_rule); after more comparable days it is payable at once", async () => {
    const rig = makePayoutRig({ deps: { payoutPolicy: DEFAULT_PAYOUT_POLICY } });
    const f = await rig.svc.create({ tier: "knight", stage: "funded", wallet: WALLET_A });
    await roundTrip(rig, f.id, 0.01, 100);
    let q = await rig.svc.payoutQuote(f.id);
    expect(q).toMatchObject({ eligible: false, reason: "best_day_rule" });
    await expect(rig.payouts.request(f.id, { actorWallet: WALLET_A })).rejects.toMatchObject({ code: "payout_not_eligible" });
    rig.clock.t += DAY;
    await roundTrip(rig, f.id, 0.01, 100);
    rig.clock.t += DAY; // no waiting period beyond the rule itself
    await roundTrip(rig, f.id, 0.01, 100);
    q = await rig.svc.payoutQuote(f.id);
    expect(q.bestDay, JSON.stringify(q.bestDay)).toMatchObject({ ok: true });
    expect(q.eligible).toBe(true);
    const res = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect(res.status).toMatch(/approved|sending|submitted|paid/);
  });
});
