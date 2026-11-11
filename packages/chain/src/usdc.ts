import { createHmac } from "node:crypto";
import {
  createMint,
  createTokenIfMissing,
  findAssociatedTokenPda,
  mintTokensTo,
  mplToolbox,
  transferTokensChecked,
} from "@metaplex-foundation/mpl-toolbox";
import {
  createSignerFromKeypair,
  generateSigner,
  keypairIdentity,
  publicKey,
  transactionBuilder,
  type Keypair,
  type PublicKey,
  type TransactionBuilder,
  type Umi,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { assertDevnetUrl } from "./cluster.js";
import type { JsonRpc } from "./rpc.js";
import { USDC_DECIMALS } from "./types.js";

export interface VerifyPaymentInput {
  signature: string;
  /** The signed-in wallet that must have paid. */
  wallet: string;
  /** Unique per order (Solana Pay style): must appear among the transaction's accounts, so a transaction cannot be replayed onto another order. */
  reference: string;
  amountBaseUnits: bigint;
  /** ms epoch: the transaction must be at or after this (minus a small skew). */
  notBeforeMs: number;
}

export type VerifyReason =
  | "transaction_failed"
  | "reference_missing"
  | "payer_not_signer"
  | "no_transfer_to_treasury"
  | "underpaid"
  | "payer_balance_mismatch"
  | "too_old"
  | "bad_signature";

export type VerifyPaymentResult =
  | { status: "confirmed"; payerTokenAccount: string; paidBaseUnits: bigint; excessBaseUnits: bigint; blockTimeMs?: number }
  | { status: "pending" }
  | { status: "invalid"; reason: VerifyReason; detail?: Record<string, unknown> };

export interface RefundInput {
  orderId: string;
  /** The payer's token account the funds came from. */
  toTokenAccount: string;
  amountBaseUnits: bigint;
}

/** USDC settlement seam: verify an incoming transfer, send a refund. `SolanaUsdc` is the devnet implementation. */
export interface UsdcChain {
  readonly mint: string;
  readonly treasury: string;
  readonly decimals: number;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  /** Idempotent per order: a second call returns the first refund's signature. */
  refund(input: RefundInput): Promise<{ signature: string; alreadyRefunded: boolean }>;
}

export interface SolanaUsdcOptions {
  rpcUrl: string;
  rpc: JsonRpc;
  /** USDC mint on devnet (Circle devnet USDC or a test SPL mint created with `createTestMint`). */
  mint: string;
  /** Treasury wallet: owns the token account that receives fees. Signs refunds (devnet: the platform keypair). */
  treasury: Keypair;
  decimals?: number;
  commitment?: "confirmed" | "finalized";
  configureUmi?: (umi: Umi) => void;
}

const SKEW_MS = 120_000;

export function refundReferenceKeypair(umi: Pick<Umi, "eddsa">, secret: Uint8Array, orderId: string): Keypair {
  const seed = createHmac("sha256", Buffer.from(secret)).update(`garuda-refund:${orderId}`).digest();
  return umi.eddsa.createKeypairFromSeed(new Uint8Array(seed));
}

/** Append a read-only, non-signer account to the (single) instruction so the transaction carries a reference key. */
export function withReference(builder: TransactionBuilder, reference: string): TransactionBuilder {
  const items = builder.items.map((it, i, arr) =>
    i === arr.length - 1 ? { ...it, instruction: { ...it.instruction, keys: [...it.instruction.keys, { pubkey: publicKey(reference), isSigner: false, isWritable: false }] } } : it,
  );
  return transactionBuilder(items);
}

type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type ParsedTx = {
  blockTime?: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
};

/**
 * Verify an incoming USDC transfer from the transaction's own pre/post token balances (shared by checkout and the
 * /early Beta Access mint). Cluster-agnostic: the caller decides which RPC (and therefore which cluster) it trusts.
 */
export async function verifyUsdcPayment(
  rpc: JsonRpc,
  cfg: { mint: string; treasury: string; commitment?: "confirmed" | "finalized" },
  i: VerifyPaymentInput,
): Promise<VerifyPaymentResult> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(i.signature)) return { status: "invalid", reason: "bad_signature" };
  const tx = (await rpc.call("getTransaction", [i.signature, { encoding: "jsonParsed", commitment: cfg.commitment ?? "confirmed", maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
  if (!tx || !tx.meta) return { status: "pending" };
  if (tx.meta.err) return { status: "invalid", reason: "transaction_failed", detail: { err: tx.meta.err } };
  const keys = tx.transaction.message.accountKeys;
  if (!keys.some((k) => k.pubkey === i.reference)) return { status: "invalid", reason: "reference_missing" };
  if (!keys.some((k) => k.pubkey === i.wallet && k.signer)) return { status: "invalid", reason: "payer_not_signer" };
  const blockTimeMs = tx.blockTime ? tx.blockTime * 1000 : undefined;
  if (blockTimeMs !== undefined && blockTimeMs < i.notBeforeMs - SKEW_MS) return { status: "invalid", reason: "too_old", detail: { blockTimeMs } };

  // Net token movement per token account for the USDC mint, from the transaction's own pre/post balances.
  const delta = new Map<number, { owner?: string; d: bigint }>();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === cfg.mint) delta.set(b.accountIndex, { owner: b.owner, d: -BigInt(b.uiTokenAmount.amount) });
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint !== cfg.mint) continue;
    const e = delta.get(b.accountIndex) ?? { owner: b.owner, d: 0n };
    delta.set(b.accountIndex, { owner: b.owner ?? e.owner, d: e.d + BigInt(b.uiTokenAmount.amount) });
  }
  let toTreasury = 0n;
  let payerIdx: number | undefined;
  let payerDelta = 0n;
  for (const [idx, e] of delta) {
    if (e.owner === cfg.treasury) toTreasury += e.d;
    if (e.owner === i.wallet && e.d < payerDelta) {
      payerDelta = e.d;
      payerIdx = idx;
    }
  }
  if (toTreasury <= 0n) return { status: "invalid", reason: "no_transfer_to_treasury" };
  if (toTreasury < i.amountBaseUnits) return { status: "invalid", reason: "underpaid", detail: { paid: toTreasury.toString(), required: i.amountBaseUnits.toString() } };
  // The money must have left the signing wallet's own token account, not someone else's.
  if (payerIdx === undefined || -payerDelta < i.amountBaseUnits) return { status: "invalid", reason: "payer_balance_mismatch" };
  const payerTokenAccount = keys[payerIdx]?.pubkey;
  if (!payerTokenAccount) return { status: "invalid", reason: "payer_balance_mismatch" };
  return { status: "confirmed", payerTokenAccount, paidBaseUnits: toTreasury, excessBaseUnits: toTreasury - i.amountBaseUnits, blockTimeMs };
}

