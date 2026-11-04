import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@garuda/db";
import { PayoutChainError, usdToBaseUnits, type PayoutExecutor } from "@garuda/chain";
import type { PayoutPolicy } from "@garuda/risk-engine";
import { base58Decode } from "./base58.js";
import { ServiceError, floorCents, type ChallengeService } from "./service.js";

/**
 * Payout execution (M8). The flow, in the order money and state move:
 *
 *   request     trader asks. Quote and rules are re-checked under the account lock, the payout record is written, the
 *               profit is SWEPT out of the account balance (balance resets to the starting balance, section 11) and the
 *               payout is `approved` (share up to the auto-approve ceiling) or `pending_approval` (above it).
 *   approve     an admin releases a pending payout.  reject: an admin declines it and the profit is given back.
 *   execute     the executor sends the USDC from the treasury: `sending` -> `paid`. A multisig executor answers with a
 *               proposal instead: `submitted` until the signers execute it.
 *   reconcile   a loop (and the startup pass) retries what failed, finishes a debit a crash interrupted, and looks up
 *               payouts whose outcome was never recorded. Everything in it is idempotent.
 *
 * Why the profit is swept at request time rather than when the USDC lands: it closes the double-spend window. While a
 * payout is in flight the account cannot trade the same profit away and ask again (and the database allows one open
 * payout per account). If the payout is rejected the sweep is reversed by a second ledger entry; nothing is ever
 * edited in place: `payout_ledger` and `balance_adjustments` are append-only.
 */
export type PayoutStatus = "pending_approval" | "approved" | "sending" | "submitted" | "paid" | "rejected" | "failed";

/** Everything that is not finished: at most one of these per account (rulebook section 11, one request in flight). */
export const OPEN_PAYOUT_STATUSES: PayoutStatus[] = ["pending_approval", "approved", "sending", "submitted", "failed"];
export const isOpenPayout = (s: PayoutStatus) => OPEN_PAYOUT_STATUSES.includes(s);

export interface Payout {
  id: string;
  challengeId: string;
  /** Destination: the signed-in wallet that requested it. */
  wallet: string;
  status: PayoutStatus;
  /** Profit taken out of the account balance. */
  sweepUsd: number;
  /** What the trader receives (their share, rounded down to the cent). */
  amountUsd: number;
  amountBaseUnits: string;
  firmShareUsd: number;
  /** Policy in force when it was requested. */
  split: number;
  autoMaxUsd: number;
  autoApproved: boolean;
  /** True once the sweep is recorded on the account ledger. Nothing is sent before this. */
  debited: boolean;
  idempotencyKey?: string;
  executor: string;
  attempts: number;
  nextAttemptAt?: number;
  /** Start of the current send. A `sending` payout older than the lease is treated as a crashed attempt. */
  sendingSince?: number;
  lastError?: string;
  lastErrorCode?: string;
  signature?: string;
  proposalId?: string;
  approvedBy?: string;
  approvedAt?: number;
  rejectedReason?: string;
  rejectedBy?: string;
  rejectedAt?: number;
  paidAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type PayoutEventType =
  | "requested"
  | "debited"
  | "approved"
  | "attempt"
  | "attempt_failed"
  | "submitted"
  | "paid"
  | "rejected"
  | "reversed"
  | "gave_up"
  | "retry";

export interface PayoutEvent {
  payoutId: string;
  seq: number;
  type: PayoutEventType;
  ts: number;
  data: Record<string, unknown>;
}

export type NewPayoutEvent = Omit<PayoutEvent, "seq" | "payoutId">;

export interface PayoutListFilter {
  wallet?: string;
  challengeId?: string;
  status?: PayoutStatus[];
  limit?: number;
}

export interface PayoutStore {
  get(id: string): Promise<Payout | undefined>;
  /**
   * Insert a new payout and its first event atomically. An existing payout under the same (wallet, idempotency key)
   * is returned with `created: false`. Throws ServiceError 409 `payout_in_flight` when the account already has an
   * open payout, and 409 `idempotency_key_reused` when the key belongs to another account.
   */
  create(p: Payout, ev: NewPayoutEvent): Promise<{ payout: Payout; created: boolean }>;
  /** Replace the payout row and append events, atomically. */
  update(p: Payout, events?: NewPayoutEvent[]): Promise<void>;
  findByIdempotency(wallet: string, key: string): Promise<Payout | undefined>;
  findOpen(challengeId: string): Promise<Payout | undefined>;
  list(filter?: PayoutListFilter): Promise<Payout[]>;
  events(payoutId: string): Promise<PayoutEvent[]>;
}

const inFlight = (p: Payout) => new ServiceError(409, "payout_in_flight", "This account already has a payout in flight", { payoutId: p.id, status: p.status });
const keyReused = () => new ServiceError(409, "idempotency_key_reused", "This Idempotency-Key was used for a different account");

export class InMemoryPayoutStore implements PayoutStore {
  private rows = new Map<string, Payout>();
  private ev = new Map<string, PayoutEvent[]>();

