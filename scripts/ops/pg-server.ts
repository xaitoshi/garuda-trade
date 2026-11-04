/**
 * Long-lived embedded real Postgres for a test deployment (no docker, no system install).
 * Data lives in GARUDA_PG_DIR (default /workspace/garuda-data/pg) and survives restarts. Listens on GARUDA_PG_PORT (default 5433).
 * DATABASE_URL for the API: postgres://garuda:garuda@127.0.0.1:5433/garuda
 */
import { existsSync, mkdirSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const dir = process.env.GARUDA_PG_DIR ?? "/workspace/garuda-data/pg";
const port = Number(process.env.GARUDA_PG_PORT ?? 5433);
mkdirSync(dir, { recursive: true });
const fresh = !existsSync(`${dir}/PG_VERSION`);
const server = new EmbeddedPostgres({ databaseDir: dir, user: "garuda", password: "garuda", port, persistent: true, onLog: () => {}, onError: (e) => console.error("[pg]", e) });
if (fresh) await server.initialise();
await server.start();
if (fresh) await server.createDatabase("garuda");
console.log(`[pg] embedded postgres ready on 127.0.0.1:${port} (data ${dir})`);
const stop = async () => { await server.stop(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => {}, 1 << 30);
