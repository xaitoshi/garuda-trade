import { newDb } from "pg-mem";
import type pg from "pg";
import { wrapPool, type Db } from "./db.js";

/**
 * In-process Postgres (pg-mem) for fast tests and local dev without a server.
 * Not a substitute for real Postgres: it has no triggers, so migrations marked `-- pg-only` are skipped.
 */
export function createMemoryDb(): Db {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  return wrapPool(new Pool() as unknown as pg.Pool, "pg-mem");
}