  async get(id: string) {
    const p = this.rows.get(id);
    return p && structuredClone(p);
  }
  async findByIdempotency(wallet: string, key: string) {
    for (const p of this.rows.values()) if (p.wallet === wallet && p.idempotencyKey === key) return structuredClone(p);
    return undefined;
  }
  async findOpen(challengeId: string) {
    for (const p of this.rows.values()) if (p.challengeId === challengeId && isOpenPayout(p.status)) return structuredClone(p);
    return undefined;
  }
  async create(p: Payout, ev: NewPayoutEvent) {
    if (p.idempotencyKey) {
      const prior = await this.findByIdempotency(p.wallet, p.idempotencyKey);
      if (prior) {
        if (prior.challengeId !== p.challengeId) throw keyReused();
        return { payout: prior, created: false };
      }
    }
    const open = await this.findOpen(p.challengeId);
    if (open) throw inFlight(open);
    this.rows.set(p.id, structuredClone(p));
    this.ev.set(p.id, [{ ...structuredClone(ev), payoutId: p.id, seq: 0 }]);
    return { payout: structuredClone(p), created: true };
  }
  async update(p: Payout, events: NewPayoutEvent[] = []) {
    if (!this.rows.has(p.id)) throw new Error(`payout ${p.id} not found`);
    this.rows.set(p.id, structuredClone(p));
    const list = this.ev.get(p.id)!;
    for (const e of events) list.push({ ...structuredClone(e), payoutId: p.id, seq: list.length });
  }
  async list(f: PayoutListFilter = {}) {
    const out = [...this.rows.values()]
      .filter((p) => (f.wallet === undefined || p.wallet === f.wallet) && (f.challengeId === undefined || p.challengeId === f.challengeId) && (!f.status || f.status.includes(p.status)))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return out.slice(0, f.limit ?? 200).map((p) => structuredClone(p));
  }
  async events(payoutId: string) {
    return structuredClone(this.ev.get(payoutId) ?? []);
  }
}

export class PgPayoutStore implements PayoutStore {
  constructor(private readonly db: Db) {}

  private static parse(r: Record<string, any>): Payout {
    return JSON.parse(String(r.data)) as Payout;
  }

  private cols(p: Payout): unknown[] {
    return [p.id, p.challengeId, p.wallet, p.status, isOpenPayout(p.status) ? p.challengeId : null, p.idempotencyKey ?? null, p.amountBaseUnits, p.nextAttemptAt ?? null, JSON.stringify(p), p.createdAt, p.updatedAt];
  }

  private async appendEvents(q: Queryable, payoutId: string, events: NewPayoutEvent[]) {
    if (!events.length) return;
    const next = Number((await q.query<{ n: string | number }>("SELECT COALESCE(MAX(seq) + 1, 0) AS n FROM payout_ledger WHERE payout_id = $1", [payoutId])).rows[0]?.n ?? 0);
    for (const [i, e] of events.entries()) {
      await q.query("INSERT INTO payout_ledger (payout_id, seq, type, ts, data) VALUES ($1, $2, $3, $4, $5)", [payoutId, next + i, e.type, e.ts, JSON.stringify(e.data)]);
    }
  }

