import type { Db, Queryable } from "@garuda/db";
import {
  RiskMonitor,
  limitsForTier,
  type CombatLogEntry,
  type RiskEvent,
  type RiskMonitorState,
  type Stage,
  type TierId,
  type Lifecycle,
  type ChallengeStatus,
} from "@garuda/risk-engine";
import { SimAccount, type BalanceAdjustment, type Fill, type FundingPayment, type Order } from "@garuda/sim-engine";
import { defaultScaling, type Challenge, type ChallengeStore, type ChallengeSummary, type ReviveRequestRecord, type SummaryFilter } from "./store.js";

type Row = Record<string, any>;
const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

/** What lives in challenges.state (a cache; the ledger tables are the authority for balances and positions). */
interface PersistedState {
  risk: RiskMonitorState;
  marks: Record<string, number>;
  fundingAccruedTo: Record<string, number>;
  fundingRates: Record<string, number>;
  seq: number;
  dataSource?: Challenge["dataSource"];
  scars: number;
  claim?: Challenge["claim"];
  scaling?: Challenge["scaling"];
}

interface Cursor {
  fills: number;
  funding: number;
  adjustments: number;
  risk: number;
  combat: number;
  orders: Map<string, string>;
  row: string;
}

const orderPrint = (o: Order) => `${o.status}|${o.remaining}|${o.updatedAt}|${o.rejectReason ?? ""}`;

/** Postgres (or pg-mem) challenge store: relational ledger, append-only fills/funding/risk events/combat log. */
export class PgChallengeStore implements ChallengeStore {
  private cache = new Map<string, Challenge>();
  private loading = new Map<string, Promise<Challenge | undefined>>();
  private cursors = new WeakMap<Challenge, Cursor>();

  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------------ reads

  async get(id: string): Promise<Challenge | undefined> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const p = this.load(id)
      .then((c) => {
        if (c) this.cache.set(id, c);
        return c;
      })
      .finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  async list(filter: { wallet?: string } = {}): Promise<Challenge[]> {
    const rows = filter.wallet
      ? (await this.db.query<Row>("SELECT id FROM challenges WHERE wallet = $1 ORDER BY created_at, id", [filter.wallet])).rows
      : (await this.db.query<Row>("SELECT id FROM challenges ORDER BY created_at, id")).rows;
    const out: Challenge[] = [];
    for (const r of rows) {
      const c = await this.get(String(r.id));
      if (c) out.push(c);
    }
    return out;
  }

