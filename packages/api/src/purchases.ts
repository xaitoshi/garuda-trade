import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@garuda/db";
import { CHALLENGE_FEES_USD, usdToBaseUnits, type UsdcChain } from "@garuda/chain";
import { TIERS, type TierId } from "@garuda/risk-engine";
import { base58Encode } from "./base58.js";
import { ChallengeService, ServiceError, reviveChallengeId } from "./service.js";
import type { PaymentProvider, PaymentReceipt, PaymentRequest } from "./payments.js";

export type OrderKind = "challenge" | "revive";
/**
 * pending: quoted, waiting for the transfer. paid: transfer verified, fulfilment not finished (a retry or the
 * reconciler finishes it). fulfilled: knight minted / revive account open. refund_pending / refund_failed: money taken
 * but nothing delivered, refund owed. refunded: refund sent. expired: never paid.
 */
export type OrderStatus = "pending" | "paid" | "fulfilled" | "refund_pending" | "refund_failed" | "refunded" | "expired";

export interface PaymentOrder {
  id: string;
  kind: OrderKind;
  wallet: string;
  tier: TierId;
  /** Revive: the wounded challenge being revived. */
  sourceChallengeId?: string;
  /** Challenge: the knight to level into a gated tier (omit to mint a new Squire-line knight). */
  knightAsset?: string;
  listUsd: number;
  discountPct: number;
  amountUsd: number;
  amountBaseUnits: string;
  /** Unique key the payer must include in the transfer (Solana Pay reference). */
  reference: string;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  signature?: string;
  payerTokenAccount?: string;
  paidBaseUnits?: string;
  /** Result. */
  challengeId?: string;
  knightId?: string;
  /** Why it was refunded / what went wrong last. */
  failure?: string;
  refundSignature?: string;
}

export interface OrderStore {
  get(id: string): Promise<PaymentOrder | undefined>;
  findBySignature(signature: string): Promise<PaymentOrder | undefined>;
  /** Insert or update. Throws `signature_taken` when another order already holds the signature. */
  save(o: PaymentOrder): Promise<void>;
  list(filter?: { wallet?: string; status?: OrderStatus[] }): Promise<PaymentOrder[]>;
}

export class InMemoryOrderStore implements OrderStore {
  private orders = new Map<string, PaymentOrder>();
  async get(id: string) {
    const o = this.orders.get(id);
    return o && structuredClone(o);
  }
  async findBySignature(signature: string) {
    for (const o of this.orders.values()) if (o.signature === signature) return structuredClone(o);
    return undefined;
  }
  async save(o: PaymentOrder) {
    if (o.signature) for (const x of this.orders.values()) if (x.id !== o.id && x.signature === o.signature) throw new Error("signature_taken");
    this.orders.set(o.id, structuredClone(o));
  }
  async list(f: { wallet?: string; status?: OrderStatus[] } = {}) {
    return [...this.orders.values()]
      .filter((o) => (f.wallet === undefined || o.wallet === f.wallet) && (f.status === undefined || f.status.includes(o.status)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => structuredClone(o));
  }
}

export class PgOrderStore implements OrderStore {
  constructor(private readonly db: Db) {}
  private static parse(r: Record<string, any>): PaymentOrder {
    return JSON.parse(String(r.data)) as PaymentOrder;
  }
  async get(id: string) {
    const r = (await this.db.query<Record<string, any>>("SELECT data FROM payment_orders WHERE id = $1", [id])).rows[0];
    return r ? PgOrderStore.parse(r) : undefined;
  }
  async findBySignature(signature: string) {
    const r = (await this.db.query<Record<string, any>>("SELECT data FROM payment_orders WHERE signature = $1", [signature])).rows[0];
    return r ? PgOrderStore.parse(r) : undefined;
  }
  async save(o: PaymentOrder) {
    const params = [o.id, o.wallet, o.kind, o.status, o.reference, o.signature ?? null, JSON.stringify(o), o.createdAt, o.updatedAt];
    try {
      await this.db.query(
        `INSERT INTO payment_orders (id, wallet, kind, status, reference, signature, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET status = $4, signature = $6, data = $7, updated_at = $9`,
        params,
      );
    } catch (e) {
      if (/signature/i.test((e as Error).message) && /unique|duplicate/i.test((e as Error).message)) throw new Error("signature_taken");
      throw e;
    }
  }
  async list(f: { wallet?: string; status?: OrderStatus[] } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.wallet !== undefined) where.push(`wallet = $${params.push(f.wallet)}`);
    if (f.status?.length) where.push(`status IN (${f.status.map((s) => `$${params.push(s)}`).join(", ")})`);
    const rows = (await this.db.query<Record<string, any>>(`SELECT data FROM payment_orders${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`, params)).rows;
    return rows.map(PgOrderStore.parse);
  }
}