  async get(id: string) {
    const r = (await this.db.query<Record<string, any>>("SELECT data FROM payouts WHERE id = $1", [id])).rows[0];
    return r ? PgPayoutStore.parse(r) : undefined;
  }
  async findByIdempotency(wallet: string, key: string) {
    const r = (await this.db.query<Record<string, any>>("SELECT data FROM payouts WHERE wallet = $1 AND idempotency_key = $2", [wallet, key])).rows[0];
    return r ? PgPayoutStore.parse(r) : undefined;
  }
  async findOpen(challengeId: string) {
    const r = (await this.db.query<Record<string, any>>("SELECT data FROM payouts WHERE open_key = $1", [challengeId])).rows[0];
    return r ? PgPayoutStore.parse(r) : undefined;
  }
  async create(p: Payout, ev: NewPayoutEvent) {
    const resolve = async (): Promise<{ payout: Payout; created: boolean } | undefined> => {
      if (p.idempotencyKey) {
        const prior = await this.findByIdempotency(p.wallet, p.idempotencyKey);
        if (prior) {
          if (prior.challengeId !== p.challengeId) throw keyReused();
          return { payout: prior, created: false };
        }
      }
      const open = await this.findOpen(p.challengeId);
      if (open) throw inFlight(open);
      return undefined;
    };
    const early = await resolve();
    if (early) return early;
    try {
      await this.db.tx(async (q) => {
        await q.query(
          `INSERT INTO payouts (id, challenge_id, wallet, status, open_key, idempotency_key, amount_base_units, next_attempt_at, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          this.cols(p),
        );
        await this.appendEvents(q, p.id, [ev]);
      });
    } catch (e) {
      // A concurrent request won the unique index: report it the way the pre-check would have.
      if (/unique|duplicate/i.test((e as Error).message)) {
        const again = await resolve();
        if (again) return again;
      }
      throw e;
    }
    return { payout: structuredClone(p), created: true };
  }
  async update(p: Payout, events: NewPayoutEvent[] = []) {
    await this.db.tx(async (q) => {
      const c = this.cols(p);
      await q.query("UPDATE payouts SET status = $1, open_key = $2, next_attempt_at = $3, data = $4, updated_at = $5 WHERE id = $6", [c[3], c[4], c[7], c[8], c[10], p.id]);
      await this.appendEvents(q, p.id, events);
    });
  }
  async list(f: PayoutListFilter = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.wallet !== undefined) where.push(`wallet = $${params.push(f.wallet)}`);
    if (f.challengeId !== undefined) where.push(`challenge_id = $${params.push(f.challengeId)}`);
    if (f.status?.length) where.push(`status IN (${f.status.map((s) => `$${params.push(s)}`).join(", ")})`);
    const limit = Math.max(1, Math.min(f.limit ?? 200, 1000));
    const rows = (await this.db.query<Record<string, any>>(`SELECT data FROM payouts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params)).rows;
    return rows.map(PgPayoutStore.parse);
  }
  async events(payoutId: string) {
    const rows = (await this.db.query<Record<string, any>>("SELECT * FROM payout_ledger WHERE payout_id = $1 ORDER BY seq", [payoutId])).rows;
    return rows.map((r) => ({ payoutId, seq: Number(r.seq), type: r.type as PayoutEventType, ts: Number(r.ts), data: typeof r.data === "string" ? JSON.parse(r.data) : r.data }));
  }
}

export interface RetryPolicy {
  /** First retry delay; doubles each attempt up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** Failed attempts before the payout parks as `failed` for an admin. */
  maxAttempts: number;
  /**
   * How long a `sending` payout is left alone. A send that errored or crashed may still land until its blockhash
   * expires (about 90 seconds on Solana), so nothing is re-sent earlier than this. 180s covers it with margin.
   */
  leaseMs: number;
  /** How often a submitted multisig proposal is polled. */
  pollMs: number;
  /** Wait between checks while the treasury cannot cover a payout (does not use up attempts). */
  treasuryWaitMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 30_000, maxMs: 900_000, maxAttempts: 10, leaseMs: 180_000, pollMs: 15_000, treasuryWaitMs: 60_000 };

export interface PayoutServiceOptions {
  service: ChallengeService;
  store?: PayoutStore;
  executor: PayoutExecutor;
  policy?: PayoutPolicy;
  now?: () => number;
  retry?: Partial<RetryPolicy>;
  /** Called with errors from background execution (they are also recorded on the payout). */
  onError?: (e: unknown, ctx: string) => void;
}

export interface RequestPayoutInput {
  /** Authenticated wallet (undefined in open dev mode). */
  actorWallet?: string;
  idempotencyKey?: string;
}

export interface PayoutView {
  id: string;
  challengeId: string;
  status: PayoutStatus;
  /** Where the USDC goes. */
  destination: string;
  /** What the trader receives. */
  amountUsd: number;
  grossProfitUsd: number;
  firmShareUsd: number;
  split: number;
  /** Waiting for an admin (share above the auto-approve ceiling). */
  needsApproval: boolean;
  /** Treasury short of USDC or the network is struggling: it will be retried, nothing for the trader to do. */
  delayed: boolean;
  signature?: string;
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
  paidAt?: number;
  replayed?: boolean;
}

export const payoutView = (p: Payout, extra: { replayed?: boolean } = {}): PayoutView => ({
  id: p.id,
  challengeId: p.challengeId,
  status: p.status,
  destination: p.wallet,
  amountUsd: p.amountUsd,
  grossProfitUsd: p.sweepUsd,
  firmShareUsd: p.firmShareUsd,
  split: p.split,
  needsApproval: p.status === "pending_approval",
  delayed: (p.status === "approved" || p.status === "sending") && p.attempts > 0 && p.lastError !== undefined,
  signature: p.signature,
  rejectedReason: p.rejectedReason,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  paidAt: p.paidAt,
  ...(extra.replayed ? { replayed: true } : {}),
});

const isSolanaAddress = (a: string): boolean => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  return base58Decode(a)?.length === 32;
};

export class PayoutService {
  readonly executor: PayoutExecutor;
  readonly store: PayoutStore;
  readonly policy: PayoutPolicy;
  readonly retry: RetryPolicy;
  private readonly svc: ChallengeService;
  private readonly now: () => number;
  private readonly onError: (e: unknown, ctx: string) => void;
  private chains = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<unknown>>();

