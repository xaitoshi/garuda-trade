import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, loadMigrations, migrate, realPostgresRequested, stopEmbeddedPostgres } from "../src/index.js";

afterAll(() => stopEmbeddedPostgres());

describe("migrations", () => {
  it("loads numbered .sql files in order and flags pg-only ones", () => {
    const ms = loadMigrations();
    expect(ms.map((m) => m.id)).toEqual(["001_ledger", "002_auth", "003_account_idempotency", "004_append_only"]);
    expect(ms.find((m) => m.id === "004_append_only")!.pgOnly).toBe(true);
    expect(ms.find((m) => m.id === "001_ledger")!.pgOnly).toBe(false);
  });

  it("creates the ledger schema and is idempotent", async () => {
    const t = await createTestDb();
    try {
      const tables = (await t.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
      for (const name of ["challenges", "orders", "fills", "funding_payments", "risk_events", "combat_log", "auth_nonces", "sessions", "revive_requests", "schema_migrations"]) {
        expect(tables).toContain(name);
      }
      expect(await migrate(t.db)).toEqual([]);
      const ids = (await t.db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id);
      expect(ids.length).toBe(t.db.kind === "postgres" ? 4 : 3);
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
});
