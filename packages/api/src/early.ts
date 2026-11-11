import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@garuda/db";
import { USDC_DECIMALS, usdToBaseUnits, type EarlyCluster, type EarlyMinter, type JsonRpc, type VerifyPaymentInput, type VerifyPaymentResult } from "@garuda/chain";
import { base58Decode, base58Encode } from "./base58.js";
import { RateLimiter, type Limit } from "./rate-limit.js";
import { ServiceError } from "./service.js";

/**
 * Garuda Beta Access (/early): a PAID Metaplex Core NFT on Solana mainnet.
 *  - Minting OFF (EARLY_MINT_ENABLED=false, the default): POST /early/claim records a waitlist entry. No payment is taken.
 *  - Minting ON: POST /early/claim returns ONE pre-signed transaction that pays EARLY_PRICE_USD of USDC to the treasury
 *    (with a unique reference key) AND creates the Core asset for the claim's wallet. The buyer's wallet signs and sends
 *    it, paying the USDC, the network fee and the asset rent. POST /early/claim/:id/confirm then verifies the transfer
 *    onchain (mint, recipient, amount, payer signed, reference present, signature never used before) and that the asset
 *    exists, and records the claim as minted. The mint authority only signs as the collection authority: no SOL per mint.
 * Emails are never returned by a public route.
 */

export type EarlyStatus = "waitlist" | "awaiting_payment" | "paid" | "minted" | "refund_due";

export interface EarlyClaim {
  id: string;
  wallet: string;
  email: string;
  status: EarlyStatus;
  reference?: string;
  amountBaseUnits?: string;
  payer?: string;
  paymentSignature?: string;
  asset?: string;
  mintSignature?: string;
  error?: string;
  ipHash?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  paidAt?: number;
  mintedAt?: number;
}

export class EarlyConflictError extends Error {
  constructor(readonly field: "wallet" | "email" | "payment_signature" | "reference") {
    super(`${field}_taken`);
  }
}

export interface EarlyStore {
  get(id: string): Promise<EarlyClaim | undefined>;
  byWallet(wallet: string): Promise<EarlyClaim | undefined>;
  byEmail(email: string): Promise<EarlyClaim | undefined>;
  /** Insert. Throws EarlyConflictError on a duplicate wallet, email, reference or payment signature. */
  insert(c: EarlyClaim): Promise<void>;
  /** Update when the row is still in `from` status. Returns false when someone else moved it first. */
  update(c: EarlyClaim, from: EarlyStatus[]): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  list(f?: { status?: EarlyStatus[]; limit?: number }): Promise<EarlyClaim[]>;
  counts(): Promise<Record<EarlyStatus, number>>;
}

const STATUSES: EarlyStatus[] = ["waitlist", "awaiting_payment", "paid", "minted", "refund_due"];
const emptyCounts = (): Record<EarlyStatus, number> => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<EarlyStatus, number>;

