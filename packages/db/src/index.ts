export * from "./db.js";
export * from "./memory.js";
export * from "./migrate.js";

import { connectPostgres, type Db } from "./db.js";
import { createMemoryDb } from "./memory.js";
import { migrate } from "./migrate.js";

/**
 * Open the database named by DATABASE_URL (real Postgres) or fall back to pg-mem, then migrate.
 * Production must set DATABASE_URL; the in-memory fallback loses everything on restart.
 */
export async function openDb(url: string | undefined = process.env.DATABASE_URL): Promise<Db> {
  const db = url ? connectPostgres(url) : createMemoryDb();
  await migrate(db);
  return db;
}
export * from "./testing.js";
