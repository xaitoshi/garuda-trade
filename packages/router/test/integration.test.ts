import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@garuda/db";
import { buildApp } from "@garuda/api";
import { PhoenixRouter, PgRoutingStore, InMemoryRoutingStore, routingConfigFromEnv } from "../src/index.js";
import { makeRig } from "../../api/test/helpers.js";
import { MockPhoenix, cfg } from "./helpers.js";

const ADMIN = "a".repeat(32);
const H = { authorization: `Bearer ${ADMIN}` };

describe("ChallengeService -> router hook", () => {
  let tdb: TestDb | undefined;
  afterEach(async () => {
    await tdb?.close();
    tdb = undefined;
  });

  it("mirrors a selected funded account's simulated trades (Postgres store), ignores evaluations", async () => {
    tdb = await createTestDb();
    const store = new PgRoutingStore(tdb.db);
    const client = new MockPhoenix();
    let router: PhoenixRouter | undefined;
    const rig = makeRig({ onFills: (ev) => router?.onFills(ev) });
    router = new PhoenixRouter({
      config: cfg(),
      store,
      client,
      log: () => {},
      traderBook: async (id) => {
        const st = await rig.svc.getState(id, { refresh: false });
        return { stage: st.stage, demo: st.demo, status: st.status, positions: Object.fromEntries(st.positions.map((p) => [p.symbol, { size: p.side === "long" ? p.size : -p.size, markPrice: p.markPrice }])) };
      },
    });
    await router.init();
    const funded = await rig.svc.create({ tier: "knight", stage: "funded", wallet: "W1" });
    const evalAcct = await rig.svc.create({ tier: "knight", wallet: "W2" });
    await router.setTrader(funded.id, { enabled: true }, "admin");

    expect((await rig.svc.placeOrder(evalAcct.id, { symbol: "SOL", side: "buy", size: 10, type: "market" })).accepted).toBe(true);
    expect((await rig.svc.placeOrder(funded.id, { symbol: "SOL", side: "buy", size: 10, type: "market" })).accepted).toBe(true);
    await router.idle();
    expect(client.orders).toHaveLength(1);
    expect(client.orders[0]).toMatchObject({ symbol: "SOL", side: "buy", reduceOnly: false });
    expect(client.orders[0]!.size).toBeCloseTo(1);

    expect((await rig.svc.placeOrder(funded.id, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true })).accepted).toBe(true);
    await router.idle();
    expect(client.book.SOL).toBeCloseTo(0);
    const audit = await store.listOrders();
    expect(audit.map((o) => [o.book, o.action, o.status])).toEqual([["A", "close", "sent"], ["A", "open", "sent"]]);
    expect((await router.reconcile())?.drift).toEqual([]);
  });
});

describe("HTTP: /health and /admin/routing", () => {
  it("/health reports routing disabled by default; admin routes 404 without a router", async () => {
    const rig = makeRig();
    const app = buildApp({ service: rig.svc, rateLimits: false, adminToken: ADMIN });
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h.routing).toBe("disabled");
    expect(h.ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/admin/routing", headers: H })).statusCode).toBe(404);
  });

  it("disabled router: status visible to admins, resume refused, no route turns it on", async () => {
    const rig = makeRig();
    const router = new PhoenixRouter({ config: routingConfigFromEnv({}), store: new InMemoryRoutingStore(), log: () => {} });
    const app = buildApp({ service: rig.svc, rateLimits: false, adminToken: ADMIN, routing: router });
    expect((await app.inject({ method: "GET", url: "/health" })).json().routing).toBe("disabled");
    expect((await app.inject({ method: "GET", url: "/admin/routing" })).statusCode).toBe(401);
    const st = (await app.inject({ method: "GET", url: "/admin/routing", headers: H })).json();
    expect(st).toMatchObject({ mode: "disabled", halted: false, delegateKeyLoaded: false });
    expect((await app.inject({ method: "POST", url: "/admin/routing/resume", headers: H })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/admin/routing/enable", headers: H })).statusCode).toBe(404);
  });

  it("only live funded accounts can be selected; halt shows in /health", async () => {
    const rig = makeRig();
    const router = new PhoenixRouter({ config: cfg({ ROUTING_DRY_RUN: "true" }), store: new InMemoryRoutingStore(), log: () => {} });
    await router.init();
    const app = buildApp({ service: rig.svc, rateLimits: false, adminToken: ADMIN, routing: router });
    const ev = await rig.svc.create({ tier: "knight", wallet: "W2" });
    const fu = await rig.svc.create({ tier: "knight", stage: "funded", wallet: "W1" });
    const bad = await app.inject({ method: "PUT", url: `/admin/routing/traders/${ev.id}`, headers: H, payload: { enabled: true } });
    expect(bad.statusCode).toBe(409);
    const ok = await app.inject({ method: "PUT", url: `/admin/routing/traders/${fu.id}`, headers: H, payload: { enabled: true, multiplier: 0.05 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trader).toMatchObject({ challengeId: fu.id, enabled: true, multiplier: 0.05, wallet: "W1" });
    expect((await app.inject({ method: "POST", url: "/admin/routing/halt", headers: H })).json()).toMatchObject({ halted: true, haltReason: "admin" });
    expect((await app.inject({ method: "GET", url: "/health" })).json().routing).toBe("dry_run:halted");
    expect((await app.inject({ method: "POST", url: "/admin/routing/resume", headers: H })).json()).toMatchObject({ halted: false });
    expect((await app.inject({ method: "GET", url: "/admin/routing/orders", headers: H })).json()).toEqual({ orders: [] });
  });
});
