import { describe, expect, it } from "vitest";
import { FakeKnights, FakeUsdc } from "@garuda/chain";
import { PaymentRequiredProvider, PurchaseService, buildApp } from "../src/index.js";
import { makeRig } from "./helpers.js";

const A = "WalletA1111111111111111111111111111111111111";

describe("public market routes (web app)", () => {
  const rig = makeRig();
  const app = buildApp({ service: rig.svc, rateLimits: false });

  it("serves the live book, mark and funding for a whitelisted market", async () => {
    const r = await app.inject({ method: "GET", url: "/markets/SOL-PERP?depth=5" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ symbol: "SOL", display: "SOL-PERP", maxLeverage: 10, tradable: true, source: "replay" });
    expect(b.book.bids).toHaveLength(5);
    expect(b.book.asks).toHaveLength(5);
    expect(b.bestBid).toBeLessThan(b.bestAsk);
    expect(b.mark).toBeGreaterThan(0);
  });

  it("follows the market and shares one snapshot inside the cache window", async () => {
    const before = (await app.inject({ method: "GET", url: "/markets/BTC" })).json().mark;
    rig.market.setMove("BTC", 0.05);
    const cached = (await app.inject({ method: "GET", url: "/markets/BTC" })).json().mark;
    expect(cached).toBe(before);
    const fresh = buildApp({ service: rig.svc, rateLimits: false, marketCacheMs: 0 });
    const after = (await fresh.inject({ method: "GET", url: "/markets/BTC" })).json().mark;
    expect(after).toBeCloseTo(before * 1.05, 4);
    rig.market.setMove("BTC", 0);
  });

  it("rejects markets outside the whitelist", async () => {
    expect((await app.inject({ method: "GET", url: "/markets/DOGE9" })).statusCode).toBe(404);
  });

  it("serves candles labelled by source and validates the timeframe", async () => {
    const r = await app.inject({ method: "GET", url: "/markets/ETH/candles?tf=15m&limit=60" });
    const b = r.json();
    expect(r.statusCode).toBe(200);
    expect(b).toMatchObject({ symbol: "ETH", timeframe: "15m", source: "synthetic" });
    expect(b.candles).toHaveLength(60);
    for (const c of b.candles) expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    expect(b.candles[59].time).toBeGreaterThan(b.candles[58].time);
    expect((await app.inject({ method: "GET", url: "/markets/ETH/candles?tf=2s" })).statusCode).toBe(400);
  });
});

describe("CORS", () => {
  const rig = makeRig();

  it("is off by default", async () => {
    const app = buildApp({ service: rig.svc, rateLimits: false });
    const r = await app.inject({ method: "GET", url: "/rules", headers: { origin: "https://evil.example" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows listed origins and answers preflight", async () => {
    const app = buildApp({ service: rig.svc, rateLimits: false, corsOrigins: ["https://app.garuda.test"] });
    const ok = await app.inject({ method: "GET", url: "/rules", headers: { origin: "https://app.garuda.test" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.garuda.test");
    const no = await app.inject({ method: "GET", url: "/rules", headers: { origin: "https://evil.example" } });
    expect(no.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({ method: "OPTIONS", url: "/challenges", headers: { origin: "https://app.garuda.test", "access-control-request-method": "POST" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toContain("Authorization");
  });
});

describe("knight name on purchase", () => {
  it("carries the chosen name through quote, pay and mint", async () => {
    const knights = new FakeKnights();
    const usdc = new FakeUsdc();
    const rig = makeRig({ knights, requirePayment: true, payments: new PaymentRequiredProvider() });
    const purchases = new PurchaseService({ service: rig.svc, usdc, now: () => rig.clock.t });
    const app = buildApp({ service: rig.svc, purchases, rateLimits: false });
    const q = (await app.inject({ method: "POST", url: "/purchases/challenge", payload: { tier: "knight", wallet: A, knightName: "  Sir Pudding " } })).json();
    const sig = usdc.addPayment({ signature: "s".repeat(88), wallet: A, reference: q.reference, amountBaseUnits: BigInt(q.amountBaseUnits), at: rig.clock.t });
    const done = await app.inject({ method: "POST", url: `/purchases/${q.orderId}/confirm`, payload: { signature: sig } });
    expect(done.statusCode).toBe(200);
    const st = await rig.svc.getState(done.json().order.challengeId, { refresh: false });
    expect(st.knight).toBe("Sir Pudding");
    expect(await app.inject({ method: "POST", url: "/purchases/challenge", payload: { tier: "knight", wallet: A, knightName: "x".repeat(40) } }).then((r) => r.statusCode)).toBe(400);
  });
});
