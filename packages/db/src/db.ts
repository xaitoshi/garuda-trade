import pg from "pg";

/** Anything that can run a parameterised query (a pool, a client inside a transaction, or pg-mem's equivalents). */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface Db extends Queryable {
  /** Run `fn` inside BEGIN / COMMIT; ROLLBACK and rethrow on error. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** "postgres" for a real server, "pg-mem" for the in-process test database. */
  readonly kind: "postgres" | "pg-mem";
  close(): Promise<void>;
}

/** Wrap a node-postgres style pool (real `pg.Pool` or the pg-mem adapter's Pool). */
export function wrapPool(pool: pg.Pool, kind: Db["kind"]): Db {
  return {
    kind,
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (text, params) => client.query(text, params as unknown[]) as never });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* connection already broken */
        }
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Connect to a real Postgres via a connection string (DATABASE_URL). */
export function connectPostgres(connectionString: string, opts: { max?: number } = {}): Db {
  // bigint (int8) comes back as a string by default; times and counters here fit comfortably in a double.
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  return wrapPool(pool, "postgres");
}
