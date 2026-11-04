/**
 * Payment seam. Real USDC checkout on Solana (verify the tx, then mint / create the account) is roadmap M4.
 * Phase 1 only needs the interface and a stub so the revive flow can be exercised end to end.
 */
export interface PaymentRequest {
  wallet: string;
  amountUsd: number;
  kind: "revive" | "challenge";
  /** What is being bought, e.g. the wounded challenge id. */
  reference: string;
  idempotencyKey?: string;
}

export interface PaymentReceipt {
  ok: boolean;
  /** Payment reference (a Solana tx signature in the real implementation). */
  ref?: string;
  error?: string;
}

export interface PaymentProvider {
  charge(req: PaymentRequest): Promise<PaymentReceipt>;
}

/** Always succeeds unless told otherwise, and remembers what it was asked to charge. NOT a payment system. */
export class StubPaymentProvider implements PaymentProvider {
  readonly charges: PaymentRequest[] = [];
  failWith?: string;
  private n = 0;

  async charge(req: PaymentRequest): Promise<PaymentReceipt> {
    if (this.failWith) return { ok: false, error: this.failWith };
    this.charges.push(req);
    this.n += 1;
    return { ok: true, ref: `stub_${req.kind}_${this.n}` };
  }
}
