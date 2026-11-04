import { randomUUID } from "node:crypto";
import { levelMetadataUri, sameAttrs } from "./metadata.js";
import type { RefundInput, UsdcChain, VerifyPaymentInput, VerifyPaymentResult } from "./usdc.js";
import type { KnightInfo, KnightNft, MintKnightInput, MintKnightResult, UpdateKnightInput } from "./types.js";

/** In-memory knight chain for service tests: same rules the real one enforces (frozen assets cannot move, mint is idempotent per order). */
export class FakeKnights implements KnightNft {
  readonly collection = "FakeCollection1111111111111111111111111111111";
  readonly assets = new Map<string, KnightInfo>();
  readonly mintedByOrder = new Map<string, string>();
  mintCalls = 0;
  updateCalls = 0;
  /** Make the next N mint calls throw (RPC down). */
  failMints = 0;
  failUpdates = 0;
  log: string[] = [];

  async get(asset: string) {
    const a = this.assets.get(asset);
    return a ? { ...a } : undefined;
  }

  async mint(i: MintKnightInput): Promise<MintKnightResult> {
    const prior = this.mintedByOrder.get(i.orderId);
    if (prior) return { asset: prior, alreadyMinted: true };
    this.mintCalls++;
    if (this.failMints > 0) {
      this.failMints--;
      throw new Error("rpc unavailable");
    }
    const asset = `FakeKnight${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.assets.set(asset, { ...i.attrs, asset, owner: i.owner, frozen: i.frozen, name: i.name, uri: levelMetadataUri("http://fake", i.attrs.level), genuine: true });
    this.mintedByOrder.set(i.orderId, asset);
    this.log.push(`mint ${asset} -> ${i.owner}`);
    return { asset, signature: `mintsig_${asset}`, alreadyMinted: false };
  }

  async update(i: UpdateKnightInput): Promise<string | undefined> {
    const a = this.assets.get(i.asset);
    if (!a) throw new Error("knight not found");
    if (this.failUpdates > 0) {
      this.failUpdates--;
      throw new Error("rpc unavailable");
    }
    if (sameAttrs(a, i.attrs) && a.frozen === i.frozen) return undefined;
    this.updateCalls++;
    Object.assign(a, i.attrs, { frozen: i.frozen, uri: levelMetadataUri("http://fake", i.attrs.level) });
    this.log.push(`update ${i.asset} ${i.attrs.level}/${i.attrs.status}${i.frozen ? " frozen" : ""}`);
    return `updsig_${this.updateCalls}`;
  }

  async listByOwner(owner: string) {
    return [...this.assets.values()].filter((a) => a.owner === owner && a.genuine).map((a) => ({ ...a }));
  }

  /** Wallet-to-wallet transfer. Throws when the knight is frozen, like Metaplex Core does. */
  transfer(asset: string, to: string): void {
    const a = this.assets.get(asset);
    if (!a) throw new Error("knight not found");
    if (a.frozen) throw new Error("Asset is frozen");
    a.owner = to;
  }

  /** A lookalike minted outside the Garuda collection with attributes the owner wrote himself. */
  forge(asset: string, owner: string, level: KnightInfo["level"]): void {
    this.assets.set(asset, { asset, owner, level, status: "active", tier: level, challengeId: "x", wins: 0, revives: 0, frozen: false, name: "fake", uri: "x", genuine: false });
  }
}

export interface FakePayment {
  signature: string;
  wallet: string;
  reference: string;
  amountBaseUnits: bigint;
  payerTokenAccount?: string;
  /** Block time (ms). Default: now. */
  at?: number;
  failed?: boolean;
  /** Pay a different wallet's account instead (payer_balance_mismatch). */
  wrongPayer?: boolean;
}

/** In-memory USDC chain: tests register the transfers a wallet "sent", then the service verifies them. */
export class FakeUsdc implements UsdcChain {
  readonly mint = "FakeUsdcMint11111111111111111111111111111111";
  readonly treasury = "FakeTreasury1111111111111111111111111111111";
  readonly decimals = 6;
  readonly payments = new Map<string, FakePayment>();
  readonly refunds = new Map<string, RefundInput & { signature: string }>();
  failRefunds = 0;
  verifyCalls = 0;

  addPayment(p: FakePayment): string {
    this.payments.set(p.signature, p);
    return p.signature;
  }

  async verifyPayment(i: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    this.verifyCalls++;
    const p = this.payments.get(i.signature);
    if (!p) return { status: "pending" };
    if (p.failed) return { status: "invalid", reason: "transaction_failed" };
    if (p.reference !== i.reference) return { status: "invalid", reason: "reference_missing" };
    if (p.wallet !== i.wallet) return { status: "invalid", reason: "payer_not_signer" };
    if (p.wrongPayer) return { status: "invalid", reason: "payer_balance_mismatch" };
    if (p.at !== undefined && p.at < i.notBeforeMs - 120_000) return { status: "invalid", reason: "too_old" };
    if (p.amountBaseUnits <= 0n) return { status: "invalid", reason: "no_transfer_to_treasury" };
    if (p.amountBaseUnits < i.amountBaseUnits) return { status: "invalid", reason: "underpaid", detail: { paid: p.amountBaseUnits.toString(), required: i.amountBaseUnits.toString() } };
    return {
      status: "confirmed",
      payerTokenAccount: p.payerTokenAccount ?? `payer_ata_${p.wallet.slice(0, 6)}`,
      paidBaseUnits: p.amountBaseUnits,
      excessBaseUnits: p.amountBaseUnits - i.amountBaseUnits,
      blockTimeMs: p.at,
    };
  }

  async refund(i: RefundInput) {
    const prior = this.refunds.get(i.orderId);
    if (prior) return { signature: prior.signature, alreadyRefunded: true };
    if (this.failRefunds > 0) {
      this.failRefunds--;
      throw new Error("rpc unavailable");
    }
    const signature = `refundsig_${this.refunds.size + 1}`;
    this.refunds.set(i.orderId, { ...i, signature });
    return { signature, alreadyRefunded: false };
  }
}
