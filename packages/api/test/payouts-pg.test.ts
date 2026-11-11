import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, stopEmbeddedPostgres } from "@garuda/db";
import { FakePayoutExecutor } from "@garuda/chain";
import { ChallengeService, PayoutService, PgChallengeStore, PgPayoutStore, ServiceError } from "../src/index.js";
import { DAY } from "./helpers.js";
import { WALLET_A, earn, fundedAccount, makePayoutRig } from "./payout-helpers.js";

afterAll(() => stopEmbeddedPostgres());

describe("payouts on Postgres", () => {
  it("persists the payout, its ledger and the account adjustment; a restart replays them", async () => {
    const t = await createTestDb();
    const store = new PgChallengeStore(t.db);
    const rig = makePayoutRig({ deps: { store }, store: new PgPayoutStore(t.db) });
    try {
      const f = await fundedAccount(rig);
      await earn(rig, f.id, { size: 1000 });
      const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "pg-key-00001" });
      expect(out.status).toBe("pending_approval");
      await rig.payouts.approve(out.id, "alice");
      await rig.payouts.idle();

      const row = (await t.db.query<{ status: string; open_key: string | null }>("SELECT status, open_key FROM payouts WHERE id = $1", [out.id])).rows[0]!;
      expect(row).toMatchObject({ status: "paid", open_key: null });
      const ledger = (await t.db.query<{ type: string }>("SELECT type FROM payout_ledger WHERE payout_id = $1 ORDER BY seq", [out.id])).rows.map((r) => r.type);
      expect(ledger).toEqual(["requested", "debited", "approved", "attempt", "paid"]);
      const adj = (await t.db.query<{ id: string; kind: string; amount: number }>("SELECT id, kind, amount FROM balance_adjustments WHERE challenge_id = $1", [f.id])).rows;
      expect(adj).toHaveLength(1);
      expect(adj[0]).toMatchObject({ id: `payout_sweep:${out.id}`, kind: "payout_sweep" });
      expect(Number(adj[0]!.amount)).toBeCloseTo(-out.grossProfitUsd, 6);

      // restart: balance is rebuilt from the ledger, replay matches the stored balance
      const svc2 = new ChallengeService({ market: rig.market, now: () => rig.clock.t, enforceGating: false, store: new PgChallengeStore(t.db) });
      const st = await svc2.getState(f.id, { refresh: false });
      expect(st.account.balance).toBe(10_000);
      expect(st.account.paidOut).toBeCloseTo(out.grossProfitUsd, 6);
      const v = await new PgChallengeStore(t.db).verifyLedger(f.id);
      expect(v).toMatchObject({ ok: true });
      const p2 = new PayoutService({ service: svc2, store: new PgPayoutStore(t.db), executor: rig.exec, now: () => rig.clock.t });
      expect(await p2.get(out.id)).toMatchObject({ status: "paid", signature: `fakesig_${out.id}` });
      // the idempotent replay survives the restart too
      expect(await p2.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "pg-key-00001" })).toMatchObject({ id: out.id, replayed: true });
      expect(rig.exec.submitCalls).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("a rejected payout: the reversal is a second ledger row, and the replay still balances", async () => {
    const t = await createTestDb();
    const rig = makePayoutRig({ deps: { store: new PgChallengeStore(t.db) }, store: new PgPayoutStore(t.db) });
    try {
      const f = await fundedAccount(rig);
      const bal = await earn(rig, f.id, { size: 1000 });
      const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
      await rig.payouts.reject(out.id, "review");
      const adj = (await t.db.query<{ kind: string }>("SELECT kind FROM balance_adjustments WHERE challenge_id = $1 ORDER BY seq", [f.id])).rows.map((r) => r.kind);
      expect(adj).toEqual(["payout_sweep", "payout_reversal"]);
      const svc2 = new ChallengeService({ market: rig.market, now: () => rig.clock.t, enforceGating: false, store: new PgChallengeStore(t.db) });
      expect((await svc2.getState(f.id, { refresh: false })).account.balance).toBeCloseTo(bal, 6);
      expect(await new PgChallengeStore(t.db).verifyLedger(f.id)).toMatchObject({ ok: true });
      // the account is free again: the unique open key is released
      expect((await rig.payouts.request(f.id, { actorWallet: WALLET_A })).status).toBe("pending_approval");
    } finally {
      await t.close();
    }
  });

  it("the database refuses a second open payout for an account and a reused key, even past the service checks", async () => {
    const t = await createTestDb();
    try {
      const store = new PgPayoutStore(t.db);
      const base = { challengeId: "c1", wallet: WALLET_A, status: "approved" as const, sweepUsd: 100, amountUsd: 80, amountBaseUnits: "80000000", firmShareUsd: 20, split: 0.8, autoMaxUsd: 500, autoApproved: true, debited: true, executor: "x", attempts: 0, createdAt: 1, updatedAt: 1 };
      const ev = { type: "requested" as const, ts: 1, data: {} };
      await store.create({ ...base, id: "p1", idempotencyKey: "k-0000001" }, ev);
      const e = await store.create({ ...base, id: "p2" }, ev).then(() => undefined, (x) => x as ServiceError);
      expect(e?.code).toBe("payout_in_flight");
      // raw insert bypassing the store: the unique open_key is what stops it
      await expect(
        t.db.query("INSERT INTO payouts (id, challenge_id, wallet, status, open_key, amount_base_units, data, created_at, updated_at) VALUES ('p3', 'c1', 'w', 'approved', 'c1', '1', '{}', 1, 1)"),
      ).rejects.toThrow();
      expect((await store.create({ ...base, id: "p4", idempotencyKey: "k-0000001" }, ev)).created).toBe(false);
      expect((await store.create({ ...base, id: "p5", challengeId: "c2", idempotencyKey: "k-0000001" }, ev).then(() => undefined, (x) => x as ServiceError))?.code).toBe("idempotency_key_reused");
      // a terminal payout frees the account
      const p1 = (await store.get("p1"))!;
      await store.update({ ...p1, status: "paid" }, [{ type: "paid", ts: 2, data: {} }]);
      expect((await store.create({ ...base, id: "p6" }, ev)).created).toBe(true);
      expect((await store.events("p1")).map((x) => [x.seq, x.type])).toEqual([[0, "requested"], [1, "paid"]]);
      expect((await store.list({ challengeId: "c1" })).map((p) => p.id).sort()).toEqual(["p1", "p6"]);
      expect((await store.list({ status: ["paid"] })).map((p) => p.id)).toEqual(["p1"]);
    } finally {
      await t.close();
    }
  });

  it("a crash after the record but before the sweep is finished by the restarted service", async () => {
    const t = await createTestDb();
    const rig = makePayoutRig({ deps: { store: new PgChallengeStore(t.db) }, store: new PgPayoutStore(t.db) });
    try {
      const f = await fundedAccount(rig);
      await earn(rig, f.id, { size: 10 });
      const q = await rig.svc.payoutQuote(f.id, WALLET_A);
      const amountUsd = Math.floor(q.traderShare * 100) / 100;
      await new PgPayoutStore(t.db).create(
        { id: "po_pgcrash000000000001", challengeId: f.id, wallet: WALLET_A, status: "approved", sweepUsd: q.grossProfit, amountUsd, amountBaseUnits: String(Math.round(amountUsd * 1e6)), firmShareUsd: q.grossProfit - amountUsd, split: 0.8, autoMaxUsd: 500, autoApproved: true, debited: false, executor: "fake-treasury", attempts: 0, createdAt: rig.clock.t, updatedAt: rig.clock.t },
        { type: "requested", ts: rig.clock.t, data: {} },
      );
      const svc2 = new ChallengeService({ market: rig.market, now: () => rig.clock.t, enforceGating: false, store: new PgChallengeStore(t.db) });
      await svc2.warm();
      const p2 = new PayoutService({ service: svc2, store: new PgPayoutStore(t.db), executor: new FakePayoutExecutor(), now: () => rig.clock.t });
      rig.clock.t += DAY;
      await p2.reconcile();
      expect(await p2.get("po_pgcrash000000000001")).toMatchObject({ status: "paid", debited: true });
      expect((await svc2.getState(f.id, { refresh: false })).account.balance).toBe(10_000);
      expect(await new PgChallengeStore(t.db).verifyLedger(f.id)).toMatchObject({ ok: true });
    } finally {
      await t.close();
    }
  });
});