/**
 * For real-money mode: any code path that would use the old stub to take payment (revive via the legacy route) is told
 * to go through /purchases instead.
 */
export class PaymentRequiredProvider implements PaymentProvider {
  async charge(_req: PaymentRequest): Promise<PaymentReceipt> {
    return { ok: false, error: "payment_required" };
  }
}

/** What the client needs to pay: send `amountBaseUnits` of `mint` to `treasury`'s token account, include `reference` as a read-only account. */
export interface PaymentInstructions {
  orderId: string;
  kind: OrderKind;
  tier: TierId;
  listUsd: number;
  discountPct: number;
  amountUsd: number;
  amountBaseUnits: string;
  decimals: number;
  mint: string;
  /** Treasury wallet (the transfer goes to its associated token account for `mint`). */
  treasury: string;
  reference: string;
  expiresAt: number;
  cluster: "devnet";
}

export type ConfirmOutcome =
  | { status: "pending"; order: PaymentOrder }
  | { status: "fulfilled"; order: PaymentOrder }
  | { status: "refunded"; order: PaymentOrder }
  | { status: "refund_pending"; order: PaymentOrder };

export interface PurchaseOptions {
  service: ChallengeService;
  usdc: UsdcChain;
  store?: OrderStore;
  now?: () => number;
  /** Quote validity. Default 30 minutes. */
  quoteTtlMs?: number;
}

const QUOTE_TTL_MS = 30 * 60_000;

export const orderChallengeId = (orderId: string) => reviveChallengeId(orderId);

export class PurchaseService {
  private readonly svc: ChallengeService;
  readonly usdc: UsdcChain;
  private readonly store: OrderStore;
  private readonly now: () => number;
  private readonly ttl: number;
  private chains = new Map<string, Promise<unknown>>();

