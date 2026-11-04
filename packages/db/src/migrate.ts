import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

export interface Migration {
  id: string;
  sql: string;
  /** True when the file's first line is `-- pg-only` (needs a real Postgres: triggers, plpgsql). */
  pgOnly: boolean;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return { id: f.replace(/\.sql$/, ""), sql, pgOnly: sql.trimStart().startsWith("-- pg-only") };
    });
}

/**
 * Apply pending migrations in id order, each in its own transaction, recording them in `schema_migrations`.
 * Idempotent: running twice applies nothing the second time. Returns the ids applied by this call.
 */
export async function migrate(db: Db, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  // (explicit existence check: pg-mem rejects CREATE TABLE IF NOT EXISTS when the table is already there)
  const exists = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'");
  if (exists.rows.length === 0) {
    await db.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at bigint NOT NULL)");
  }
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    if (m.pgOnly && db.kind !== "postgres") continue;
    await db.tx(async (q) => {
      await q.query(m.sql);
      await q.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [m.id, Date.now()]);
    });
    applied.push(m.id);
  }
  return applied;
}
