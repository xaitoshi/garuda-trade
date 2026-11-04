import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthService, StubPaymentProvider, buildApp } from "../src/index.js";
import { HOUR, makeRig, breach } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

describe("revive, reactivate and payout routes", () => {
  let app: FastifyInstance;
  let rig: ReturnType<typeof makeRig>;
  let payments: StubPaymentProvider;
  let token: string;
  let wallet: string;
  let id: string;

  beforeEach(async () => {
    payments = new StubPaymentProvider();
    rig = makeRig({ payments });
    app = buildApp({ service: rig.svc, auth: new AuthService({ now: () => rig.clock.t, sessionTtlMs: 7 * 24 * HOUR }), rateLimits: false });
    const w = newWallet();
    wallet = w.address;
    token = await signIn(app, w);
    id = (await app.inject({ method: "POST", url: "/challenges", headers: bearer(token), payload: { tier: "knight", knight: "Sir Lance" } })).json().id;
    await breach(rig, id);
  });

  const revive = (key?: string) =>
    app.inject({ method: "POST", url: `/challenges/${id}/revive`, headers: { ...bearer(token), ...(key ? { "idempotency-key": key } : {}) } });

  it("GET shows price, uses left and the cooldown", async () => {
    const r = await app.inject({ method: "GET", url: `/challenges/${id}/revive`, headers: bearer(token) });
    expect(r.json()).toMatchObject({ eligible: false, reason: "revive_cooldown", fee: 220, revivesLeft: 3, tier: "knight" });
  });

  it("POST is 429 during the 24h cooldown, then 201 with the discounted fee", async () => {
    const early = await revive();
    expect(early.statusCode).toBe(429);
    expect(early.json().error).toBe("revive_cooldown");
    rig.clock.t += 25 * HOUR;
    const ok = await revive();
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ feeUsd: 220, replayed: false, state: { reviveOf: id, scars: 1, status: "active", stage: "evaluation" } });
    expect(payments.charges).toHaveLength(1);
  });

  it("Idempotency-Key makes a retry a 200 replay with no second charge", async () => {
    rig.clock.t += 25 * HOUR;
    const a = await revive("k-1");
    const b = await revive("k-1");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().replayed).toBe(true);
    expect(b.json().state.id).toBe(a.json().state.id);
    expect(payments.charges).toHaveLength(1);
  });

  it("a declined payment is 402 and nothing is created", async () => {
    rig.clock.t += 25 * HOUR;
    payments.failWith = "insufficient_funds";
    const r = await revive();
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("payment_failed");
    const list = (await app.inject({ method: "GET", url: "/challenges", headers: bearer(token) })).json().challenges;
    expect(list).toHaveLength(1);
  });

  it("payout-quote is refused for a breached account and reactivate is a no-op on an active one", async () => {
    expect((await app.inject({ method: "GET", url: `/challenges/${id}/payout-quote`, headers: bearer(token) })).statusCode).toBe(403);
    const f = (await app.inject({ method: "POST", url: "/challenges", headers: bearer(token), payload: { tier: "knight", stage: "funded" } })).json();
    const q = await app.inject({ method: "GET", url: `/challenges/${f.id}/payout-quote`, headers: bearer(token) });
    expect(q.statusCode).toBe(200);
    expect(q.json().destination).toBe(wallet); // paid to the authenticated wallet, no identity gate
    expect(q.json().kycRequired).toBeUndefined();
    const re = await app.inject({ method: "POST", url: `/challenges/${f.id}/reactivate`, headers: bearer(token) });
    expect(re.json().lifecycle).toBe("active");
  });
});