  constructor(o: PurchaseOptions) {
    this.svc = o.service;
    this.usdc = o.usdc;
    this.store = o.store ?? new InMemoryOrderStore();
    this.now = o.now ?? Date.now;
    this.ttl = o.quoteTtlMs ?? QUOTE_TTL_MS;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private instructions(o: PaymentOrder): PaymentInstructions {
    return {
      orderId: o.id,
      kind: o.kind,
      tier: o.tier,
      listUsd: o.listUsd,
      discountPct: o.discountPct,
      amountUsd: o.amountUsd,
      amountBaseUnits: o.amountBaseUnits,
      decimals: this.usdc.decimals,
      mint: this.usdc.mint,
      treasury: this.usdc.treasury,
      reference: o.reference,
      expiresAt: o.expiresAt,
      cluster: "devnet",
    };
  }

  private async newOrder(a: Pick<PaymentOrder, "kind" | "wallet" | "tier" | "sourceChallengeId" | "knightAsset" | "listUsd" | "discountPct" | "amountUsd">): Promise<PaymentOrder> {
    const t = this.now();
    const o: PaymentOrder = {
      ...a,
      id: `ord_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      amountBaseUnits: usdToBaseUnits(a.amountUsd, this.usdc.decimals).toString(),
      reference: base58Encode(randomBytes(32)),
      status: "pending",
      createdAt: t,
      updatedAt: t,
      expiresAt: t + this.ttl,
    };
    await this.store.save(o);
    return o;
  }

  /** Quote a challenge purchase. Fails now (before anyone pays) when the account could not be opened: caps, tier gating, knight ownership. */
  async quoteChallenge(a: { wallet: string; tier: TierId; knightAsset?: string }): Promise<PaymentInstructions> {
    if (a.tier === "demo" || !(a.tier in CHALLENGE_FEES_USD)) throw new ServiceError(400, "unknown_tier", "Only paid tiers are bought");
    await this.svc.assertCanCreate({ tier: a.tier, wallet: a.wallet, knightAsset: a.knightAsset });
    const fee = CHALLENGE_FEES_USD[a.tier];
    const o = await this.newOrder({ kind: "challenge", wallet: a.wallet, tier: a.tier, knightAsset: a.knightAsset, listUsd: fee, discountPct: 0, amountUsd: fee });
    return this.instructions(o);
  }

  /** Quote a revive: 20% off the tier fee (rulebook section 17). Only the current holder of a Wounded knight can buy it. */
  async quoteRevive(a: { wallet: string; challengeId: string }): Promise<PaymentInstructions> {
    if (!(await this.svc.canAct(a.challengeId, a.wallet))) throw new ServiceError(403, "not_owner", "This knight is not yours");
    const info = await this.svc.reviveInfo(a.challengeId);
    if (!info.eligible) throw new ServiceError(info.reason === "revive_cooldown" ? 429 : 409, info.reason!, `Revive unavailable: ${info.reason}`, info);
    const list = TIERS[info.tier].fee;
    const o = await this.newOrder({
      kind: "revive",
      wallet: a.wallet,
      tier: info.tier,
      sourceChallengeId: a.challengeId,
      listUsd: list,
      discountPct: 20,
      amountUsd: info.fee,
    });
    return this.instructions(o);
  }

  async get(id: string, wallet?: string): Promise<PaymentOrder> {
    const o = await this.store.get(id);
    if (!o) throw new ServiceError(404, "order_not_found", "Unknown order");
    if (wallet !== undefined && o.wallet !== wallet) throw new ServiceError(403, "not_owner", "This order belongs to another wallet");
    return o;
  }

  list(wallet: string) {
    return this.store.list({ wallet });
  }

  /**
   * The payer submits the transfer signature. We verify it ON CHAIN (mint, destination, amount, payer, reference, age),
   * then fulfil. Safe to call repeatedly: a fulfilled order returns its result, a paid-but-unfinished order resumes.
   */
  confirm(orderId: string, a: { signature: string; wallet?: string }): Promise<ConfirmOutcome> {
    return this.serial(orderId, async () => {
      let o = await this.get(orderId, a.wallet);
      if (o.signature && o.signature !== a.signature) throw new ServiceError(409, "order_already_paid", "This order is already settled by a different transfer");
      if (o.status === "fulfilled" || o.status === "refunded") return { status: o.status, order: o };
      if (o.status === "pending") {
        if (this.now() > o.expiresAt) {
          o = await this.update(o, { status: "expired" });
          throw new ServiceError(410, "order_expired", "This quote has expired: request a new one (a late payment can be refunded: contact support with the signature)");
        }
        const other = await this.store.findBySignature(a.signature);
        if (other && other.id !== o.id) throw new ServiceError(409, "signature_reused", "That transfer already paid for another order");
        const v = await this.usdc.verifyPayment({
          signature: a.signature,
          wallet: o.wallet,
          reference: o.reference,
          amountBaseUnits: BigInt(o.amountBaseUnits),
          notBeforeMs: o.createdAt,
        });
        if (v.status === "pending") return { status: "pending", order: o };
        if (v.status === "invalid") throw new ServiceError(402, `payment_${v.reason}`, `Payment rejected: ${v.reason}`, v.detail);
        try {
          o = await this.update(o, { status: "paid", signature: a.signature, payerTokenAccount: v.payerTokenAccount, paidBaseUnits: v.paidBaseUnits.toString() });
        } catch (e) {
          if ((e as Error).message === "signature_taken") throw new ServiceError(409, "signature_reused", "That transfer already paid for another order");
          throw e;
        }
      }
      if (o.status === "paid") return this.fulfil(o);
      return this.refund(o);
    });
  }

  private async update(o: PaymentOrder, patch: Partial<PaymentOrder>): Promise<PaymentOrder> {
    const next = { ...o, ...patch, updatedAt: this.now() };
    await this.store.save(next);
    return next;
  }

  /** Mint / open the account. Any failure after the money is taken goes to refund; success is fulfilled. Idempotent by order id. */
  private async fulfil(o: PaymentOrder): Promise<ConfirmOutcome> {
    try {
      if (o.kind === "challenge") {
        const st = await this.svc.create(
          { tier: o.tier, wallet: o.wallet, knightAsset: o.knightAsset, stage: "evaluation" },
          { id: orderChallengeId(o.id), paid: { orderId: o.id, ref: o.signature!, amountUsd: o.amountUsd } },
        );
        o = await this.update(o, { status: "fulfilled", challengeId: st.id, knightId: st.knightId, failure: undefined });
      } else {
        const res = await this.svc.revive(o.sourceChallengeId!, {
          actorWallet: o.wallet,
          prepaid: { orderId: o.id, ref: o.signature!, amountUsd: o.amountUsd },
        });
        o = await this.update(o, { status: "fulfilled", challengeId: res.state.id, knightId: res.state.knightId, failure: undefined });
      }
      return { status: "fulfilled", order: o };
    } catch (e) {
      const msg = e instanceof ServiceError ? `${e.code}: ${e.message}` : (e as Error).message;
      o = await this.update(o, { status: "refund_pending", failure: msg });
      return this.refund(o);
    }
  }

  /** Send the money back to the payer's token account. Idempotent per order. A failed send keeps the order in refund_failed for a retry. */
  private async refund(o: PaymentOrder): Promise<ConfirmOutcome> {
    try {
      const r = await this.usdc.refund({ orderId: o.id, toTokenAccount: o.payerTokenAccount!, amountBaseUnits: BigInt(o.paidBaseUnits ?? o.amountBaseUnits) });
      o = await this.update(o, { status: "refunded", refundSignature: r.signature });
      return { status: "refunded", order: o };
    } catch (e) {
      o = await this.update(o, { status: "refund_failed", failure: `${o.failure ?? "refund"} | refund send failed: ${(e as Error).message}` });
      return { status: "refund_pending", order: o };
    }
  }

  /**
   * Finish what a crash or an RPC outage left half done: paid orders are fulfilled (or refunded), owed refunds are
   * retried, stale quotes expire. The worker calls this on an interval.
   */
  async reconcile(): Promise<{ fulfilled: number; refunded: number; expired: number; stillOwed: number }> {
    const out = { fulfilled: 0, refunded: 0, expired: 0, stillOwed: 0 };
    const open = await this.store.list({ status: ["pending", "paid", "refund_pending", "refund_failed"] });
    for (const o of open) {
      await this.serial(o.id, async () => {
        const cur = await this.store.get(o.id);
        if (!cur) return;
        if (cur.status === "pending") {
          if (this.now() > cur.expiresAt) {
            await this.update(cur, { status: "expired" });
            out.expired++;
          }
          return;
        }
        const r = cur.status === "paid" ? await this.fulfil(cur) : await this.refund(cur);
        if (r.status === "fulfilled") out.fulfilled++;
        else if (r.status === "refunded") out.refunded++;
        else out.stillOwed++;
      });
    }
    return out;
  }
}
