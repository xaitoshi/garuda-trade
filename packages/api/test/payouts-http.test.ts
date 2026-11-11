import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthService, buildApp } from "../src/index.js";
import { HOUR } from "./helpers.js";
import { bearer, newWallet, signIn, type TestWallet } from "./http-helpers.js";
import { earn, makePayoutRig, type PayoutRig } from "./payout-helpers.js";

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const admin = { authorization: `Bearer ${ADMIN}` };

describe("payout routes", () => {
  let rig: PayoutRig;
  let app: FastifyInstance;
  let alice: TestWallet;
  let bob: TestWallet;
  let ta: string;
  let tb: string;
  let id: string;

  let authSvc: AuthService;
  const build = (extra: Partial<Parameters<typeof buildApp>[0]> = {}) =>
    buildApp({ service: rig.svc, payouts: rig.payouts, auth: authSvc, rateLimits: false, adminToken: ADMIN, ...extra });

  beforeEach(async () => {
    rig = makePayoutRig();
    authSvc = new AuthService({ now: () => rig.clock.t, sessionTtlMs: 7 * 24 * HOUR });
    app = build();
    alice = newWallet();
    bob = newWallet();
    ta = await signIn(app, alice);
    tb = await signIn(app, bob);
    id = (await rig.svc.create({ tier: "knight", stage: "funded", wallet: alice.address })).id;
  });

  const request = (token: string, key?: string, cid = id) =>
    app.inject({ method: "POST", url: `/challenges/${cid}/payouts`, headers: { ...bearer(token), ...(key ? { "idempotency-key": key } : {}) } });

  it("requires sign-in, ownership, and a configured payout service", async () => {
    await earn(rig, id, { size: 10 });
    expect((await app.inject({ method: "POST", url: `/challenges/${id}/payouts` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/payouts" })).statusCode).toBe(401);
    const other = await request(tb);
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("not_owner");
    expect((await app.inject({ method: "GET", url: `/challenges/${id}/payouts`, headers: bearer(tb) })).statusCode).toBe(403);
    const off = build({ payouts: undefined });
    expect((await off.inject({ method: "POST", url: `/challenges/${id}/payouts`, headers: bearer(ta) })).json().error).toBe("payouts_disabled");
    expect(rig.exec.submitCalls).toBe(0);
  });

  it("201 on request, 200 replay with the same key, destination is the signed-in wallet", async () => {
    await earn(rig, id, { size: 10 });
    const a = await request(ta, "http-key-0001");
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ status: "approved", destination: alice.address, challengeId: id, needsApproval: false });
    await rig.payouts.idle();
    const b = await request(ta, "http-key-0001");
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, replayed: true, status: "paid" });
    expect(b.json().signature).toMatch(/^fakesig_/);
    expect(rig.exec.sent.size).toBe(1);
    expect([...rig.exec.sent.values()][0]!.destination).toBe(alice.address);

    const mine = (await app.inject({ method: "GET", url: "/payouts", headers: bearer(ta) })).json().payouts;
    expect(mine.map((p: { id: string }) => p.id)).toEqual([a.json().id]);
    expect((await app.inject({ method: "GET", url: "/payouts", headers: bearer(tb) })).json().payouts).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/payouts/${a.json().id}`, headers: bearer(ta) })).json().status).toBe("paid");
    expect((await app.inject({ method: "GET", url: `/payouts/${a.json().id}`, headers: bearer(tb) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/challenges/${id}/payouts`, headers: bearer(ta) })).json().payouts).toHaveLength(1);
  });

  it("no profit is 409 payout_not_eligible, a second request while open is 409 payout_in_flight", async () => {
    const none = await request(ta);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: "payout_not_eligible", detail: { reason: "no_profit" } });
    await earn(rig, id, { size: 1000 });
    expect((await request(ta)).statusCode).toBe(201);
    const again = await request(ta);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("payout_in_flight");
  });

  it("the user view never leaks internals (errors, attempts, idempotency keys)", async () => {
    await earn(rig, id, { size: 10 });
    rig.exec.failNext = 1;
    const a = (await request(ta, "http-key-0002")).json();
    await rig.payouts.idle();
    const v = (await app.inject({ method: "GET", url: `/payouts/${a.id}`, headers: bearer(ta) })).json();
    expect(v.status).toBe("approved");
    expect(v.delayed).toBe(true);
    for (const k of ["lastError", "lastErrorCode", "attempts", "idempotencyKey", "executor", "proposalId"]) expect(v).not.toHaveProperty(k);
  });

  it("/rules and /health report the configured payout policy", async () => {
    const r = (await app.inject({ method: "GET", url: "/rules" })).json();
    expect(r.common).toMatchObject({ profitSplit: 0.8, minPayoutUsd: 20 });
    expect(r.payouts).toEqual({ split: 0.8, minUsd: 20, autoApproveUpToUsd: 500, enabled: true });
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h.payouts).toMatchObject({ executor: "fake-treasury", autoMaxUsd: 500, open: 0 });
  });

  describe("admin", () => {
    beforeEach(async () => {
      await earn(rig, id, { size: 1000 });
    });

    it("does not exist without a token, and refuses a missing, wrong or truncated one", async () => {
      const closed = build({ adminToken: undefined });
      expect((await closed.inject({ method: "GET", url: "/admin/payouts", headers: admin })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/admin/payouts" })).statusCode).toBe(401);
      for (const t of ["wrong", ADMIN.slice(0, -1), `${ADMIN}x`, ""]) {
        const r = await app.inject({ method: "GET", url: "/admin/payouts", headers: { authorization: `Bearer ${t}` } });
        expect(r.statusCode, t).toBe(401);
        expect(r.json().error).toBe("admin_unauthorized");
      }
      // a user session is not an admin
      expect((await app.inject({ method: "POST", url: "/admin/payouts/x/approve", headers: bearer(ta) })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/admin/payouts", headers: admin })).statusCode).toBe(200);
    });

    it("refuses to start with a short token", () => {
      expect(() => build({ adminToken: "short" })).toThrow(/at least 24/);
    });

    it("lists the queue, approves, and the payout is sent", async () => {
      const p = (await request(ta, "http-key-0003")).json();
      expect(p.status).toBe("pending_approval");
      const q = (await app.inject({ method: "GET", url: "/admin/payouts?status=pending_approval", headers: admin })).json();
      expect(q.payouts.map((x: { id: string }) => x.id)).toEqual([p.id]);
      expect(q.summary).toMatchObject({ pendingApproval: 1 });
      expect((await app.inject({ method: "GET", url: "/admin/payouts?status=bogus", headers: admin })).statusCode).toBe(400);

      const ok = await app.inject({ method: "POST", url: `/admin/payouts/${p.id}/approve`, headers: { ...admin, "x-admin-actor": "alice@garuda" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().payout).toMatchObject({ approvedBy: "alice@garuda" });
      await rig.payouts.idle();
      const d = (await app.inject({ method: "GET", url: `/admin/payouts/${p.id}`, headers: admin })).json();
      expect(d.payout.status).toBe("paid");
      expect(d.events.map((e: { type: string }) => e.type)).toEqual(["requested", "debited", "approved", "attempt", "paid"]);
      expect((await app.inject({ method: "POST", url: "/admin/payouts/po_nope/approve", headers: admin })).statusCode).toBe(404);
    });

    it("rejects with a reason and the profit comes back; a reason is required", async () => {
      const p = (await request(ta)).json();
      const bad = await app.inject({ method: "POST", url: `/admin/payouts/${p.id}/reject`, headers: admin, payload: {} });
      expect(bad.statusCode).toBe(400);
      const rj = await app.inject({ method: "POST", url: `/admin/payouts/${p.id}/reject`, headers: admin, payload: { reason: "wash trading suspected" } });
      expect(rj.statusCode).toBe(200);
      expect(rj.json().payout).toMatchObject({ status: "rejected", rejectedReason: "wash trading suspected" });
      const mine = (await app.inject({ method: "GET", url: `/payouts/${p.id}`, headers: bearer(ta) })).json();
      expect(mine).toMatchObject({ status: "rejected", rejectedReason: "wash trading suspected" });
      expect((await rig.svc.getState(id)).account.balance).toBeGreaterThan(10_000);
    });

    it("retry puts a failed payout back in the queue", async () => {
      rig.exec.failHardNext = 1;
      const p = (await request(ta)).json();
      await rig.payouts.approve(p.id);
      await rig.payouts.idle();
      expect((await app.inject({ method: "GET", url: `/admin/payouts/${p.id}`, headers: admin })).json().payout.status).toBe("failed");
      expect((await app.inject({ method: "POST", url: `/admin/payouts/${p.id}/retry`, headers: admin })).statusCode).toBe(200);
      await rig.payouts.idle();
      expect((await app.inject({ method: "GET", url: `/admin/payouts/${p.id}`, headers: admin })).json().payout.status).toBe("paid");
      expect((await app.inject({ method: "POST", url: `/admin/payouts/${p.id}/retry`, headers: admin })).statusCode).toBe(409);
    });

    it("failed admin logins are rate limited", async () => {
      const limited = build({ rateLimits: { ip: { limit: 1000, windowMs: 60_000 }, wallet: { limit: 1000, windowMs: 60_000 }, auth: { limit: 3, windowMs: 60_000 }, orders: { limit: 1000, windowMs: 60_000 } } });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: "GET", url: "/admin/payouts", headers: { authorization: "Bearer nope" } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });
  });
});

describe("open (no-auth) mode", () => {
  it("pays the account's wallet when nobody is signed in", async () => {
    const rig = makePayoutRig();
    const app = buildApp({ service: rig.svc, payouts: rig.payouts, rateLimits: false });
    const w = newWallet();
    const f = await rig.svc.create({ tier: "knight", stage: "funded", wallet: w.address });
    await earn(rig, f.id, { size: 10 });
    const r = await app.inject({ method: "POST", url: `/challenges/${f.id}/payouts` });
    expect(r.statusCode).toBe(201);
    expect(r.json().destination).toBe(w.address);
    await rig.payouts.idle();
    expect((await app.inject({ method: "GET", url: `/payouts?wallet=${w.address}` })).json().payouts).toHaveLength(1);
  });
});
