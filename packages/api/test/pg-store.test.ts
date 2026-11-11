import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, stopEmbeddedPostgres } from "@garuda/db";
import { AuthService, PgAuthStore, PgChallengeStore, buildApp, ChallengeService } from "../src/index.js";
import { HOUR, breach, makeRig } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

afterAll(() => stopEmbeddedPostgres());

const W = "WalletA1111111111111111111111111111111111111";

/** Run against pg-mem by default; GARUDA_TEST_PG=embedded runs the same tests on real Postgres. */
async function rigWithDb() {
  const t = await createTestDb();
  const store = new PgChallengeStore(t.db);
  const rig = makeRig({ store });
  /** Simulate a process restart: new store, new service, same database. */
  const restart = async () => {
    const store2 = new PgChallengeStore(t.db);
    const svc2 = new ChallengeService({ market: rig.market, now: () => rig.clock.t, enforceGating: false, store: store2 });
    await svc2.warm();
    return { svc2, store2 };
  };
  return { ...rig, t, store, restart };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("PgChallengeStore", () => {
  it("rebuilds an account after a restart from the ledger: balance, positions, orders, fees, risk", async () => {
    const r = await rigWithDb();
    try {
      const c = await r.svc.create({ tier: "knight", knight: "Sir Persist", wallet: W });
      await r.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 300, type: "market" });
      await r.svc.placeOrder(c.id, { symbol: "ETH", side: "sell", size: 2, type: "market" });
      await r.svc.placeOrder(c.id, { symbol: "SOL", side: "sell", size: 100, type: "market" }); // partial close: realised pnl
      const mark = (await r.market.snapshot("BTC")).markPrice;
      await r.svc.placeOrder(c.id, { symbol: "BTC", side: "buy", size: 0.02, type: "limit", limitPrice: +(mark * 0.9).toFixed(1) });
      r.clock.t += 3 * HOUR;
      r.market.setMove("SOL", -0.01);
      const before = await r.svc.tick(c.id);

      const { svc2 } = await r.restart();
      const after = await svc2.getState(c.id, { refresh: false });
      expect(after.knight).toBe("Sir Persist");
      expect(after.wallet).toBe(W);
      expect(after.status).toBe(before.status);
      expect(round(after.account.balance)).toBeCloseTo(before.account.balance, 6);
      expect(after.account.feesPaid).toBeCloseTo(before.account.feesPaid, 6);
      expect(after.account.fundingPaid).toBeCloseTo(before.account.fundingPaid, 6);
      expect(after.account.realizedPnl).toBeCloseTo(before.account.realizedPnl, 6);
      expect(after.positions.map((p) => [p.symbol, p.side, +p.size.toFixed(9)])).toEqual(before.positions.map((p) => [p.symbol, p.side, +p.size.toFixed(9)]));
      for (const p of before.positions) {
        const q = after.positions.find((x) => x.symbol === p.symbol)!;
        expect(q.entryPrice).toBeCloseTo(p.entryPrice, 6);
      }
      expect(after.openOrders).toHaveLength(1);
      expect(after.openOrders[0]).toMatchObject({ symbol: "BTC", status: "open" });
      expect(after.risk.dailyFloor).toBeCloseTo(before.risk.dailyFloor, 6);
      expect(after.risk.drawdownFloor).toBeCloseTo(before.risk.drawdownFloor, 6);
      expect(after.combatLog.length).toBeGreaterThan(0);
      expect(svc2.activeSymbols().sort()).toEqual(["BTC", "ETH", "SOL"]); // worker index rebuilt by warm()

      // the restarted service keeps trading and the resting order still fills
      r.market.setMove("BTC", -0.15);
      const st = await svc2.tick(c.id);
      expect(st.positions.some((p) => p.symbol === "BTC")).toBe(true);
    } finally {
      await r.t.close();
    }
  });

  it("ledger replay equals the cached balance (verifyLedger)", async () => {
    const r = await rigWithDb();
    try {
      const c = await r.svc.create({ tier: "paladin", wallet: W });
      for (let i = 0; i < 6; i++) {
        await r.svc.placeOrder(c.id, { symbol: "SOL", side: i % 2 ? "sell" : "buy", size: 50 + i * 10, type: "market" });
        r.clock.t += HOUR;
        r.market.moveBy("SOL", i % 2 ? -0.002 : 0.003);
        await r.svc.tick(c.id);
      }
      const v = await r.store.verifyLedger(c.id);
      expect(v?.ok).toBe(true);
      expect(v!.fills).toBeGreaterThanOrEqual(6);
      expect(Math.abs(v!.diff)).toBeLessThan(1e-6);
    } finally {
      await r.t.close();
    }
  });

  it("stores each fill once however often the account is saved (append-only ledger)", async () => {
    const r = await rigWithDb();
    try {
      const c = await r.svc.create({ tier: "knight", wallet: W });
      await r.svc.placeOrder(c.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
      for (let i = 0; i < 5; i++) await r.svc.getState(c.id); // each refresh saves
      const n = (await r.t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM fills WHERE challenge_id = $1", [c.id])).rows[0]!.n;
      const mem = (await r.svc.getState(c.id, { refresh: false })).recentFills.length;
      expect(n).toBe(mem);
      const logs = (await r.t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM combat_log WHERE challenge_id = $1", [c.id])).rows[0]!.n;
      expect(logs).toBeGreaterThan(0);
    } finally {
      await r.t.close();
    }
  });

  it("persists a breach, the wounded state and the revive chain across a restart", async () => {
    const r = await rigWithDb();
    try {
      const k = await r.svc.create({ tier: "knight", knight: "Sir Scar", wallet: W });
      await breach(r, k.id);
      r.clock.t += 25 * HOUR;
      const res = await r.svc.revive(k.id, { idempotencyKey: "pg-key-1" });

      const { svc2 } = await r.restart();
      const old = await svc2.getState(k.id, { refresh: false });
      expect(old.status).toBe("wounded");
      expect(old.revivedBy).toBe(res.state.id);
      expect(old.positions).toHaveLength(0);
      const fresh = await svc2.getState(res.state.id, { refresh: false });
      expect(fresh).toMatchObject({ status: "active", scars: 1, reviveOf: k.id, knightId: k.knightId });
      expect((await svc2.reviveInfo(res.state.id)).revivesUsed).toBe(1);
      // the idempotency record survives too
      const again = await svc2.revive(k.id, { idempotencyKey: "pg-key-1" });
      expect(again.replayed).toBe(true);
      expect(again.state.id).toBe(res.state.id);
      expect((await svc2.list({ wallet: W })).map((s) => s.id).sort()).toEqual([k.id, res.state.id].sort());
    } finally {
      await r.t.close();
    }
  });

  it("persists lifecycle (dormant, archived) and the caps see it after a restart", async () => {
    const r = await rigWithDb();
    try {
      const f = await r.svc.create({ tier: "knight", stage: "funded", wallet: W });
      r.clock.t += 91 * 86_400_000;
      await r.svc.sweepLifecycle();
      const { svc2 } = await r.restart();
      const st = await svc2.getState(f.id, { refresh: false });
      expect(st.lifecycle).toBe("dormant");
      expect(st.dormantSince).toBeGreaterThan(0);
      expect(svc2.liveChallengeIds()).toContain(f.id);
    } finally {
      await r.t.close();
    }
  });

  it("enforces one demo and the caps from persisted accounts (a fresh process still knows)", async () => {
    const r = await rigWithDb();
    try {
      await r.svc.create({ tier: "demo", wallet: W });
      const { svc2 } = await r.restart();
      await expect(svc2.create({ tier: "demo", wallet: W })).rejects.toMatchObject({ code: "demo_exists" });
    } finally {
      await r.t.close();
    }
  });

  it("unknown challenge ids are undefined, not errors", async () => {
    const r = await rigWithDb();
    try {
      expect(await r.store.get("ch_nope")).toBeUndefined();
      expect(await r.store.verifyLedger("ch_nope")).toBeUndefined();
    } finally {
      await r.t.close();
    }
  });
});

describe("PgAuthStore", () => {
  it("sign-in sessions and single-use nonces live in the database", async () => {
    const t = await createTestDb();
    try {
      const rig = makeRig();
      const authStore = new PgAuthStore(t.db);
      const app = buildApp({ service: rig.svc, auth: new AuthService({ store: authStore, now: () => rig.clock.t }), rateLimits: false });
      const w = newWallet();
      const token = await signIn(app, w);
      // a second app instance on the same database (another replica / a restart) honours the session
      const app2 = buildApp({ service: rig.svc, auth: new AuthService({ store: new PgAuthStore(t.db), now: () => rig.clock.t }), rateLimits: false });
      expect((await app2.inject({ method: "GET", url: "/auth/me", headers: bearer(token) })).json().wallet).toBe(w.address);
      const raw = (await t.db.query<{ token_hash: string }>("SELECT token_hash FROM sessions")).rows;
      expect(raw).toHaveLength(1);
      expect(raw[0]!.token_hash).not.toContain(token);
      // nonce is single-use at the database level
      const n = await new AuthService({ store: authStore, now: () => rig.clock.t }).issueNonce(w.address);
      expect(await authStore.consumeNonce(n.nonce, w.address, rig.clock.t)).toBeDefined();
      expect(await authStore.consumeNonce(n.nonce, w.address, rig.clock.t)).toBeUndefined();
      // logout revokes
      await app.inject({ method: "POST", url: "/auth/logout", headers: bearer(token) });
      expect((await app2.inject({ method: "GET", url: "/auth/me", headers: bearer(token) })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});