  async summaries(filter: SummaryFilter = {}): Promise<ChallengeSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.wallet !== undefined) where.push(`wallet = $${params.push(filter.wallet)}`);
    if (filter.knightId !== undefined) where.push(`knight_id = $${params.push(filter.knightId)}`);
    if (filter.status !== undefined) where.push(`status = $${params.push(filter.status)}`);
    const sql = `SELECT id, tier, stage, status, lifecycle, wallet, knight_id, starting_balance, funded_level, created_at, breach_at, revive_of, revived_by FROM challenges${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at, id`;
    return (await this.db.query<Row>(sql, params)).rows.map((r) => ({
      id: String(r.id),
      tier: r.tier as TierId,
      stage: r.stage as Stage,
      status: r.status as ChallengeStatus,
      lifecycle: r.lifecycle as Lifecycle,
      wallet: optStr(r.wallet),
      knightId: optStr(r.knight_id),
      size: num(r.starting_balance),
      ...(r.stage === "funded" ? { fundedLevel: optNum(r.funded_level) ?? 1 } : {}),
      createdAt: num(r.created_at),
      breachAt: optNum(r.breach_at),
      reviveOf: optStr(r.revive_of),
      revivedBy: optStr(r.revived_by),
    }));
  }

  async findReviveRequest(key: string): Promise<ReviveRequestRecord | undefined> {
    const r = (await this.db.query<Row>("SELECT * FROM revive_requests WHERE idempotency_key = $1", [key])).rows[0];
    return r
      ? { idempotencyKey: String(r.idempotency_key), wallet: String(r.wallet), sourceChallengeId: String(r.source_challenge_id), newChallengeId: String(r.new_challenge_id), createdAt: num(r.created_at) }
      : undefined;
  }

  async saveReviveRequest(r: ReviveRequestRecord): Promise<void> {
    await this.db.query(
      "INSERT INTO revive_requests (idempotency_key, wallet, source_challenge_id, new_challenge_id, created_at) VALUES ($1, $2, $3, $4, $5)",
      [r.idempotencyKey, r.wallet, r.sourceChallengeId, r.newChallengeId, r.createdAt],
    );
  }

  // ------------------------------------------------------------------ writes

  async save(c: Challenge): Promise<void> {
    const cur = this.cursors.get(c);
    const prev: Cursor = cur ?? { fills: 0, funding: 0, adjustments: 0, risk: 0, combat: 0, orders: new Map(), row: "" };
    const state: PersistedState = {
      risk: structuredClone(c.risk.state) as RiskMonitorState,
      marks: Object.fromEntries(c.account.marks),
      fundingAccruedTo: Object.fromEntries(c.account.fundingAccruedTo),
      fundingRates: Object.fromEntries(c.fundingRates),
      seq: c.account.seq,
      dataSource: c.dataSource,
      scars: c.scars,
      ...(c.claim ? { claim: c.claim } : {}),
      ...(c.scaling ? { scaling: c.scaling } : {}),
    };
    const row = {
      id: c.id,
      tier: c.tier,
      stage: c.stage,
      knight: c.knight,
      knight_id: c.knightId ?? null,
      wallet: c.wallet ?? null,
      created_at: c.createdAt,
      starting_balance: c.account.startingBalance,
      funded_level: c.stage === "funded" ? (c.scaling?.level ?? 1) : null,
      status: c.risk.status,
      lifecycle: c.lifecycle,
      last_activity_at: c.lastActivityAt,
      dormant_since: c.dormantSince ?? null,
      archived_at: c.archivedAt ?? null,
      breach_at: c.breachAt ?? null,
      revive_of: c.reviveOf ?? null,
      revived_by: c.revivedBy ?? null,
      revive_fee_usd: c.reviveFeeUsd ?? null,
      payment_ref: c.paymentRef ?? null,
      balance: c.account.balance,
      state: JSON.stringify(state),
    };
    const rowKey = JSON.stringify(row);

    const fills = c.account.fills.slice(prev.fills);
    const funding = c.account.fundingPayments.slice(prev.funding);
    const adjustments = c.account.adjustments.slice(prev.adjustments);
    const risk = c.riskEvents.slice(prev.risk);
    const combat = c.combatLog.slice(prev.combat);
    const orders = [...c.account.orders.values()].filter((o) => prev.orders.get(o.id) !== orderPrint(o));
    if (cur && rowKey === prev.row && !fills.length && !funding.length && !adjustments.length && !risk.length && !combat.length && !orders.length) return;

    const now = Date.now();
    await this.db.tx(async (q) => {
      await upsertChallenge(q, row, now);
      for (const o of orders) await upsertOrder(q, c.id, o);
      for (const [i, f] of fills.entries()) await insertFill(q, c.id, prev.fills + i, f);
      for (const [i, p] of funding.entries()) await insertFunding(q, c.id, prev.funding + i, p);
      for (const [i, a] of adjustments.entries()) await insertAdjustment(q, c.id, prev.adjustments + i, a);
      for (const [i, e] of risk.entries()) {
        await q.query("INSERT INTO risk_events (challenge_id, seq, type, ts, data) VALUES ($1, $2, $3, $4, $5)", [c.id, prev.risk + i, e.type, e.ts, JSON.stringify(e)]);
      }
      for (const [i, e] of combat.entries()) {
        await q.query("INSERT INTO combat_log (challenge_id, seq, kind, ts, amount, text) VALUES ($1, $2, $3, $4, $5, $6)", [c.id, prev.combat + i, e.kind, e.ts, e.amount ?? null, e.text]);
      }
    });
    // Advance cursors only after the transaction committed.
    const next: Cursor = {
      fills: c.account.fills.length,
      funding: c.account.fundingPayments.length,
      adjustments: c.account.adjustments.length,
      risk: c.riskEvents.length,
      combat: c.combatLog.length,
      orders: new Map([...prev.orders, ...orders.map((o) => [o.id, orderPrint(o)] as const)]),
      row: rowKey,
    };
    this.cursors.set(c, next);
    this.cache.set(c.id, c);
  }

  // ------------------------------------------------------------------- load

  private async readLedger(q: Queryable, id: string) {
    const [orders, fills, funding, adjustments, risk, combat] = await Promise.all([
      q.query<Row>("SELECT * FROM orders WHERE challenge_id = $1 ORDER BY created_at, id", [id]),
      q.query<Row>("SELECT * FROM fills WHERE challenge_id = $1 ORDER BY seq", [id]),
      q.query<Row>("SELECT * FROM funding_payments WHERE challenge_id = $1 ORDER BY seq", [id]),
      q.query<Row>("SELECT * FROM balance_adjustments WHERE challenge_id = $1 ORDER BY seq", [id]),
      q.query<Row>("SELECT * FROM risk_events WHERE challenge_id = $1 ORDER BY seq", [id]),
      q.query<Row>("SELECT * FROM combat_log WHERE challenge_id = $1 ORDER BY seq", [id]),
    ]);
    return {
      orders: orders.rows.map(rowToOrder),
      fills: fills.rows.map(rowToFill),
      funding: funding.rows.map(rowToFunding),
      adjustments: adjustments.rows.map(rowToAdjustment),
      risk: risk.rows.map((r) => json<RiskEvent>(r.data)),
      combat: combat.rows.map((r) => ({ ts: num(r.ts), kind: r.kind, text: String(r.text), amount: optNum(r.amount) }) as CombatLogEntry),
    };
  }

  private async load(id: string): Promise<Challenge | undefined> {
    const row = (await this.db.query<Row>("SELECT * FROM challenges WHERE id = $1", [id])).rows[0];
    if (!row) return undefined;
    const ledger = await this.readLedger(this.db, id);
    const state = json<PersistedState>(row.state);
    const tier = row.tier as TierId;
    const stage = row.stage as Stage;
    const account = SimAccount.restore({
      id,
      // starting_balance is the CURRENT size; the replay starts from the opening size and the level_up adjustments
      // bring it back to the current one.
      startingBalance: openingSize(num(row.starting_balance), ledger.adjustments),
      orders: ledger.orders,
      fills: ledger.fills,
      fundingPayments: ledger.funding,
      adjustments: ledger.adjustments,
      marks: state.marks,
      fundingAccruedTo: state.fundingAccruedTo,
      seq: state.seq,
    });
    const c: Challenge = {
      id,
      tier,
      stage,
      knight: String(row.knight),
      knightId: optStr(row.knight_id),
      wallet: optStr(row.wallet),
      createdAt: num(row.created_at),
      lifecycle: row.lifecycle as Lifecycle,
      lastActivityAt: num(row.last_activity_at),
      dormantSince: optNum(row.dormant_since),
      archivedAt: optNum(row.archived_at),
      breachAt: optNum(row.breach_at),
      reviveOf: optStr(row.revive_of),
      revivedBy: optStr(row.revived_by),
      scars: state.scars ?? 0,
      claim: state.claim,
      // Funded accounts opened before Funded scaling are Lv.1 of their tier, counted from their opening.
      scaling: stage === "funded" ? (state.scaling ?? defaultScaling(num(row.created_at))) : undefined,
      reviveFeeUsd: optNum(row.revive_fee_usd),
      paymentRef: optStr(row.payment_ref),
      account,
      risk: new RiskMonitor({ limits: limitsForTier(tier, stage, num(row.starting_balance)), createdAt: num(row.created_at), restore: state.risk }),
      combatLog: ledger.combat,
      riskEvents: ledger.risk,
      books: new Map(),
      fundingRates: new Map(Object.entries(state.fundingRates ?? {})),
      dataSource: state.dataSource,
      queue: Promise.resolve(),
    };
    this.cursors.set(c, {
      fills: ledger.fills.length,
      funding: ledger.funding.length,
      adjustments: ledger.adjustments.length,
      risk: ledger.risk.length,
      combat: ledger.combat.length,
      orders: new Map(ledger.orders.map((o) => [o.id, orderPrint(o)])),
      // Force the first save after a load to rewrite the row only if something changed.
      row: "",
    });
    return c;
  }

  /** Drop a challenge from the in-process cache (the next get() reloads it from the database). */
  evict(id: string): void {
    this.cache.delete(id);
  }

  /**
   * Audit: rebuild balance and positions from the ledger tables alone and compare with the cached balance on the
   * challenge row. `ok` when they agree to within `tolerance` USD (floating-point summation order only).
   */
  async verifyLedger(id: string, tolerance = 1e-6): Promise<{ ok: boolean; storedBalance: number; replayedBalance: number; diff: number; fills: number } | undefined> {
    const row = (await this.db.query<Row>("SELECT starting_balance, balance FROM challenges WHERE id = $1", [id])).rows[0];
    if (!row) return undefined;
    const ledger = await this.readLedger(this.db, id);
    const acct = SimAccount.restore({ id, startingBalance: openingSize(num(row.starting_balance), ledger.adjustments), orders: ledger.orders, fills: ledger.fills, fundingPayments: ledger.funding, adjustments: ledger.adjustments });
    const diff = Math.abs(acct.balance - num(row.balance));
    return { ok: diff <= tolerance, storedBalance: num(row.balance), replayedBalance: acct.balance, diff, fills: ledger.fills.length };
  }
}

