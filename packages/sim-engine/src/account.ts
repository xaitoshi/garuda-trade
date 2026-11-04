import type { Fill, FundingPayment, Order, Position } from "./types.js";

export interface SimAccountOptions {
  id: string;
  startingBalance: number;
}

/**
 * Simulated account ledger. `balance` is realized cash:
 *   startingBalance + realized PnL - fees - funding paid.
 * `equity(…)` adds unrealized PnL marked at the latest mark prices.
 */
export class SimAccount {
  readonly id: string;
  readonly startingBalance: number;
  balance: number;
  realizedPnl = 0;
  feesPaid = 0;
  fundingPaid = 0;
  readonly positions = new Map<string, Position>();
  readonly orders = new Map<string, Order>();
  readonly fills: Fill[] = [];
  readonly fundingPayments: FundingPayment[] = [];
  /** Latest mark price per symbol. */
  readonly marks = new Map<string, number>();
  /** Per-symbol ms epoch up to which funding has been accrued. */
  readonly fundingAccruedTo = new Map<string, number>();
  seq = 0;

  constructor(opts: SimAccountOptions) {
    this.id = opts.id;
    this.startingBalance = opts.startingBalance;
    this.balance = opts.startingBalance;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.id}_${this.seq}`;
  }

  setMark(symbol: string, price: number): void {
    if (Number.isFinite(price) && price > 0) this.marks.set(symbol, price);
  }

  markOf(symbol: string): number | undefined {
    const p = this.positions.get(symbol);
    return this.marks.get(symbol) ?? p?.entryPrice;
  }

  unrealizedPnl(): number {
    let u = 0;
    for (const p of this.positions.values()) {
      const mark = this.markOf(p.symbol) ?? p.entryPrice;
      u += (mark - p.entryPrice) * p.size;
    }
    return u;
  }

  equity(): number {
    return this.balance + this.unrealizedPnl();
  }

  /** Sum of |size| * mark across open positions. */
  grossNotional(): number {
    let n = 0;
    for (const p of this.positions.values()) n += Math.abs(p.size) * (this.markOf(p.symbol) ?? p.entryPrice);
    return n;
  }

  openOrders(symbol?: string): Order[] {
    return [...this.orders.values()].filter(
      (o) =>
        (o.status === "open" || o.status === "partially_filled") && o.remaining > 1e-12 && (!symbol || o.symbol === symbol),
    );
  }

  positionSize(symbol: string): number {
    return this.positions.get(symbol)?.size ?? 0;
  }
}
