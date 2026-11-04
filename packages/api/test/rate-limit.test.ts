import { describe, expect, it } from "vitest";
import { AuthService, RateLimiter, buildApp, type RateLimitConfig } from "../src/index.js";
import { makeRig } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

describe("RateLimiter", () => {
  it("allows up to the limit per window per key, then blocks with a reset time", () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 }, () => t);
    expect([1, 2, 3].map(() => rl.check("a").allowed)).toEqual([true, true, true]);
    const blocked = rl.check("a");
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 });
    expect(blocked.resetMs).toBe(1000);
    expect(rl.check("b").allowed).toBe(true); // keys are independent
    t = 999;
    expect(rl.check("a").allowed).toBe(false);
    t = 1000;
    expect(rl.check("a").allowed).toBe(true); // new window
  });

  it("prunes expired buckets so memory does not grow without bound", () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 100 }, () => t);
    for (let i = 0; i < 50; i++) rl.check(`k${i}`);
    expect(rl.size).toBe(50);
    t = 500;
    rl.check("fresh");
    expect(rl.size).toBe(1);
  });
});

const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  ip: { limit: 1000, windowMs: 60_000 },
  wallet: { limit: 1000, windowMs: 60_000 },
  auth: { limit: 1000, windowMs: 60_000 },
  orders: { limit: 1000, windowMs: 60_000 },
  ...over,
});

describe("HTTP rate limits", () => {
  const setup = (rateLimits: RateLimitConfig, withAuth = true) => {
    const rig = makeRig();
    let t = 1_000_000;
    const app = buildApp({ service: rig.svc, auth: withAuth ? new AuthService({ now: () => t }) : undefined, rateLimits, now: () => t });
    return { app, rig, advance: (ms: number) => (t += ms) };
  };

  it("limits per IP: 429 with Retry-After, X-RateLimit headers, other IPs unaffected, resets next window", async () => {
    const { app, advance } = setup(cfg({ ip: { limit: 3, windowMs: 60_000 } }), false);
    const hit = (ip: string) => app.inject({ method: "GET", url: "/rules", remoteAddress: ip });
    const first = await hit("10.0.0.1");
    expect(first.headers["x-ratelimit-limit"]).toBe("3");
    expect(first.headers["x-ratelimit-remaining"]).toBe("2");
    await hit("10.0.0.1");
    await hit("10.0.0.1");
    const blocked = await hit("10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("rate_limited");
    expect(blocked.json().detail.scope).toBe("ip");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await hit("10.0.0.2")).statusCode).toBe(200);
    advance(60_000);
    expect((await hit("10.0.0.1")).statusCode).toBe(200);
  });

  it("never rate-limits /health (load balancer probes)", async () => {
    const { app } = setup(cfg({ ip: { limit: 1, windowMs: 60_000 } }), false);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("limits per wallet across IPs", async () => {
    const { app } = setup(cfg({ wallet: { limit: 4, windowMs: 60_000 } }));
    const token = await signIn(app, newWallet());
    const get = (ip: string) => app.inject({ method: "GET", url: "/challenges", headers: bearer(token), remoteAddress: ip });
    for (let i = 0; i < 4; i++) expect((await get(`10.0.1.${i}`)).statusCode).toBe(200);
    const blocked = await get("10.0.1.99"); // fresh IP, same wallet
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().detail.scope).toBe("wallet");
    // a different wallet has its own budget
    const other = await signIn(app, newWallet());
    expect((await app.inject({ method: "GET", url: "/challenges", headers: bearer(other) })).statusCode).toBe(200);
  });

  it("limits sign-in attempts per IP", async () => {
    const { app } = setup(cfg({ auth: { limit: 3, windowMs: 60_000 } }));
    const w = newWallet();
    const nonce = () => app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet: w.address }, remoteAddress: "10.9.9.9" });
    for (let i = 0; i < 3; i++) expect((await nonce()).statusCode).toBe(200);
    const blocked = await nonce();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().detail.scope).toBe("auth");
    // other routes from that IP are still fine
    expect((await app.inject({ method: "GET", url: "/rules", remoteAddress: "10.9.9.9" })).statusCode).toBe(200);
  });

  it("limits order placement per wallet with its own tighter window", async () => {
    const { app, advance } = setup(cfg({ orders: { limit: 3, windowMs: 10_000 } }));
    const token = await signIn(app, newWallet());
    const c = (await app.inject({ method: "POST", url: "/challenges", headers: bearer(token), payload: { tier: "knight" } })).json();
    const place = () => app.inject({ method: "POST", url: `/challenges/${c.id}/orders`, headers: bearer(token), payload: { symbol: "SOL", side: "buy", size: 1, type: "market" } });
    for (let i = 0; i < 3; i++) expect((await place()).statusCode).toBe(201);
    const blocked = await place();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().detail.scope).toBe("orders");
    // reads are not affected by the order limit
    expect((await app.inject({ method: "GET", url: `/challenges/${c.id}`, headers: bearer(token) })).statusCode).toBe(200);
    advance(10_000);
    expect((await place()).statusCode).toBe(201);
  });

  it("can be disabled", async () => {
    const rig = makeRig();
    const app = buildApp({ service: rig.svc, rateLimits: false });
    for (let i = 0; i < 20; i++) expect((await app.inject({ method: "GET", url: "/rules" })).statusCode).toBe(200);
  });
});
