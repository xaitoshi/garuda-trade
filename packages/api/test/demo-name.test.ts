import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthService, DEFAULT_KNIGHT_NAME, buildApp, normalizeKnightName } from "../src/index.js";
import { HOUR, makeRig } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

describe("normalizeKnightName", () => {
  it("trims, collapses spaces, and caps at 24", () => {
    expect(normalizeKnightName("  Sir   Pudding  ")).toBe("Sir Pudding");
    expect(normalizeKnightName("x".repeat(30))).toBe("x".repeat(24));
    expect(normalizeKnightName("   ")).toBeUndefined();
    expect(normalizeKnightName(undefined)).toBeUndefined();
  });
});

describe("demo knight naming", () => {
  it("creates a named demo with no knight NFT and uses the name in the opening log", async () => {
    const { svc } = makeRig();
    const d = await svc.create({ tier: "demo", wallet: "DemoWallet1111111111111111111111111", knight: "  Lady Ember  " });
    expect(d).toMatchObject({ tier: "demo", knight: "Lady Ember", demo: true });
    expect(d.knightId).toBeUndefined();
    expect(d.combatLog[0]?.text.startsWith("Lady Ember rides out")).toBe(true);
  });

  it("defaults unnamed demos to Sir Unnamed and renames once without rewriting history", async () => {
    const { svc } = makeRig();
    const d = await svc.create({ tier: "demo", wallet: "DemoWallet1111111111111111111111111" });
    expect(d.knight).toBe(DEFAULT_KNIGHT_NAME);
    const opening = d.combatLog[0]!.text;
    const renamed = await svc.renameDemoKnight(d.id, "Pip");
    expect(renamed.knight).toBe("Pip");
    expect(renamed.knightId).toBeUndefined();
    expect(renamed.combatLog[0]?.text).toBe(opening); // historical line kept
    expect(renamed.combatLog.some((e) => e.text.includes("takes the name Pip"))).toBe(true);
    await expect(svc.renameDemoKnight(d.id, "Bramble")).rejects.toMatchObject({ code: "already_named", status: 409 });
  });

  it("rejects rename on paid challenges", async () => {
    const { svc } = makeRig();
    const paid = await svc.create({ tier: "knight", knight: "Sir Rook", wallet: "PaidWallet111111111111111111111111" });
    await expect(svc.renameDemoKnight(paid.id, "Nope")).rejects.toMatchObject({ code: "not_demo", status: 403 });
    expect((await svc.getState(paid.id, { refresh: false })).knight).toBe("Sir Rook");
  });
});

describe("PATCH /challenges/:id/knight (auth)", () => {
  let app: FastifyInstance;
  let rig: ReturnType<typeof makeRig>;
  let token: string;
  let otherToken: string;

  beforeEach(async () => {
    rig = makeRig();
    app = buildApp({
      service: rig.svc,
      auth: new AuthService({ now: () => rig.clock.t, sessionTtlMs: 7 * 24 * HOUR }),
      rateLimits: false,
    });
    token = await signIn(app, newWallet());
    otherToken = await signIn(app, newWallet());
  });

  it("lets the owner name an unnamed demo and forbids other wallets and paid tiers", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/challenges",
      headers: bearer(token),
      payload: { tier: "demo" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().knight).toBe(DEFAULT_KNIGHT_NAME);
    expect(created.json().knightId).toBeUndefined();
    const id = created.json().id as string;

    const foreign = await app.inject({
      method: "PATCH",
      url: `/challenges/${id}/knight`,
      headers: bearer(otherToken),
      payload: { knight: "Moonpaw" },
    });
    expect(foreign.statusCode).toBe(403);

    const ok = await app.inject({
      method: "PATCH",
      url: `/challenges/${id}/knight`,
      headers: bearer(token),
      payload: { knight: "  Moonpaw  " },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ knight: "Moonpaw", demo: true });
    expect(ok.json().knightId).toBeUndefined();

    const paid = await app.inject({
      method: "POST",
      url: "/challenges",
      headers: bearer(token),
      payload: { tier: "squire", knight: "Dame Ash" },
    });
    expect(paid.statusCode).toBe(201);
    const deny = await app.inject({
      method: "PATCH",
      url: `/challenges/${paid.json().id}/knight`,
      headers: bearer(token),
      payload: { knight: "Hijack" },
    });
    expect(deny.statusCode).toBe(403);
    expect(deny.json().error).toBe("not_demo");
  });

  it("creates a demo with a name in one shot", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/challenges",
      headers: bearer(token),
      payload: { tier: "demo", knight: "Nightowl" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().knight).toBe("Nightowl");
    expect(r.json().knightId).toBeUndefined();
  });
});