/** Opening size of an account: the current size minus every funded level-up step recorded in the ledger. */
const openingSize = (current: number, adjustments: readonly BalanceAdjustment[]): number =>
  adjustments.reduce((s, a) => (a.kind === "level_up" ? s - a.amount : s), current);

// ------------------------------------------------------------------ row mapping

async function upsertChallenge(q: Queryable, r: Record<string, unknown>, now: number) {
  const cols = Object.keys(r);
  const params = cols.map((k) => r[k]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((k) => k !== "id" && k !== "created_at").map((k) => `${k} = EXCLUDED.${k}`);
  await q.query(
    `INSERT INTO challenges (${cols.join(", ")}, updated_at) VALUES (${placeholders.join(", ")}, $${cols.length + 1})
     ON CONFLICT (id) DO UPDATE SET ${updates.join(", ")}, updated_at = EXCLUDED.updated_at`,
    [...params, now],
  );
}

async function upsertOrder(q: Queryable, challengeId: string, o: Order) {
  await q.query(
    `INSERT INTO orders (challenge_id, id, symbol, side, type, size, remaining, limit_price, reduce_only, post_only, status, reject_reason, created_at, updated_at, take_profit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (challenge_id, id) DO UPDATE SET remaining = EXCLUDED.remaining, status = EXCLUDED.status, reject_reason = EXCLUDED.reject_reason, updated_at = EXCLUDED.updated_at`,
    [challengeId, o.id, o.symbol, o.side, o.type, o.size, o.remaining, o.limitPrice ?? null, o.reduceOnly, o.postOnly, o.status, o.rejectReason ?? null, o.createdAt, o.updatedAt, o.takeProfit ?? null],
  );
}

async function insertFill(q: Queryable, challengeId: string, seq: number, f: Fill) {
  await q.query(
    `INSERT INTO fills (challenge_id, seq, id, order_id, symbol, side, price, size, notional, fee, liquidity, realized_pnl, closed_size, closed_direction, position_after, forced, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [challengeId, seq, f.id, f.orderId, f.symbol, f.side, f.price, f.size, f.notional, f.fee, f.liquidity, f.realizedPnl, f.closedSize, f.closedDirection ?? null, f.positionAfter, f.forced, f.ts],
  );
}

async function insertFunding(q: Queryable, challengeId: string, seq: number, p: FundingPayment) {
  await q.query(
    "INSERT INTO funding_payments (challenge_id, seq, symbol, amount, rate_hourly, mark_price, position_size, ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [challengeId, seq, p.symbol, p.amount, p.rateHourly, p.markPrice, p.positionSize, p.ts],
  );
}

async function insertAdjustment(q: Queryable, challengeId: string, seq: number, a: BalanceAdjustment) {
  await q.query("INSERT INTO balance_adjustments (challenge_id, seq, id, kind, amount, ref, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)", [challengeId, seq, a.id, a.kind, a.amount, a.ref, a.ts]);
}

const rowToAdjustment = (r: Row): BalanceAdjustment => ({ id: String(r.id), kind: r.kind, amount: num(r.amount), ref: String(r.ref), ts: num(r.ts) });

const rowToOrder = (r: Row): Order => ({
  id: String(r.id),
  symbol: String(r.symbol),
  side: r.side,
  type: r.type,
  size: num(r.size),
  remaining: num(r.remaining),
  limitPrice: optNum(r.limit_price),
  reduceOnly: Boolean(r.reduce_only),
  postOnly: Boolean(r.post_only),
  status: r.status,
  rejectReason: optStr(r.reject_reason),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
  ...(r.take_profit != null ? { takeProfit: num(r.take_profit) } : {}),
});

const rowToFill = (r: Row): Fill => ({
  id: String(r.id),
  orderId: String(r.order_id),
  symbol: String(r.symbol),
  side: r.side,
  price: num(r.price),
  size: num(r.size),
  notional: num(r.notional),
  fee: num(r.fee),
  liquidity: r.liquidity,
  realizedPnl: num(r.realized_pnl),
  closedSize: num(r.closed_size),
  closedDirection: (optStr(r.closed_direction) as Fill["closedDirection"]) ?? undefined,
  positionAfter: num(r.position_after),
  forced: Boolean(r.forced),
  ts: num(r.ts),
});

const rowToFunding = (r: Row): FundingPayment => ({
  symbol: String(r.symbol),
  amount: num(r.amount),
  rateHourly: num(r.rate_hourly),
  markPrice: num(r.mark_price),
  positionSize: num(r.position_size),
  ts: num(r.ts),
});