export class InMemoryEarlyStore implements EarlyStore {
  rows = new Map<string, EarlyClaim>();
  async get(id: string) {
    const c = this.rows.get(id);
    return c && { ...c };
  }
  async byWallet(w: string) {
    for (const c of this.rows.values()) if (c.wallet === w) return { ...c };
  }
  async byEmail(e: string) {
    for (const c of this.rows.values()) if (c.email === e) return { ...c };
  }
  private clash(c: EarlyClaim) {
    for (const x of this.rows.values()) {
      if (x.id === c.id) continue;
      if (x.wallet === c.wallet) throw new EarlyConflictError("wallet");
      if (x.email === c.email) throw new EarlyConflictError("email");
      if (c.reference && x.reference === c.reference) throw new EarlyConflictError("reference");
      if (c.paymentSignature && x.paymentSignature === c.paymentSignature) throw new EarlyConflictError("payment_signature");
    }
  }
  async insert(c: EarlyClaim) {
    this.clash(c);
    this.rows.set(c.id, { ...c });
  }
  async update(c: EarlyClaim, from: EarlyStatus[]) {
    const cur = this.rows.get(c.id);
    if (!cur || !from.includes(cur.status)) return false;
    this.clash(c);
    this.rows.set(c.id, { ...c });
    return true;
  }
  async delete(id: string) {
    return this.rows.delete(id);
  }
  async list(f: { status?: EarlyStatus[]; limit?: number } = {}) {
    return [...this.rows.values()]
      .filter((c) => !f.status || f.status.includes(c.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, f.limit ?? 10_000)
      .map((c) => ({ ...c }));
  }
  async counts() {
    const out = emptyCounts();
    for (const c of this.rows.values()) out[c.status]++;
    return out;
  }
}

const COLS = "id, wallet, email, status, reference, amount_base_units, payer, payment_signature, asset, mint_signature, error, ip_hash, created_at, updated_at, expires_at, paid_at, minted_at";
const o = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

function rowToClaim(r: Record<string, unknown>): EarlyClaim {
  return {
    id: String(r.id),
    wallet: String(r.wallet),
    email: String(r.email),
    status: r.status as EarlyStatus,
    reference: o(r.reference as string | null),
    amountBaseUnits: o(r.amount_base_units as string | null),
    payer: o(r.payer as string | null),
    paymentSignature: o(r.payment_signature as string | null),
    asset: o(r.asset as string | null),
    mintSignature: o(r.mint_signature as string | null),
    error: o(r.error as string | null),
    ipHash: o(r.ip_hash as string | null),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    expiresAt: num(r.expires_at),
    paidAt: num(r.paid_at),
    mintedAt: num(r.minted_at),
  };
}
const params = (c: EarlyClaim) => [
  c.id, c.wallet, c.email, c.status, c.reference ?? null, c.amountBaseUnits ?? null, c.payer ?? null, c.paymentSignature ?? null, c.asset ?? null,
  c.mintSignature ?? null, c.error ?? null, c.ipHash ?? null, c.createdAt, c.updatedAt, c.expiresAt ?? null, c.paidAt ?? null, c.mintedAt ?? null,
];
function mapUnique(e: unknown): never {
  const m = `${(e as Error).message ?? ""} ${(e as { constraint?: string }).constraint ?? ""} ${(e as { detail?: string }).detail ?? ""}`;
  if (/unique|duplicate/i.test(m)) {
    // Postgres and pg-mem both name the column in "Key (col)=(...) already exists"; the constraint name is the fallback.
    const col = /Key \((\w+)\)=/.exec(m)?.[1] ?? /early_claims_(payment_signature|reference|email|wallet)_key/.exec(m)?.[1];
    if (col === "payment_signature") throw new EarlyConflictError("payment_signature");
    if (col === "reference") throw new EarlyConflictError("reference");
    if (col === "email") throw new EarlyConflictError("email");
    if (col === "wallet") throw new EarlyConflictError("wallet");
  }
  throw e;
}

/** Postgres (and pg-mem) store over migration 010_early_access. */
export class PgEarlyStore implements EarlyStore {
  constructor(private readonly db: Db) {}
  private async one(where: string, v: unknown) {
    const r = (await this.db.query<Record<string, unknown>>(`SELECT ${COLS} FROM early_claims WHERE ${where} = $1`, [v])).rows[0];
    return r ? rowToClaim(r) : undefined;
  }
  get(id: string) {
    return this.one("id", id);
  }
  byWallet(w: string) {
    return this.one("wallet", w);
  }
  byEmail(e: string) {
    return this.one("email", e);
  }
  async insert(c: EarlyClaim) {
    try {
      await this.db.query(`INSERT INTO early_claims (${COLS}) VALUES (${params(c).map((_, i) => `$${i + 1}`).join(", ")})`, params(c));
    } catch (e) {
      mapUnique(e);
    }
  }
  async update(c: EarlyClaim, from: EarlyStatus[]) {
    const p = params(c);
    const fromIdx = from.map((s) => `$${p.push(s)}`);
    try {
      const r = await this.db.query(
        `UPDATE early_claims SET wallet = $2, email = $3, status = $4, reference = $5, amount_base_units = $6, payer = $7, payment_signature = $8,
           asset = $9, mint_signature = $10, error = $11, ip_hash = $12, created_at = $13, updated_at = $14, expires_at = $15, paid_at = $16, minted_at = $17
         WHERE id = $1 AND status IN (${fromIdx.join(", ")})`,
        p,
      );
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      mapUnique(e);
    }
  }
  async delete(id: string) {
    const r = await this.db.query("DELETE FROM early_claims WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async list(f: { status?: EarlyStatus[]; limit?: number } = {}) {
    const p: unknown[] = [];
    const where = f.status?.length ? ` WHERE status IN (${f.status.map((s) => `$${p.push(s)}`).join(", ")})` : "";
    const rows = (await this.db.query<Record<string, unknown>>(`SELECT ${COLS} FROM early_claims${where} ORDER BY created_at LIMIT ${Math.min(10_000, Math.max(1, f.limit ?? 10_000))}`, p)).rows;
    return rows.map(rowToClaim);
  }
  async counts() {
    const out = emptyCounts();
    const rows = (await this.db.query<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM early_claims GROUP BY status")).rows;
    for (const r of rows) if (r.status in out) out[r.status as EarlyStatus] = Number(r.n);
    return out;
  }
}

// ------------------------------------------------------------------ validation

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  return base58Decode(s)?.length === 32;
}
const EMAIL_RE = /^[^\s@"<>(),;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
export function normalizeEmail(s: string): string | undefined {
  const e = s.trim().toLowerCase();
  if (e.length < 6 || e.length > 254 || !EMAIL_RE.test(e) || e.split("@")[0]!.length > 64) return undefined;
  return e;
}

// ------------------------------------------------------------------ service

export interface EarlyPaymentConfig {
  /** USDC mint (mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). */
  mint: string;
  /** Wallet that receives the payments (its USDC token account). Receive-only: the server holds no key for it. */
  treasury: string;
  decimals?: number;
  /** Verifies a transfer (verifyUsdcPayment over EARLY_RPC_URL). */
  verify(i: VerifyPaymentInput): Promise<VerifyPaymentResult>;
}

export interface EarlyOptions {
  store: EarlyStore;
  /** EARLY_MINT_ENABLED. Off: claims are waitlist entries and no payment is taken. */
  enabled: boolean;
  priceUsd: number;
  maxSupply: number;
  cluster: EarlyCluster;
  /** Required when enabled. */
  minter?: EarlyMinter;
  payment?: EarlyPaymentConfig;
  /** How long a payment quote holds a slot under the cap. Default 5 min (a blockhash lives about 1 to 2 minutes). */
  quoteTtlMs?: number;
  /** Per-IP limit on POST /early/claim and confirm. Default 6 per 10 minutes. */
  claimLimit?: Limit | false;
  now?: () => number;
  /** Public image + metadata (for /early/status). */
  imageUrl?: string;
  metadataUri?: string;
  log?: (m: string) => void;
}

export type ClaimOutcome =
  | { status: "waitlist"; claimId: string; alreadyOnList: boolean }
  | { status: "awaiting_payment"; claimId: string; payment: EarlyPaymentInstructions }
  | { status: "minted"; claimId: string; asset: string; signature?: string; explorer: string; alreadyMinted: boolean }
  | { status: "paid"; claimId: string; message: string }
  | { status: "refund_due"; claimId: string; message: string };

export interface EarlyPaymentInstructions {
  claimId: string;
  orderId: string;
  cluster: EarlyCluster;
  mint: string;
  treasury: string;
  decimals: number;
  amountUsd: number;
  amountBaseUnits: string;
  reference: string;
  expiresAt: number;
  /** The NFT goes here. */
  wallet: string;
  /** Signs and pays (USDC, network fee, asset rent). */
  payer: string;
  /** Asset address the transaction creates. */
  asset: string;
  /** Legacy transaction (base64) pre-signed by Garuda: the payer's wallet adds its signature and sends it. */
  transaction: string;
  lastValidBlockHeight: number;
}

const solscan = (cluster: EarlyCluster, kind: "token" | "tx", id: string) => `https://solscan.io/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

/** A claim as a public route may show it: never the email. */
export function publicClaim(c: EarlyClaim) {
  const { email: _e, ipHash: _i, ...rest } = c;
  return rest;
}

export class EarlyAccessService {
  readonly store: EarlyStore;
  private readonly now: () => number;
  private readonly ttl: number;
  /** Serialises cap checks and mints in this process so two buyers cannot take the last slot. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly o: EarlyOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.ttl = o.quoteTtlMs ?? 5 * 60_000;
    if (o.enabled && (!o.minter || !o.payment)) throw new Error("EARLY_MINT_ENABLED=true needs the mint authority, collection, treasury and RPC configured");
    if (!(o.priceUsd > 0) || !Number.isFinite(o.priceUsd)) throw new Error("EARLY_PRICE_USD must be a positive number");
    if (!Number.isInteger(o.maxSupply) || o.maxSupply < 1) throw new Error("EARLY_MAX_SUPPLY must be a positive integer");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  get amountBaseUnits(): bigint {
    return usdToBaseUnits(this.o.priceUsd, this.o.payment?.decimals ?? USDC_DECIMALS);
  }

  async status() {
    const c = await this.store.counts();
    const live = await this.liveQuotes();
    const reserved = c.minted + c.paid + live;
    return {
      enabled: this.o.enabled,
      cluster: this.o.cluster,
      priceUsd: this.o.priceUsd,
      currency: "USDC",
      minted: c.minted,
      cap: this.o.maxSupply,
      remaining: Math.max(0, this.o.maxSupply - reserved),
      soldOut: reserved >= this.o.maxSupply,
      waitlist: c.waitlist,
      collection: this.o.enabled ? this.o.minter?.collection : undefined,
      imageUrl: this.o.imageUrl,
      metadataUri: this.o.metadataUri,
    };
  }

  private async liveQuotes(): Promise<number> {
    const t = this.now();
    return (await this.store.list({ status: ["awaiting_payment"] })).filter((q) => (q.expiresAt ?? 0) > t).length;
  }

  private instructions(c: EarlyClaim, tx: { transaction: string; asset: string; lastValidBlockHeight: number }): EarlyPaymentInstructions {
    const p = this.o.payment!;
    return {
      ...tx,
      payer: c.payer ?? c.wallet,
      claimId: c.id,
      orderId: c.id,
      cluster: this.o.cluster,
      mint: p.mint,
      treasury: p.treasury,
      decimals: p.decimals ?? USDC_DECIMALS,
      amountUsd: this.o.priceUsd,
      amountBaseUnits: c.amountBaseUnits!,
      reference: c.reference!,
      expiresAt: c.expiresAt!,
      wallet: c.wallet,
    };
  }

  private minted(c: EarlyClaim, alreadyMinted: boolean): ClaimOutcome {
    return { status: "minted", claimId: c.id, asset: c.asset!, signature: c.mintSignature, explorer: solscan(this.o.cluster, c.mintSignature ? "tx" : "token", c.mintSignature ?? c.asset!), alreadyMinted };
  }

  /** POST /early/claim. */
  async claim(input: { wallet: string; email: string; payer?: string; ip?: string }): Promise<ClaimOutcome> {
    const wallet = input.wallet.trim();
    if (!isSolanaAddress(wallet)) throw new ServiceError(400, "invalid_wallet", "That is not a valid Solana wallet address");
    const payer = input.payer?.trim() || wallet;
    if (!isSolanaAddress(payer)) throw new ServiceError(400, "invalid_payer", "payer is not a valid Solana address");
    const email = normalizeEmail(input.email);
    if (!email) throw new ServiceError(400, "invalid_email", "That is not a valid email address");
    const ipHash = input.ip ? createHash("sha256").update(`garuda-early:${input.ip}`).digest("hex").slice(0, 32) : undefined;

    return this.serial(async () => {
      const t = this.now();
      const byW = await this.store.byWallet(wallet);
      const byE = await this.store.byEmail(email);
      // Abandoned quotes (never paid, expired) do not hold a wallet or email.
      for (const x of [byW, byE]) if (x && x.status === "awaiting_payment" && (x.expiresAt ?? 0) <= t && !(x.wallet === wallet && x.email === email)) await this.store.delete(x.id);
      const w = byW && (await this.store.get(byW.id));
      const e = byE && (await this.store.get(byE.id));
      if (w && e && w.id !== e.id) throw new ServiceError(409, "already_claimed", "That wallet and that email are each already on the list");
      const mine = w ?? e;
      if (mine && (mine.wallet !== wallet || mine.email !== email)) {
        throw new ServiceError(409, mine.wallet === wallet ? "wallet_taken" : "email_taken", mine.wallet === wallet ? "That wallet already has a claim" : "That email already has a claim");
      }

      if (mine?.status === "minted") return this.minted(mine, true);
      if (mine?.status === "paid") return { status: "paid", claimId: mine.id, message: "Payment received. Your NFT is being minted." };
      if (mine?.status === "refund_due") return { status: "refund_due", claimId: mine.id, message: "Sold out after your payment. Your USDC will be refunded." };

      if (!this.o.enabled) {
        if (mine) return { status: "waitlist", claimId: mine.id, alreadyOnList: true };
        const c: EarlyClaim = { id: randomUUID(), wallet, email, status: "waitlist", ipHash, createdAt: t, updatedAt: t };
        await this.insertOrConflict(c);
        return { status: "waitlist", claimId: c.id, alreadyOnList: false };
      }

      // Minting on: a quote holds one slot under the cap until it expires.
      const live = mine?.status === "awaiting_payment" && (mine.expiresAt ?? 0) > t;
      if (!live) {
        const c = await this.store.counts();
        if (c.minted + c.paid + (await this.liveQuotes()) >= this.o.maxSupply) throw new ServiceError(410, "sold_out", "All Garuda Beta Access NFTs are claimed");
      }
      const next: EarlyClaim = {
        ...(mine ?? { id: randomUUID(), wallet, email, createdAt: t, ipHash }),
        status: "awaiting_payment",
        payer,
        reference: mine?.status === "awaiting_payment" && mine.reference ? mine.reference : base58Encode(randomBytes(32)),
        amountBaseUnits: this.amountBaseUnits.toString(),
        expiresAt: t + this.ttl,
        updatedAt: t,
      } as EarlyClaim;
      // Build (and pre-sign) the buyer-paid payment + mint transaction. A fresh blockhash on every call: when a buyer
      // waits too long the client simply claims again and gets a new one for the same claim and asset address.
      let tx;
      try {
        tx = await this.o.minter!.buildPaidMint({
          claimId: next.id,
          owner: wallet,
          payer,
          usdcMint: this.o.payment!.mint,
          treasury: this.o.payment!.treasury,
          amountBaseUnits: this.amountBaseUnits,
          decimals: this.o.payment!.decimals ?? USDC_DECIMALS,
          reference: next.reference!,
        });
      } catch (e) {
        this.o.log?.(`[garuda-early] build tx failed: ${e instanceof Error ? e.message : e}`);
        throw new ServiceError(503, "chain_unavailable", "Solana is not answering right now. Try again in a minute.");
      }
      next.asset = tx.asset;
      if (mine) {
        if (!(await this.store.update(next, ["waitlist", "awaiting_payment"]))) throw new ServiceError(409, "claim_changed", "Try again");
      } else await this.insertOrConflict(next);
      return { status: "awaiting_payment", claimId: next.id, payment: this.instructions(next, tx) };
    });
  }

  private async insertOrConflict(c: EarlyClaim) {
    try {
      await this.store.insert(c);
    } catch (e) {
      if (e instanceof EarlyConflictError) throw new ServiceError(409, `${e.field}_taken`, `That ${e.field.replace("_", " ")} already has a claim`);
      throw e;
    }
  }

  /** POST /early/claim/:id/confirm: verify the USDC transfer, then mint. 202 (pending) while the transfer is not visible. */
  async confirm(id: string, input: { signature: string; payer?: string }): Promise<ClaimOutcome | { status: "pending"; claimId: string }> {
    if (!this.o.enabled || !this.o.payment) throw new ServiceError(409, "minting_disabled", "Minting is not open yet");
    const payer = (input.payer ?? "").trim();
    if (payer && !isSolanaAddress(payer)) throw new ServiceError(400, "invalid_payer", "payer is not a Solana address");
    const c0 = await this.store.get(id);
    if (!c0) throw new ServiceError(404, "claim_not_found", "No such claim");
    if (c0.status === "minted") return this.minted(c0, true);
    if (c0.status === "refund_due") return { status: "refund_due", claimId: c0.id, message: "Sold out after your payment. Your USDC will be refunded." };
    if (c0.status === "paid") return this.mintPaid(c0);
    if (c0.status !== "awaiting_payment") throw new ServiceError(409, "not_awaiting_payment", "Start the claim again");
    const used = (await this.store.list({ status: ["paid", "minted", "refund_due"] })).some((x) => x.paymentSignature === input.signature);
    if (used) throw new ServiceError(409, "signature_reused", "That transfer already paid for another claim");

    const v = await this.o.payment.verify({
      signature: input.signature,
      wallet: payer || c0.payer || c0.wallet,
      reference: c0.reference!,
      amountBaseUnits: BigInt(c0.amountBaseUnits!),
      notBeforeMs: c0.createdAt,
    });
    if (v.status === "pending") return { status: "pending", claimId: c0.id };
    if (v.status === "invalid") throw new ServiceError(422, `payment_${v.reason}`, `Payment not accepted: ${v.reason.replace(/_/g, " ")}`, v.detail);

    return this.serial(async () => {
      const c = await this.store.get(id);
      if (!c) throw new ServiceError(404, "claim_not_found", "No such claim");
      if (c.status === "minted") return this.minted(c, true);
      if (c.status !== "awaiting_payment") throw new ServiceError(409, "claim_changed", "This claim was already paid. Check its status again.");
      const t = this.now();
      // The payment and the mint are one transaction, so a confirmed payment means the asset exists. Check anyway.
      const owner = c.asset ? await this.o.minter!.assetOwner(c.asset) : undefined;
      const minted = owner !== undefined;
      const next: EarlyClaim = {
        ...c,
        status: minted ? "minted" : "paid",
        payer: payer || c.payer || c.wallet,
        paymentSignature: input.signature,
        mintSignature: minted ? input.signature : c.mintSignature,
        paidAt: t,
        mintedAt: minted ? t : undefined,
        updatedAt: t,
      };
      try {
        if (!(await this.store.update(next, ["awaiting_payment"]))) throw new ServiceError(409, "claim_changed", "Try again");
      } catch (e) {
        if (e instanceof EarlyConflictError) throw new ServiceError(409, "signature_reused", "That transfer already paid for another claim");
        throw e;
      }
      this.o.log?.(`[garuda-early] paid ${c.id} ${input.signature} ${minted ? `minted ${c.asset}` : "(asset not visible yet)"}`);
      if (minted) return this.minted(next, false);
      return { status: "paid", claimId: c.id, message: "Payment received. Your NFT will show up in a moment." } as ClaimOutcome;
    });
  }

  private mintPaid(c: EarlyClaim) {
    return this.serial(async () => {
      const cur = await this.store.get(c.id);
      if (!cur) throw new ServiceError(404, "claim_not_found", "No such claim");
      if (cur.status === "minted") return this.minted(cur, true);
      if (cur.status !== "paid") throw new ServiceError(409, "not_paid", "This claim is not paid");
      return this.mintPaidLocked(cur);
    });
  }

  /** Mint for a paid claim. Idempotent: the asset address is derived from the claim id. */
  private async mintPaidLocked(c: EarlyClaim): Promise<ClaimOutcome> {
    const minter = this.o.minter!;
    try {
      // Usually the buyer's own transaction already created it: just record it.
      const owner = c.asset ? await minter.assetOwner(c.asset) : undefined;
      const r = owner !== undefined ? { asset: c.asset!, signature: c.paymentSignature, alreadyMinted: true } : await minter.mint({ claimId: c.id, owner: c.wallet });
      const t = this.now();
      const done: EarlyClaim = { ...c, status: "minted", asset: r.asset, mintSignature: r.signature ?? c.mintSignature, error: undefined, mintedAt: t, updatedAt: t };
      await this.store.update(done, ["paid"]);
      this.o.log?.(`[garuda-early] minted ${c.id} -> ${r.asset}`);
      return this.minted(done, r.alreadyMinted);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.store.update({ ...c, error: msg.slice(0, 500), updatedAt: this.now() }, ["paid"]);
      this.o.log?.(`[garuda-early] mint failed ${c.id}: ${msg}`);
      return { status: "paid", claimId: c.id, message: "Payment received. Minting is retrying; your NFT will arrive shortly." };
    }
  }

  /** Admin: mint every paid-but-unminted claim (after an RPC outage or an unfunded mint authority). */
  async mintPending(opts: { limit?: number } = {}) {
    if (!this.o.enabled || !this.o.minter) throw new ServiceError(409, "minting_disabled", "Set EARLY_MINT_ENABLED=true (with the mint authority configured) first");
    const paid = await this.store.list({ status: ["paid"], limit: opts.limit ?? 100 });
    const results: { claimId: string; status: string; asset?: string; error?: string }[] = [];
    for (const c of paid) {
      const out = await this.mintPaid(c);
      const after = await this.store.get(c.id);
      results.push({ claimId: c.id, status: out.status, asset: after?.asset, error: out.status === "minted" ? undefined : after?.error });
    }
    return { attempted: paid.length, minted: results.filter((r) => r.status === "minted").length, results };
  }

  async adminStatus() {
    const s = await this.status();
    const counts = await this.store.counts();
    let mintAuthority: { address: string; balanceSol?: number } | undefined;
    if (this.o.minter) {
      mintAuthority = { address: this.o.minter.authority };
      try {
        mintAuthority.balanceSol = (await this.o.minter.balanceLamports()) / 1e9;
      } catch {
        /* RPC down: leave it out */
      }
    }
    return { ...s, counts, treasury: this.o.payment?.treasury, usdcMint: this.o.payment?.mint, mintAuthority };
  }
}

// ------------------------------------------------------------------ routes

const claimBody = z.object({ wallet: z.string().min(1).max(64), email: z.string().min(1).max(320), payer: z.string().min(1).max(64).optional() });
const confirmBody = z.object({ signature: z.string().min(64).max(100), payer: z.string().min(32).max(44).optional() });
const statusList = z.array(z.enum(STATUSES as [EarlyStatus, ...EarlyStatus[]]));

/** Routes for /early (public) and /admin/early (behind the admin token checked by buildApp's /admin hook). */
export function registerEarlyRoutes(app: FastifyInstance, svc: EarlyAccessService, now: () => number = Date.now) {
  const lim = svc.o.claimLimit === false ? undefined : new RateLimiter(svc.o.claimLimit ?? { limit: 6, windowMs: 10 * 60_000 }, now);
  const gate = (req: FastifyRequest, reply: { header(k: string, v: string | number): unknown }) => {
    if (!lim) return;
    const d = lim.check(req.ip);
    if (!d.allowed) {
      const retry = Math.max(1, Math.ceil(d.resetMs / 1000));
      reply.header("Retry-After", retry);
      throw new ServiceError(429, "rate_limited", "Too many claims from this network. Try again later.", { scope: "early", retryAfterSeconds: retry });
    }
  };

  app.get("/early/status", async () => svc.status());

  app.post("/early/claim", async (req, reply) => {
    gate(req, reply);
    const b = claimBody.parse(req.body ?? {});
    const out = await svc.claim({ wallet: b.wallet, email: b.email, payer: b.payer, ip: req.ip });
    return reply.status(out.status === "awaiting_payment" || (out.status === "waitlist" && !out.alreadyOnList) ? 201 : 200).send(out);
  });

  app.post<{ Params: { id: string } }>("/early/claim/:id/confirm", async (req, reply) => {
    const b = confirmBody.parse(req.body ?? {});
    const out = await svc.confirm(req.params.id, b);
    return reply.status(out.status === "pending" ? 202 : 200).send(out);
  });

  app.get("/admin/early", async () => svc.adminStatus());
  app.get<{ Querystring: { status?: string; limit?: string } }>("/admin/early/claims", async (req) => {
    const status = req.query.status ? statusList.parse(req.query.status.split(",").map((s) => s.trim())) : undefined;
    return { claims: await svc.store.list({ status, limit: Number(req.query.limit) || undefined }), counts: await svc.store.counts() };
  });
  app.post<{ Querystring: { limit?: string } }>("/admin/early/mint-pending", async (req) => svc.mintPending({ limit: Number(req.query.limit) || undefined }));
  app.delete<{ Params: { id: string } }>("/admin/early/claims/:id", async (req) => {
    const c = await svc.store.get(req.params.id);
    if (!c) throw new ServiceError(404, "claim_not_found", "No such claim");
    if (c.status === "minted" || c.status === "paid" || c.status === "refund_due") throw new ServiceError(409, "claim_paid", "Paid or minted claims cannot be deleted");
    await svc.store.delete(c.id);
    return { deleted: c.id };
  });
}

/** Re-exported for the server wiring. */
export type { JsonRpc };