export class SolanaUsdc implements UsdcChain {
  readonly mint: string;
  readonly treasury: string;
  readonly decimals: number;
  readonly umi: Umi;
  private readonly commitment: "confirmed" | "finalized";

  constructor(private readonly o: SolanaUsdcOptions) {
    assertDevnetUrl(o.rpcUrl);
    this.mint = o.mint;
    this.decimals = o.decimals ?? USDC_DECIMALS;
    this.commitment = o.commitment ?? "confirmed";
    this.umi = createUmi(o.rpcUrl, { commitment: "confirmed" }).use(mplToolbox());
    this.umi.use(keypairIdentity(o.treasury));
    o.configureUmi?.(this.umi);
    this.treasury = this.umi.identity.publicKey;
  }

  /** Treasury associated token account (where fees land). */
  treasuryAta(): PublicKey {
    return findAssociatedTokenPda(this.umi, { mint: publicKey(this.mint), owner: publicKey(this.treasury) })[0];
  }

  /** Create the treasury token account if it is missing (idempotent). Returns its address. */
  async ensureTreasuryAta(): Promise<string> {
    const b = createTokenIfMissing(this.umi, { mint: publicKey(this.mint), owner: publicKey(this.treasury) });
    if (b.items.length > 0) await b.sendAndConfirm(this.umi);
    return this.treasuryAta();
  }

