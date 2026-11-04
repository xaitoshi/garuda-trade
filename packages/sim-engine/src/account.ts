import type { BalanceAdjustment, Fill, FundingPayment, Order, Position } from "./types.js";

const EPS = 1e-12;

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
  /** Payout sweeps and reversals: the only non-trading balance changes. Append-only. */
  readonly adjustments: BalanceAdjustment[] = [];
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

  /**
   * Rebuild an account from its persisted ledger (orders as last saved, every fill, every funding payment).
   * Balance, realized PnL, fees, funding and average-entry positions are all DERIVED by replaying the ledger,
   * so a restart cannot drift from what was recorded.
   */
  static restore(input: {
    id: string;
    startingBalance: number;
    orders: Order[];
    fills: Fill[];
    fundingPayments: FundingPayment[];
    adjustments?: BalanceAdjustment[];
    marks?: Record<string, number>;
    fundingAccruedTo?: Record<string, number>;
    seq?: number;
  }): SimAccount {
    const a = new SimAccount({ id: input.id, startingBalance: input.startingBalance });
    for (const o of input.orders) a.orders.set(o.id, { ...o });
    for (const f of input.fills) a.replayFill(f);
    for (const p of input.fundingPayments) {
      a.balance -= p.amount;
      a.fundingPaid += p.amount;
      a.fundingPayments.push({ ...p });
    }
    for (const adj of input.adjustments ?? []) a.applyAdjustment(adj);
    for (const [k, v] of Object.entries(input.marks ?? {})) a.setMark(k, v);
    for (const [k, v] of Object.entries(input.fundingAccruedTo ?? {})) a.fundingAccruedTo.set(k, v);
    const maxFromIds = Math.max(0, ...[...a.orders.keys(), ...a.fills.map((f) => f.id)].map((id) => Number(id.split("_").pop()) || 0));
    a.seq = Math.max(input.seq ?? 0, maxFromIds);
    return a;
  }

  /** Apply one recorded fill to balance and position (the same average-entry rules the engine used). */
  private replayFill(f: Fill): void {
    const pos = this.positions.get(f.symbol);
    const cur = pos?.size ?? 0;
    const entry = pos?.entryPrice ?? f.price;
    const signed = f.side === "buy" ? f.size : -f.size;
    let newEntry = entry;
    if (Math.abs(cur) <= EPS || Math.sign(cur) === Math.sign(signed)) {
      newEntry = (Math.abs(cur) * entry + f.size * f.price) / (Math.abs(cur) + f.size);
    } else if (f.size > Math.abs(cur) + EPS) {
      newEntry = f.price;
    }
    this.balance += f.realizedPnl - f.fee;
    this.realizedPnl += f.realizedPnl;
    this.feesPaid += f.fee;
    if (Math.abs(f.positionAfter) <= EPS) this.positions.delete(f.symbol);
    else this.positions.set(f.symbol, { symbol: f.symbol, size: f.positionAfter, entryPrice: newEntry });
    this.fills.push({ ...f });
  }

  /** Record a balance adjustment. Returns false (and changes nothing) when an adjustment with the same id is already recorded. */
  applyAdjustment(adj: BalanceAdjustment): boolean {
    if (this.adjustments.some((a) => a.id === adj.id)) return false;
    this.balance += adj.amount;
    this.adjustments.push({ ...adj });
    return true;
  }

  hasAdjustment(id: string): boolean {
    return this.adjustments.some((a) => a.id === id);
  }

  /** Net USD swept out of the account by payouts (sweeps minus reversals). */
  payoutsSwept(): number {
    let n = 0;
    for (const a of this.adjustments) n -= a.amount;
    return n;
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
