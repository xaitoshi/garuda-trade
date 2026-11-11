import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, loadMigrations, migrate, realPostgresRequested, stopEmbeddedPostgres } from "../src/index.js";

afterAll(() => stopEmbeddedPostgres());

describe("migrations", () => {
  it("loads numbered .sql files in order and flags pg-only ones", () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual(["001_ledger", "002_auth", "003_account_idempotency", "004_append_only", "005_payment_orders", "006_payouts", "007_payouts_append_only", "008_routing", "009_funded_scaling", "010_early_access", "011_calledit_uploads"]);
    expect(ms.find((m) => m.id === "004_append_only")!.pgOnly).toBe(true);
    expect(ms.find((m) => m.id === "001_ledger")!.pgOnly).toBe(false);
  });

  it("creates the ledger schema and is idempotent", async () => {
    const t = await createTestDb();
    try {
      const tables = (await t.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
      for (const name of ["challenges", "orders", "fills", "funding_payments", "risk_events", "combat_log", "auth_nonces", "sessions", "revive_requests", "payouts", "payout_ledger", "balance_adjustments", "schema_migrations"]) {
        expect(tables).toContain(name);
      }
      expect(await migrate(t.db)).toEqual([]);
      const ids = (await t.db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id);
      expect(ids.length).toBe(t.db.kind === "postgres" ? 11 : 9);
    } finally {
      await t.close();
    }
  });

  it("rolls a failed migration back and does not record it", async () => {
    const t = await createTestDb();
    try {
      await expect(
        migrate(t.db, [{ id: "999_bad", sql: "CREATE TABLE ok_table (id int); SELECT * FROM does_not_exist;", pgOnly: false }]),
      ).rejects.toThrow();
      const ids = (await t.db.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id);
      expect(ids).not.toContain("999_bad");
    } finally {
      await t.close();
    }
  });

  it.runIf(realPostgresRequested())("real Postgres: the ledger is append-only (UPDATE and DELETE on fills raise)", async () => {
    const t = await createTestDb();
    try {
      expect(t.db.kind).toBe("postgres");
      await t.db.query(
        `INSERT INTO fills (challenge_id, seq, id, order_id, symbol, side, price, size, notional, fee, liquidity, realized_pnl, closed_size, position_after, forced, ts)
         VALUES ('c1', 0, 'f1', 'o1', 'SOL', 'buy', 100, 1, 100, 0.035, 'taker', 0, 0, 1, false, 1)`,
      );
      await expect(t.db.query("UPDATE fills SET price = 1")).rejects.toThrow(/append-only/);
      await expect(t.db.query("DELETE FROM fills")).rejects.toThrow(/append-only/);
    } finally {
      await t.close();
    }
  });

  it.runIf(realPostgresRequested())("real Postgres: the payout ledger and balance adjustments are append-only, the payouts projection is not", async () => {
    const t = await createTestDb();
    try {
      await t.db.query("INSERT INTO payout_ledger (payout_id, seq, type, ts, data) VALUES ('p1', 0, 'requested', 1, '{}')");
      await t.db.query("INSERT INTO balance_adjustments (challenge_id, seq, id, kind, amount, ref, ts) VALUES ('c1', 0, 'payout_sweep:p1', 'payout_sweep', -100, 'p1', 1)");
      await expect(t.db.query("UPDATE payout_ledger SET type = 'x'")).rejects.toThrow(/append-only/);
      await expect(t.db.query("DELETE FROM payout_ledger")).rejects.toThrow(/append-only/);
      await expect(t.db.query("UPDATE balance_adjustments SET amount = 0")).rejects.toThrow(/append-only/);
      await expect(t.db.query("DELETE FROM balance_adjustments")).rejects.toThrow(/append-only/);
      await t.db.query("INSERT INTO payouts (id, challenge_id, wallet, status, open_key, amount_base_units, data, created_at, updated_at) VALUES ('p1', 'c1', 'w', 'approved', 'c1', '1', '{}', 1, 1)");
      await t.db.query("UPDATE payouts SET status = 'paid', open_key = NULL");
    } finally {
      await t.close();
    }
  });

  it("one payout in flight per account, one payout per idempotency key (schema constraints)", async () => {
    const t = await createTestDb();
    try {
      const ins = (id: string, open: string | null, key: string | null) =>
        t.db.query("INSERT INTO payouts (id, challenge_id, wallet, status, open_key, idempotency_key, amount_base_units, data, created_at, updated_at) VALUES ($1, 'c1', 'w', 's', $2, $3, '1', '{}', 1, 1)", [id, open, key]);
      await ins("a", "c1", "k1");
      await expect(ins("b", "c1", "k2")).rejects.toThrow();
      await ins("c", null, "k3");
      await ins("d", null, null);
      await ins("e", null, null);
      await expect(ins("f", null, "k1")).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
});