  async verifyPayment(i: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return verifyUsdcPayment(this.o.rpc, { mint: this.mint, treasury: this.treasury, commitment: this.commitment }, i);
  }

  async refund(i: RefundInput): Promise<{ signature: string; alreadyRefunded: boolean }> {
    const ref = refundReferenceKeypair(this.umi, this.o.treasury.secretKey, i.orderId);
    // A refund tx carries a key derived from the order id, so an earlier (possibly unrecorded) refund can be found.
    const prior = (await this.o.rpc.call("getSignaturesForAddress", [ref.publicKey, { limit: 5, commitment: "confirmed" }])) as { signature: string; err: unknown }[];
    const done = prior.find((p) => !p.err);
    if (done) return { signature: done.signature, alreadyRefunded: true };
    const b = withReference(
      transferTokensChecked(this.umi, {
        source: this.treasuryAta(),
        destination: publicKey(i.toTokenAccount),
        mint: publicKey(this.mint),
        authority: this.umi.identity,
        amount: i.amountBaseUnits,
        decimals: this.decimals,
      }),
      ref.publicKey,
    );
    const res = await b.sendAndConfirm(this.umi);
    return { signature: base58.deserialize(res.signature)[0], alreadyRefunded: false };
  }
}

// ---------------------------------------------------------------- devnet test helpers (tests, e2e, scripts)

/** Create a test SPL mint (6 decimals like USDC) whose mint authority is `authority`. Devnet only. */
export async function createTestMint(umi: Umi, mintKeypair: Keypair, decimals = USDC_DECIMALS): Promise<string> {
  const mint = createSignerFromKeypair(umi, mintKeypair);
  await createMint(umi, { mint, decimals, mintAuthority: umi.identity.publicKey }).sendAndConfirm(umi);
  return mint.publicKey;
}

/** Mint test tokens to an owner's associated token account (creating it if needed). Returns the token account. */
export async function mintTestTokens(umi: Umi, mint: string, owner: string, amountBaseUnits: bigint): Promise<string> {
  const ata = findAssociatedTokenPda(umi, { mint: publicKey(mint), owner: publicKey(owner) })[0];
  await createTokenIfMissing(umi, { mint: publicKey(mint), owner: publicKey(owner) })
    .add(mintTokensTo(umi, { mint: publicKey(mint), token: ata, amount: amountBaseUnits, mintAuthority: umi.identity }))
    .sendAndConfirm(umi);
  return ata;
}

/**
 * What the buyer's wallet does at checkout: one SPL transferChecked to the treasury token account carrying the
 * order's reference key. `buyer` signs and pays the fee. Returns the signature. Used by e2e and scripts; a browser
 * wallet builds the same transaction with @solana/spl-token.
 */
export async function payUsdc(
  umi: Umi,
  a: { mint: string; treasuryOwner: string; amountBaseUnits: bigint; reference: string; decimals?: number },
): Promise<string> {
  const mint = publicKey(a.mint);
  const source = findAssociatedTokenPda(umi, { mint, owner: umi.identity.publicKey })[0];
  const dest = findAssociatedTokenPda(umi, { mint, owner: publicKey(a.treasuryOwner) })[0];
  const b = withReference(
    transferTokensChecked(umi, { source, destination: dest, mint, authority: umi.identity, amount: a.amountBaseUnits, decimals: a.decimals ?? USDC_DECIMALS }),
    a.reference,
  );
  const res = await b.sendAndConfirm(umi);
  return base58.deserialize(res.signature)[0];
}

export function newSigner(umi: Umi) {
  return generateSigner(umi);
}
