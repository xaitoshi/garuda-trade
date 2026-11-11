import type { Queryable } from "@garuda/db";
import type { RoutedPosition, RoutingMode, RoutingOrderRecord, RoutingTrader } from "./types.js";

type Mode = Exclude<RoutingMode, "disabled">;

export interface RoutingStore {
  getTrader(challengeId: string): Promise<RoutingTrader | undefined>;
  listTraders(): Promise<RoutingTrader[]>;
  putTrader(t: RoutingTrader): Promise<void>;
  insertOrder(o: RoutingOrderRecord): Promise<void>;
  updateOrder(id: string, patch: Partial<Pick<RoutingOrderRecord, "status" | "signature" | "error" | "updatedAt">>): Promise<void>;
  listOrders(f?: { challengeId?: string; limit?: number }): Promise<RoutingOrderRecord[]>;
  getPosition(mode: Mode, challengeId: string, symbol: string): Promise<RoutedPosition | undefined>;
  putPosition(p: RoutedPosition): Promise<void>;
  listPositions(mode: Mode): Promise<RoutedPosition[]>;
  getState(key: string): Promise<string | undefined>;
  setState(key: string, value: string, at: number): Promise<void>;
}

export class InMemoryRoutingStore implements RoutingStore {
  traders = new Map<string, RoutingTrader>();
  orders: RoutingOrderRecord[] = [];
  positions = new Map<string, RoutedPosition>();
  state = new Map<string, string>();
  private pk = (m: string, c: string, s: string) => `${m}|${c}|${s}`;
  async getTrader(id: string) { const t = this.traders.get(id); return t ? { ...t } : undefined; }
  async listTraders() { return [...this.traders.values()].map((t) => ({ ...t })); }
  async putTrader(t: RoutingTrader) { this.traders.set(t.challengeId, { ...t }); }
  async insertOrder(o: RoutingOrderRecord) { this.orders.push({ ...o }); }
  async updateOrder(id: string, patch: Partial<RoutingOrderRecord>) {
    const o = this.orders.find((x) => x.id === id);
    if (o) Object.assign(o, patch);
  }
  async listOrders(f: { challengeId?: string; limit?: number } = {}) {
    return this.orders.filter((o) => !f.challengeId || o.challengeId === f.challengeId).slice(-(f.limit ?? 200)).reverse().map((o) => ({ ...o }));
  }
  async getPosition(m: Mode, c: string, s: string) { const p = this.positions.get(this.pk(m, c, s)); return p ? { ...p } : undefined; }
  async putPosition(p: RoutedPosition) { this.positions.set(this.pk(p.mode, p.challengeId, p.symbol), { ...p }); }
  async listPositions(m: Mode) { return [...this.positions.values()].filter((p) => p.mode === m).map((p) => ({ ...p })); }
  async getState(k: string) { return this.state.get(k); }
  async setState(k: string, v: string) { this.state.set(k, v); }
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

/** Postgres (and pg-mem) store over migration 008_routing. */
export class PgRoutingStore implements RoutingStore {
  constructor(private readonly db: Queryable) {}

  private trader(r: Record<string, unknown>): RoutingTrader {
    return {
      challengeId: String(r.challenge_id),
      wallet: opt(r.wallet as string | null),
      enabled: Boolean(r.enabled),
      multiplier: n(r.multiplier),
      note: opt(r.note as string | null),
      updatedAt: Number(r.updated_at),
      updatedBy: String(r.updated_by),
    };
  }

  async getTrader(id: string) {
    const r = await this.db.query("SELECT * FROM routing_traders WHERE challenge_id = $1", [id]);
    return r.rows[0] ? this.trader(r.rows[0]) : undefined;
  }
  async listTraders() {
    return (await this.db.query("SELECT * FROM routing_traders ORDER BY updated_at DESC")).rows.map((r) => this.trader(r));
  }
  async putTrader(t: RoutingTrader) {
    const params = [t.challengeId, t.wallet ?? null, t.enabled, t.multiplier ?? null, t.note ?? null, t.updatedAt, t.updatedBy];
    const up = await this.db.query(
      "UPDATE routing_traders SET wallet = $2, enabled = $3, multiplier = $4, note = $5, updated_at = $6, updated_by = $7 WHERE challenge_id = $1",
      params,
    );
    if (!up.rowCount) {
      await this.db.query(
        "INSERT INTO routing_traders (challenge_id, wallet, enabled, multiplier, note, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        params,
      );
    }
  }

