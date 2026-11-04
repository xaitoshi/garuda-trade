import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { connectPostgres, type Db } from "./db.js";
import { createMemoryDb } from "./memory.js";
import { migrate } from "./migrate.js";

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

let embedded: Promise<{ url: (name: string) => string; stop: () => Promise<void> }> | undefined;
let dbCounter = 0;

/** One embedded real Postgres per test process (GARUDA_TEST_PG=embedded). Binaries come from the `embedded-postgres` devDependency. */
async function embeddedServer() {
  embedded ??= (async () => {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "garuda-pg-"));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const server = new EmbeddedPostgres({ databaseDir: dir, user: "garuda", password: "garuda", port, persistent: false, onLog: () => {}, onError: () => {} });
    await server.initialise();
    await server.start();
    return {
      url: (name: string) => `postgres://garuda:garuda@localhost:${port}/${name}`,
      stop: async () => {
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  })();
  return embedded;
}

export function realPostgresRequested(): boolean {
  return process.env.GARUDA_TEST_PG === "embedded" || Boolean(process.env.GARUDA_TEST_DATABASE_URL);
}

/**
 * A fresh, migrated database for a test.
 *  - default: pg-mem (in-process, fast)
 *  - GARUDA_TEST_PG=embedded: real Postgres started from the embedded-postgres package, one new database per call
 *  - GARUDA_TEST_DATABASE_URL=postgres://...: real Postgres you run yourself (docker compose up -d db); one new database per call
 */
export async function createTestDb(opts: { forceReal?: boolean } = {}): Promise<TestDb> {
  const external = process.env.GARUDA_TEST_DATABASE_URL;
  if (!external && process.env.GARUDA_TEST_PG !== "embedded" && !opts.forceReal) {
    const db = createMemoryDb();
    await migrate(db);
    return { db, close: () => db.close() };
  }
  const name = `garuda_t${process.pid}_${Date.now()}_${dbCounter++}`;
  let adminUrl: string;
  let urlFor: (n: string) => string;
  if (external) {
    adminUrl = external;
    const u = new URL(external);
    urlFor = (n) => {
      const c = new URL(external);
      c.pathname = `/${n}`;
      return c.toString();
    };
    void u;
  } else {
    const server = await embeddedServer();
    adminUrl = server.url("postgres");
    urlFor = server.url;
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const db = connectPostgres(urlFor(name), { max: 4 });
  await migrate(db);
  return { db, close: () => db.close() };
}

/** Stop the shared embedded server (call from afterAll in suites that used it). */
export async function stopEmbeddedPostgres(): Promise<void> {
  if (!embedded) return;
  const s = await embedded;
  embedded = undefined;
  await s.stop();
}