  constructor(o: PayoutServiceOptions) {
    this.svc = o.service;
    this.store = o.store ?? new InMemoryPayoutStore();
    this.executor = o.executor;
    this.policy = o.policy ?? o.service.payoutPolicy;
    this.now = o.now ?? Date.now;
    this.retry = { ...DEFAULT_RETRY, ...o.retry };
    this.onError = o.onError ?? ((e, ctx) => console.error(`[payouts] ${ctx}:`, e instanceof Error ? e.message : e));
  }

  // ----------------------------------------------------------- user surface

  /**
   * Request a payout of the account's full profit to the signed-in wallet. Idempotent per (wallet, Idempotency-Key):
   * a repeat returns the original payout with `replayed: true` and does nothing else. Without a key, a second request
   * while one is open is refused (409 `payout_in_flight`).
   */
  async request(challengeId: string, input: RequestPayoutInput): Promise<PayoutView> {
    const key = input.idempotencyKey?.trim() || undefined;
    if (key && !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw new ServiceError(400, "bad_idempotency_key", "Idempotency-Key must be 8 to 128 characters of A-Z a-z 0-9 _ . : -");
    if (input.actorWallet && !isSolanaAddress(input.actorWallet)) throw new ServiceError(400, "bad_destination", "The signed-in wallet is not a Solana address");
    // Replay and in-flight checks first: they must answer the same way even after the account's profit is gone.
    if (key && input.actorWallet) {
      const prior = await this.store.findByIdempotency(input.actorWallet, key);
      if (prior) {
        if (prior.challengeId !== challengeId) throw new ServiceError(409, "idempotency_key_reused", "This Idempotency-Key was used for a different account");
        return payoutView(prior, { replayed: true });
      }
    }
    const open = await this.store.findOpen(challengeId);
    if (open) throw new ServiceError(409, "payout_in_flight", "This account already has a payout in flight", { payoutId: open.id, status: open.status });

    const made = await this.svc.payoutReserve<{ id: string; replayed?: boolean; payout: Payout }>(challengeId, input.actorWallet, {
      create: async (q) => {
        if (!isSolanaAddress(q.destination)) throw new ServiceError(400, "bad_destination", "The payout destination is not a Solana address");
        const t = this.now();
        const amountUsd = floorCents(q.traderShare);
        const autoApproved = amountUsd <= this.policy.autoMaxUsd;
        const p: Payout = {
          id: `po_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          challengeId,
          wallet: q.destination,
          status: autoApproved ? "approved" : "pending_approval",
          sweepUsd: q.sweepUsd,
          amountUsd,
          amountBaseUnits: usdToBaseUnits(amountUsd, this.executor.decimals).toString(),
          firmShareUsd: q.sweepUsd - amountUsd,
          split: this.policy.split,
          autoMaxUsd: this.policy.autoMaxUsd,
          autoApproved,
          debited: false,
          idempotencyKey: key,
          executor: this.executor.name,
          attempts: 0,
          approvedBy: autoApproved ? "auto" : undefined,
          approvedAt: autoApproved ? t : undefined,
          createdAt: t,
          updatedAt: t,
        };
        const { payout, created } = await this.store.create(p, {
          type: "requested",
          ts: t,
          data: { amountUsd, sweepUsd: q.sweepUsd, split: this.policy.split, autoMaxUsd: this.policy.autoMaxUsd, autoApproved, destination: q.destination, executor: this.executor.name },
        });
        return { id: payout.id, replayed: !created, payout };
      },
      debited: async (c) => {
        const t = this.now();
        const p = { ...c.payout, debited: true, updatedAt: t };
        await this.store.update(p, [{ type: "debited", ts: t, data: { sweepUsd: p.sweepUsd, adjustment: `payout_sweep:${p.id}` } }, ...(p.autoApproved ? [{ type: "approved" as const, ts: t, data: { by: "auto" } }] : [])]);
        return { ...c, payout: p };
      },
    });
    if (made.payout.status === "approved" && !made.replayed) this.kick(made.id);
    return payoutView(made.payout, { replayed: made.replayed });
  }

  async get(id: string): Promise<Payout> {
    const p = await this.store.get(id);
    if (!p) throw new ServiceError(404, "payout_not_found");
    return p;
  }

  list(filter: PayoutListFilter = {}): Promise<Payout[]> {
    return this.store.list(filter);
  }

  // ---------------------------------------------------------- admin surface

  /** Release a payout that was waiting for approval. Idempotent. */
  async approve(id: string, actor = "admin"): Promise<Payout> {
    const p = await this.chain(id, async () => {
      const p = await this.get(id);
      if (p.status !== "pending_approval") {
        if (p.status === "rejected" || p.status === "failed") throw new ServiceError(409, "payout_not_approvable", `A ${p.status} payout cannot be approved`);
        return p; // already approved, in flight, or paid
      }
      const t = this.now();
      const next: Payout = { ...p, status: "approved", approvedBy: actor, approvedAt: t, nextAttemptAt: t, updatedAt: t };
      await this.store.update(next, [{ type: "approved", ts: t, data: { by: actor } }]);
      return next;
    });
    this.kick(id);
    return p;
  }

  /**
   * Decline a payout that has not been paid: the profit is returned to the account balance (a reversal entry in the
   * ledger). Refuses when money may already be on its way: it asks the executor first and, if the transfer exists,
   * records it as paid instead and answers 409 `already_paid`.
   */
  async reject(id: string, reason: string, actor = "admin"): Promise<Payout> {
    const why = reason?.trim();
    if (!why) throw new ServiceError(400, "reason_required", "Say why the payout is rejected");
    return this.chain(id, async () => {
      let p = await this.get(id);
      if (p.status === "rejected") return p;
      if (p.status === "paid") throw new ServiceError(409, "already_paid", "This payout has been paid", { signature: p.signature });
      if (p.status === "sending" && this.now() - (p.sendingSince ?? 0) < this.retry.leaseMs) throw new ServiceError(409, "payout_sending", "A transfer is being sent right now; try again in a few minutes");
      if (p.status === "submitted") {
        const found = await this.safeLookup(p);
        if (found?.kind === "paid") {
          await this.markPaid(p, found.signature, true);
          throw new ServiceError(409, "already_paid", "This payout has been paid", { signature: found.signature });
        }
        throw new ServiceError(409, "proposal_outstanding", "A multisig proposal is outstanding for this payout; cancel it in the multisig first");
      }
      if (p.attempts > 0) {
        // An attempt may have landed without being recorded. Ask the chain before giving the money back.
        const found = await this.executor.status(this.req(p)).catch((e) => {
          throw new ServiceError(502, "cannot_confirm_chain_state", `Could not confirm on chain that nothing was sent: ${(e as Error).message}`);
        });
        if (found.kind === "paid") {
          await this.markPaid(p, found.signature, true);
          throw new ServiceError(409, "already_paid", "A transfer for this payout is already on chain", { signature: found.signature });
        }
        if (found.kind === "pending") throw new ServiceError(409, "proposal_outstanding", "A multisig proposal is outstanding for this payout");
      }
      const t = this.now();
      const reversed = await this.svc.payoutReverse(p.challengeId, p.id, p.sweepUsd);
      p = { ...p, status: "rejected", rejectedReason: why, rejectedBy: actor, rejectedAt: t, nextAttemptAt: undefined, updatedAt: t };
      await this.store.update(p, [
        { type: "rejected", ts: t, data: { by: actor, reason: why } },
        ...(reversed ? [{ type: "reversed" as const, ts: t, data: { sweepUsd: p.sweepUsd, adjustment: `payout_reversal:${p.id}` } }] : []),
      ]);
      return p;
    });
  }

  /** Put a `failed` payout (or one waiting out a backoff) back in the queue now. */
  async retryNow(id: string, actor = "admin"): Promise<Payout> {
    const out = await this.chain(id, async () => {
      const p = await this.get(id);
      if (p.status !== "failed" && p.status !== "approved") throw new ServiceError(409, "payout_not_retryable", `A ${p.status} payout cannot be retried`);
      if (p.attempts > 0) {
        const found = await this.safeLookup(p);
        if (found?.kind === "paid") {
          await this.markPaid(p, found.signature, true);
          return this.get(id);
        }
      }
      const t = this.now();
      const next: Payout = { ...p, status: "approved", attempts: 0, nextAttemptAt: t, updatedAt: t };
      await this.store.update(next, [{ type: "retry", ts: t, data: { by: actor, previousAttempts: p.attempts, previousError: p.lastError } }]);
      return next;
    });
    this.kick(id);
    return out;
  }

  // -------------------------------------------------------------- execution

  private req(p: Payout) {
    return { payoutId: p.id, destination: p.wallet, amountBaseUnits: BigInt(p.amountBaseUnits) };
  }

  private async safeLookup(p: Payout) {
    try {
      return await this.executor.status(this.req(p));
    } catch {
      return undefined;
    }
  }

  /** Serialise work on one payout. */
  private chain<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return run;
  }

  /** Run a payout's next step in the background. */
  private kick(id: string): void {
    const t: Promise<unknown> = this.chain(id, () => this.step(id))
      .catch((e) => this.onError(e, `payout ${id}`))
      .finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  /** Resolve when background work has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  /**
   * One pass over everything open: finish interrupted debits, retry what is due, look up outcomes never recorded.
   * Safe to call as often as you like and from several processes' worth of restarts: every step is idempotent.
   */
  async reconcile(): Promise<{ checked: number; paid: number; failed: number }> {
    const open = await this.store.list({ status: OPEN_PAYOUT_STATUSES, limit: 1000 });
    let paid = 0;
    let failed = 0;
    for (const p of open) {
      const before = p.status;
      try {
        await this.chain(p.id, () => this.step(p.id));
      } catch (e) {
        this.onError(e, `reconcile ${p.id}`);
      }
      const after = await this.store.get(p.id);
      if (after?.status === "paid" && before !== "paid") paid++;
      if (after?.status === "failed" && before !== "failed") failed++;
    }
    return { checked: open.length, paid, failed };
  }

  /** What /health shows about payouts. */
  async summary(): Promise<{ executor: string; split: number; minUsd: number; autoMaxUsd: number; open: number; pendingApproval: number; failed: number; sending: number }> {
    const open = await this.store.list({ status: OPEN_PAYOUT_STATUSES, limit: 1000 });
    const n = (s: PayoutStatus) => open.filter((p) => p.status === s).length;
    return { executor: this.executor.name, split: this.policy.split, minUsd: this.policy.minUsd, autoMaxUsd: this.policy.autoMaxUsd, open: open.length, pendingApproval: n("pending_approval"), failed: n("failed"), sending: n("sending") };
  }

  private backoff(attempts: number): number {
    return Math.min(this.retry.baseMs * 2 ** Math.max(0, attempts - 1), this.retry.maxMs);
  }

  /** The state machine. Called with the payout's chain held. */
  private async step(id: string): Promise<void> {
    let p = await this.store.get(id);
    if (!p || !isOpenPayout(p.status)) return;
    if (!p.debited) {
      const done = await this.ensureDebited(p);
      if (!done) return;
      p = done;
    }
    const t = this.now();
    switch (p.status) {
      case "pending_approval":
      case "failed":
        return;
      case "approved":
        if ((p.nextAttemptAt ?? 0) > t) return;
        return this.attempt(p);
      case "sending": {
        if (t - (p.sendingSince ?? 0) < this.retry.leaseMs) return; // in progress, or a crash still inside the lease
        const found = await this.safeLookup(p);
        if (found?.kind === "paid") return this.markPaid(p, found.signature, true);
        if (found === undefined) return; // cannot tell yet: leave it for the next pass
        return this.attempt(p);
      }
      case "submitted": {
        if ((p.nextAttemptAt ?? 0) > t) return;
        try {
          const found = await this.executor.status(this.req(p));
          if (found.kind === "paid") return this.markPaid(p, found.signature, true);
          await this.store.update({ ...p, nextAttemptAt: t + this.retry.pollMs, updatedAt: t });
        } catch (e) {
          if (e instanceof PayoutChainError && !e.retryable) return this.park(p, e, "non_retryable");
          this.onError(e, `poll ${p.id}`);
        }
        return;
      }
    }
  }

  /** Make sure the sweep is on the account ledger. Returns the payout when it is, undefined when it was rejected. */
  private async ensureDebited(p: Payout): Promise<Payout | undefined> {
    const r = await this.svc.payoutFinalizeDebit(p.challengeId, p.id, p.sweepUsd);
    const t = this.now();
    if (r === "impossible") {
      const next: Payout = { ...p, status: "rejected", rejectedReason: "The profit was no longer in the account when the request was recovered after a restart", rejectedBy: "system", rejectedAt: t, updatedAt: t };
      await this.store.update(next, [{ type: "rejected", ts: t, data: { by: "system", reason: next.rejectedReason } }]);
      return undefined;
    }
    const next: Payout = { ...p, debited: true, updatedAt: t };
    await this.store.update(next, [{ type: "debited", ts: t, data: { sweepUsd: p.sweepUsd, recovered: r === "applied" } }]);
    return next;
  }

  private async attempt(p0: Payout): Promise<void> {
    const t = this.now();
    const p: Payout = { ...p0, status: "sending", attempts: p0.attempts + 1, sendingSince: t, nextAttemptAt: undefined, updatedAt: t };
    // Recorded BEFORE the send: a crash from here on leaves a `sending` payout that reconcile resolves by lookup.
    await this.store.update(p, [{ type: "attempt", ts: t, data: { n: p.attempts, executor: this.executor.name } }]);
    try {
      const res = await this.executor.submit(this.req(p));
      if (res.kind === "paid") return this.markPaid(p, res.signature, res.alreadySent);
      const t2 = this.now();
      const next: Payout = { ...p, status: "submitted", proposalId: res.proposalId, nextAttemptAt: t2 + this.retry.pollMs, lastError: undefined, lastErrorCode: undefined, updatedAt: t2 };
      await this.store.update(next, [{ type: "submitted", ts: t2, data: { proposalId: res.proposalId } }]);
    } catch (e) {
      await this.failAttempt(p, e);
    }
  }

  private async failAttempt(p: Payout, e: unknown): Promise<void> {
    const err = e instanceof PayoutChainError ? e : new PayoutChainError("rpc_error", e instanceof Error ? e.message : String(e), true);
    const t = this.now();
    const base = { lastError: err.message, lastErrorCode: err.code, sendingSince: undefined, updatedAt: t };
    if (!err.retryable) return this.park(p, err, "non_retryable");
    if (err.code === "treasury_insufficient") {
      // Nothing was sent, so this does not count as a failed attempt: the payout waits for the treasury to be topped up.
      const next: Payout = { ...p, ...base, status: "approved", attempts: Math.max(0, p.attempts - 1), nextAttemptAt: t + this.retry.treasuryWaitMs };
      await this.store.update(next, [{ type: "attempt_failed", ts: t, data: { code: err.code, message: err.message, nextAttemptAt: next.nextAttemptAt, counted: false } }]);
      return;
    }
    if (p.attempts >= this.retry.maxAttempts) return this.park(p, err, "max_attempts");
    // After a send error the transfer may still land: wait out the blockhash lease before looking again.
    const wait = err.code === "send_failed" ? Math.max(this.backoff(p.attempts), this.retry.leaseMs) : this.backoff(p.attempts);
    const next: Payout = { ...p, ...base, status: "approved", nextAttemptAt: t + wait };
    await this.store.update(next, [{ type: "attempt_failed", ts: t, data: { code: err.code, message: err.message, nextAttemptAt: next.nextAttemptAt, counted: true } }]);
  }

  /** Stop retrying: an admin retries or rejects. The money stays reserved (swept) until then. */
  private async park(p: Payout, err: PayoutChainError, reason: "non_retryable" | "max_attempts"): Promise<void> {
    const t = this.now();
    const next: Payout = { ...p, status: "failed", lastError: err.message, lastErrorCode: err.code, sendingSince: undefined, nextAttemptAt: undefined, updatedAt: t };
    await this.store.update(next, [
      { type: "attempt_failed", ts: t, data: { code: err.code, message: err.message, counted: true } },
      { type: "gave_up", ts: t, data: { reason, attempts: p.attempts } },
    ]);
    this.onError(new Error(`payout ${p.id} failed (${err.code}): ${err.message}`), "payout needs an admin");
  }

  private async markPaid(p: Payout, signature: string, alreadySent: boolean): Promise<void> {
    const t = this.now();
    const next: Payout = { ...p, status: "paid", signature, paidAt: t, nextAttemptAt: undefined, sendingSince: undefined, lastError: undefined, lastErrorCode: undefined, updatedAt: t };
    await this.store.update(next, [{ type: "paid", ts: t, data: { signature, alreadySent, amountUsd: p.amountUsd, destination: p.wallet } }]);
    await this.svc.payoutNote(p.challengeId, `$${p.amountUsd.toFixed(2)} in USDC was sent to ${p.wallet.slice(0, 4)}...${p.wallet.slice(-4)}`).catch((e) => this.onError(e, `payout note ${p.id}`));
  }
}
