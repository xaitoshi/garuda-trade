import { createHmac } from "node:crypto";
import { createTokenIfMissing, findAssociatedTokenPda, transferTokensChecked } from "@metaplex-foundation/mpl-toolbox";
import { keypairIdentity, publicKey, type Keypair, type PublicKey, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import { assertDevnetUrl } from "./cluster.js";
import type { JsonRpc } from "./rpc.js";
import { RpcError } from "./rpc.js";
import { USDC_DECIMALS } from "./types.js";
import { withReference } from "./usdc.js";

/**
 * Payout execution seam (M8). The payout service decides WHO gets WHAT and when; an executor moves the money.
 *
 *   SolanaTreasuryPayout   devnet: the platform key sends USDC straight from the treasury token account.
 *   SquadsPayoutExecutor   the production design: the same payout becomes a Squads multisig vault transaction that
 *                          signers approve. Stubbed here; the interface below is what it has to satisfy.
 *
 * Contract every executor must keep (the service relies on it):
 *  - `submit` is idempotent per `payoutId`. Calling it again after a crash, a timeout or a lost response must never
 *    move money twice: it finds the earlier transfer (or proposal) and returns that instead.
 *  - `status` is a read-only lookup of the same thing, used by reconcile to learn what happened to a payout whose
 *    outcome the service never recorded.
 *  - A failure that cannot fix itself (bad destination, executor not implemented, a found transfer that does not match
 *    the request) throws `PayoutChainError` with `retryable: false`. Everything else (RPC down, treasury short of
 *    USDC) is retryable and the service backs off.
 */
export interface PayoutRequest {
  payoutId: string;
  /** The wallet that receives the USDC: the signed-in wallet that requested the payout. */
  destination: string;
  amountBaseUnits: bigint;
}

export type PayoutSubmitResult =
  /** The transfer is on chain. `alreadySent` is true when an earlier attempt had already done it. */
  | { kind: "paid"; signature: string; alreadySent: boolean }
  /** A multisig proposal exists and waits for signers. `status` reports `paid` once it executed. */
  | { kind: "proposed"; proposalId: string };

export type PayoutLookup = { kind: "paid"; signature: string } | { kind: "pending"; proposalId?: string } | { kind: "none" };

export interface PayoutExecutor {
  /** Short stable name shown in the ledger and /health: `treasury-key` or `squads`. */
  readonly name: string;
  readonly mint: string;
  /** The token account the money leaves from. */
  readonly source: string;
  readonly decimals: number;
  submit(req: PayoutRequest): Promise<PayoutSubmitResult>;
  status(req: PayoutRequest): Promise<PayoutLookup>;
}

export class PayoutChainError extends Error {
  constructor(
    readonly code: "bad_destination" | "treasury_insufficient" | "reference_mismatch" | "squads_not_implemented" | "rpc_error" | "send_failed",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PayoutChainError";
  }
}

/** Deterministic reference key for one payout, derived from the platform secret: only we can compute it, so nobody can squat it. */
export function payoutReferenceKeypair(umi: Pick<Umi, "eddsa">, secret: Uint8Array, payoutId: string): Keypair {
  const seed = createHmac("sha256", Buffer.from(secret)).update(`garuda-payout:${payoutId}`).digest();
  return umi.eddsa.createKeypairFromSeed(new Uint8Array(seed));
}

export interface SolanaTreasuryPayoutOptions {
  rpcUrl: string;
  rpc: JsonRpc;
  mint: string;
  /** The platform key. On devnet it is the treasury: it owns the source token account and pays every network fee. */
  treasury: Keypair;
  decimals?: number;
  configureUmi?: (umi: Umi) => void;
}

type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type ParsedTx = { meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null };

const isValidAddress = (a: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/**
 * Devnet payout executor: USDC leaves the treasury token account in one transaction signed by the platform key. The
 * transaction carries a reference key derived from the payout id (same trick as refunds), so a retry first looks the
 * reference up and returns the earlier signature instead of paying twice. The treasury also pays the network fee and
 * any rent for creating the trader's USDC token account (rulebook section 11: Garuda pays network fees).
 */
export class SolanaTreasuryPayout implements PayoutExecutor {
  readonly name = "treasury-key";
  readonly mint: string;
  readonly decimals: number;
  readonly umi: Umi;
  readonly source: string;

  constructor(private readonly o: SolanaTreasuryPayoutOptions) {
    assertDevnetUrl(o.rpcUrl);
    this.mint = o.mint;
    this.decimals = o.decimals ?? USDC_DECIMALS;
    this.umi = createUmi(o.rpcUrl, { commitment: "confirmed" }).use(mplToolbox());
    this.umi.use(keypairIdentity(o.treasury));
    o.configureUmi?.(this.umi);
    this.source = findAssociatedTokenPda(this.umi, { mint: publicKey(this.mint), owner: this.umi.identity.publicKey })[0];
  }

  get treasury(): string {
    return this.umi.identity.publicKey;
  }

  private ata(owner: string): PublicKey {
    return findAssociatedTokenPda(this.umi, { mint: publicKey(this.mint), owner: publicKey(owner) })[0];
  }

  private reference(payoutId: string): string {
    return payoutReferenceKeypair(this.umi, this.o.treasury.secretKey, payoutId).publicKey;
  }

  /** The signature of a successful transfer carrying this payout's reference, if one exists. */
  private async findSent(req: PayoutRequest): Promise<string | undefined> {
    let sigs: { signature: string; err: unknown }[];
    try {
      sigs = (await this.o.rpc.call("getSignaturesForAddress", [this.reference(req.payoutId), { limit: 5, commitment: "confirmed" }])) as { signature: string; err: unknown }[];
    } catch (e) {
      throw new PayoutChainError("rpc_error", `reference lookup failed: ${(e as Error).message}`, true);
    }
    const done = sigs.find((s) => !s.err);
    if (!done) return undefined;
    // Belt and braces: what we found must be the transfer we would have sent, not merely a transaction naming the key.
    const moved = await this.movedTo(done.signature, req.destination);
    if (moved === undefined) throw new PayoutChainError("rpc_error", `transaction ${done.signature} is not readable yet`, true);
    if (moved < req.amountBaseUnits) {
      throw new PayoutChainError("reference_mismatch", `transaction ${done.signature} carries payout ${req.payoutId}'s reference but moved ${moved} base units, expected ${req.amountBaseUnits}`, false);
    }
    return done.signature;
  }

  /** Net USDC base units that arrived at `destination`'s wallet in a transaction, from its own token balances. */
  private async movedTo(signature: string, destination: string): Promise<bigint | undefined> {
    let tx: ParsedTx | null;
    try {
      tx = (await this.o.rpc.call("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
    } catch (e) {
      throw new PayoutChainError("rpc_error", `getTransaction failed: ${(e as Error).message}`, true);
    }
    if (!tx?.meta || tx.meta.err) return undefined;
    const pre = new Map<number, bigint>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === this.mint && b.owner === destination) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    let total = 0n;
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.mint !== this.mint || b.owner !== destination) continue;
      total += BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
    }
    return total;
  }

  private async treasuryBalance(): Promise<bigint> {
    try {
      const r = (await this.o.rpc.call("getTokenAccountBalance", [this.source, { commitment: "confirmed" }])) as { value: { amount: string } };
      return BigInt(r.value.amount);
    } catch (e) {
      // "could not find account": the treasury token account does not exist yet, so it holds nothing.
      if (e instanceof RpcError && /could not find account|invalid param/i.test(e.message)) return 0n;
      throw new PayoutChainError("rpc_error", `treasury balance lookup failed: ${(e as Error).message}`, true);
    }
  }

  async status(req: PayoutRequest): Promise<PayoutLookup> {
    const sig = await this.findSent(req);
    return sig ? { kind: "paid", signature: sig } : { kind: "none" };
  }

  async submit(req: PayoutRequest): Promise<PayoutSubmitResult> {
    if (!isValidAddress(req.destination)) throw new PayoutChainError("bad_destination", `${req.destination} is not a Solana address`, false);
    try {
      publicKey(req.destination);
    } catch {
      throw new PayoutChainError("bad_destination", `${req.destination} is not a Solana address`, false);
    }
    if (req.amountBaseUnits <= 0n) throw new PayoutChainError("bad_destination", "payout amount must be positive", false);

    // 1. An earlier attempt may have landed (crash after send, lost response): never pay twice.
    const prior = await this.findSent(req);
    if (prior) return { kind: "paid", signature: prior, alreadySent: true };

    // 2. A payout the treasury cannot cover waits (retryable) rather than failing on chain and burning a fee.
    const have = await this.treasuryBalance();
    if (have < req.amountBaseUnits) {
      throw new PayoutChainError("treasury_insufficient", `treasury holds ${have} base units of the payout mint, payout needs ${req.amountBaseUnits}`, true);
    }

    // 3. Create the trader's token account if it is missing, then transfer; the reference key rides on the transfer.
    const b = withReference(
      createTokenIfMissing(this.umi, { mint: publicKey(this.mint), owner: publicKey(req.destination) }).add(
        transferTokensChecked(this.umi, {
          source: publicKey(this.source),
          destination: this.ata(req.destination),
          mint: publicKey(this.mint),
          authority: this.umi.identity,
          amount: req.amountBaseUnits,
          decimals: this.decimals,
        }),
      ),
      this.reference(req.payoutId),
    );
    try {
      const res = await b.sendAndConfirm(this.umi);
      return { kind: "paid", signature: base58.deserialize(res.signature)[0], alreadySent: false };
    } catch (e) {
      // The send may have landed even though we did not hear back: the service must not retry before the blockhash
      // has expired, and the next attempt starts with the reference lookup above.
      throw new PayoutChainError("send_failed", `send failed: ${(e as Error).message}`, true);
    }
  }
}

/**
 * The production executor: a Squads v4 multisig vault pays out, so no single hot key can move treasury funds.
 *
 * NOT IMPLEMENTED. The shape it has to take, so the swap is mechanical when the owner picks multisig members:
 *
 *   submit(req)   build the same transfer instructions as SolanaTreasuryPayout but with the Squads VAULT PDA as the
 *                 authority and source owner, wrap them in `vaultTransactionCreate` (transactionIndex derived from the
 *                 payout id so it is idempotent: look up the proposal for that index first), then `proposalCreate` and
 *                 the proposer's own `proposalApprove`. Return `{ kind: "proposed", proposalId }`.
 *   status(req)   fetch the proposal: `Executed` -> find the execution signature and return `{ kind: "paid", signature }`;
 *                 `Rejected` or `Cancelled` -> throw non-retryable so the service reverses the payout;
 *                 anything else -> `{ kind: "pending", proposalId }`. Signers approve in the Squads UI; a small executor
 *                 (or any member) runs `vaultTransactionExecute` once the threshold is met.
 *
 * The payout service already handles the `proposed` -> `submitted` -> `paid` path (it keeps polling `status`).
 */
export class SquadsPayoutExecutor implements PayoutExecutor {
  readonly name = "squads";
  readonly source = "";
  constructor(
    readonly mint: string,
    readonly decimals: number = USDC_DECIMALS,
  ) {}

  async submit(_req: PayoutRequest): Promise<PayoutSubmitResult> {
    throw new PayoutChainError("squads_not_implemented", "Squads multisig payouts are not implemented yet", false);
  }

  async status(_req: PayoutRequest): Promise<PayoutLookup> {
    throw new PayoutChainError("squads_not_implemented", "Squads multisig payouts are not implemented yet", false);
  }
}