  async insertOrder(o: RoutingOrderRecord) {
    await this.db.query(
      `INSERT INTO routing_orders (id, ts, mode, challenge_id, wallet, symbol, side, size, notional, ref_price, limit_price, book, action, reason, status, signature, error, trigger_fill_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [o.id, o.ts, o.mode, o.challengeId, o.wallet ?? null, o.symbol, o.side ?? null, o.size, o.notional, o.refPrice ?? null, o.limitPrice ?? null, o.book, o.action, o.reason ?? null, o.status, o.signature ?? null, o.error ?? null, o.triggerFillId ?? null, o.updatedAt],
    );
  }
  async updateOrder(id: string, p: Partial<Pick<RoutingOrderRecord, "status" | "signature" | "error" | "updatedAt">>) {
    await this.db.query(
      "UPDATE routing_orders SET status = COALESCE($2, status), signature = COALESCE($3, signature), error = COALESCE($4, error), updated_at = COALESCE($5, updated_at) WHERE id = $1",
      [id, p.status ?? null, p.signature ?? null, p.error ?? null, p.updatedAt ?? null],
    );
  }
  async listOrders(f: { challengeId?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, f.limit ?? 200), 1000);
    const r = f.challengeId
      ? await this.db.query("SELECT * FROM routing_orders WHERE challenge_id = $1 ORDER BY ts DESC LIMIT $2", [f.challengeId, limit])
      : await this.db.query("SELECT * FROM routing_orders ORDER BY ts DESC LIMIT $1", [limit]);
    return r.rows.map(
      (x): RoutingOrderRecord => ({
        id: String(x.id),
        ts: Number(x.ts),
        mode: x.mode as Mode,
        challengeId: String(x.challenge_id),
        wallet: opt(x.wallet as string | null),
        symbol: String(x.symbol),
        side: opt(x.side as "buy" | "sell" | null),
        size: Number(x.size),
        notional: Number(x.notional),
        refPrice: n(x.ref_price),
        limitPrice: n(x.limit_price),
        book: x.book as "A" | "B",
        action: x.action as RoutingOrderRecord["action"],
        reason: opt(x.reason as string | null),
        status: x.status as RoutingOrderRecord["status"],
        signature: opt(x.signature as string | null),
        error: opt(x.error as string | null),
        triggerFillId: opt(x.trigger_fill_id as string | null),
        updatedAt: Number(x.updated_at),
      }),
    );
  }

  private pos(r: Record<string, unknown>): RoutedPosition {
    return { mode: r.mode as Mode, challengeId: String(r.challenge_id), symbol: String(r.symbol), size: Number(r.size), avgPrice: Number(r.avg_price), updatedAt: Number(r.updated_at) };
  }
  async getPosition(m: Mode, c: string, s: string) {
    const r = await this.db.query("SELECT * FROM routing_positions WHERE mode = $1 AND challenge_id = $2 AND symbol = $3", [m, c, s]);
    return r.rows[0] ? this.pos(r.rows[0]) : undefined;
  }
  async putPosition(p: RoutedPosition) {
    const params = [p.mode, p.challengeId, p.symbol, p.size, p.avgPrice, p.updatedAt];
    const up = await this.db.query("UPDATE routing_positions SET size = $4, avg_price = $5, updated_at = $6 WHERE mode = $1 AND challenge_id = $2 AND symbol = $3", params);
    if (!up.rowCount) await this.db.query("INSERT INTO routing_positions (mode, challenge_id, symbol, size, avg_price, updated_at) VALUES ($1,$2,$3,$4,$5,$6)", params);
  }
  async listPositions(m: Mode) {
    return (await this.db.query("SELECT * FROM routing_positions WHERE mode = $1", [m])).rows.map((r) => this.pos(r));
  }
  async getState(k: string) {
    const r = await this.db.query<{ value: string }>("SELECT value FROM routing_state WHERE key = $1", [k]);
    return r.rows[0]?.value;
  }
  async setState(k: string, v: string, at: number) {
    const up = await this.db.query("UPDATE routing_state SET value = $2, updated_at = $3 WHERE key = $1", [k, v, at]);
    if (!up.rowCount) await this.db.query("INSERT INTO routing_state (key, value, updated_at) VALUES ($1, $2, $3)", [k, v, at]);
  }
}
