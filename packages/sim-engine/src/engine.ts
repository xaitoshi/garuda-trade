import { SimAccount } from "./account.js";
import {
  PHOENIX_FEES,
  type FeeSchedule,
  type Fill,
  type FundingPayment,
  type L2Book,
  type Liquidity,
  type Order,
  type OrderRequest,
  type OrderResult,
  type Side,
} from "./types.js";

/**
 * Pre-fill gate for RESTING limit orders. Called just before a resting order would fill `size` at `price`.
 * Return the size that may fill (0 cancels the order); a smaller size trims the fill and cancels the rest.
 * Used by the API to re-check the leverage cap at fill time (a resting order was only checked at placement).
 */
export type RestingFillGate = (order: Order, size: number, price: number) => { size: number; reason?: string };

export interface EngineOptions {
  fees?: FeeSchedule;
  /**
   * Extra adverse price shift applied to taker (market / crossing) fills, in bps.
   * Models the latency gap between the quote the trader saw and our fill. Default 0.
   */
  latencyPenaltyBps?: number;
  /**
   * Fraction of resting-limit-order size we allow to fill per book update when the book crosses.
   * 1 = optimistic (fill everything that crosses). Default 1.
   */
  makerFillRatio?: number;
  /** Adverse haircut (bps vs mark) used for any force-close remainder the book cannot absorb. Default 100. */
  forceCloseHaircutBps?: number;
}

const EPS = 1e-12;

function mid(book: L2Book): number | undefined {
  const b = book.bids[0]?.[0];
  const a = book.asks[0]?.[0];
  if (b === undefined || a === undefined) return undefined;
  return (a + b) / 2;
}

/**
 * Deterministic simulated matching engine. It never talks to the network: callers pass in the
 * live L2 book (Phoenix) so the engine is trivially testable and replayable.
 *
 *  - Market orders walk the book level by level (taker fee).
 *  - Limit orders fill immediately as taker for the crossing part, the remainder rests (maker fee).
 *  - Resting orders fill when a later book update crosses them (maker fee, at the limit price).
 *  - Funding accrues pro-rata from the hourly rate.
 */
export class SimEngine {
  readonly fees: FeeSchedule;
  private readonly latencyBps: number;
  private readonly makerFillRatio: number;
  private readonly forceHaircutBps: number;

  constructor(opts: EngineOptions = {}) {
    this.fees = opts.fees ?? PHOENIX_FEES;
    this.latencyBps = opts.latencyPenaltyBps ?? 0;
    this.makerFillRatio = opts.makerFillRatio ?? 1;
    this.forceHaircutBps = opts.forceCloseHaircutBps ?? 100;
  }

  // ---------------------------------------------------------------- orders

  submit(account: SimAccount, req: OrderRequest, book: L2Book, now: number): OrderResult {
    const order: Order = {
      id: account.nextId("ord"),
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      size: req.size,
      remaining: req.size,
      limitPrice: req.limitPrice,
      reduceOnly: req.reduceOnly ?? false,
      postOnly: req.postOnly ?? false,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    account.orders.set(order.id, order);

    const reject = (reason: string): OrderResult => {
      order.status = "rejected";
      order.rejectReason = reason;
      order.remaining = 0;
      return { order, fills: [] };
    };

    if (req.symbol !== book.symbol) return reject("book_symbol_mismatch");
    if (!(req.size > 0) || !Number.isFinite(req.size)) return reject("invalid_size");
    if (req.type === "limit" && !(req.limitPrice! > 0)) return reject("invalid_limit_price");
    if (req.type === "market" && req.postOnly) return reject("post_only_market");

    const m = mid(book);
    if (m !== undefined) account.setMark(req.symbol, m);

    // reduce-only: clamp to the opposite-direction position.
    if (order.reduceOnly) {
      const pos = account.positionSize(order.symbol);
      const reducible = req.side === "buy" ? Math.max(0, -pos) : Math.max(0, pos);
      if (reducible <= EPS) return reject("reduce_only_no_position");
      order.remaining = Math.min(order.remaining, reducible);
    }

    const levels = req.side === "buy" ? book.asks : book.bids;
    const crosses = (price: number) =>
      req.type === "market" ||
      (req.side === "buy" ? price <= req.limitPrice! + EPS : price >= req.limitPrice! - EPS);

    if (req.type === "limit" && req.postOnly) {
      const best = levels[0]?.[0];
      if (best !== undefined && crosses(best)) return reject("post_only_would_cross");
    }

    // Walk the book.
    const fills: Fill[] = [];
    let remaining = order.remaining;
    for (const [price, size] of levels) {
      if (remaining <= EPS) break;
      if (!crosses(price)) break;
      const take = Math.min(remaining, size);
      if (take <= EPS) continue;
      const slipped = this.applyLatency(price, req.side);
      // A limit order never fills worse than its limit even with the latency penalty.
      const px =
        req.type === "limit"
          ? req.side === "buy"
            ? Math.min(slipped, req.limitPrice!)
            : Math.max(slipped, req.limitPrice!)
          : slipped;
      fills.push(this.applyFill(account, order, take, px, "taker", now, false));
      remaining -= take;
    }
    order.remaining = remaining;
    this.settleOrderStatus(order, fills.length > 0, req.type, remaining, now);

    return { order, fills, ...this.execStats(fills, req.side, m) };
  }

  cancel(account: SimAccount, orderId: string, now: number): Order | undefined {
    const o = account.orders.get(orderId);
    if (!o) return undefined;
    if (o.status === "open" || o.status === "partially_filled") {
      o.status = "cancelled";
      o.updatedAt = now;
    }
    return o;
  }

  /**
   * Feed a fresh book for a symbol: updates the mark (mid) and fills any resting limit orders
   * that the book now crosses. Fills execute at the order's limit price (maker fee).
   */
  onBook(account: SimAccount, book: L2Book, now: number, gate?: RestingFillGate): Fill[] {
    const m = mid(book);
    if (m !== undefined) account.setMark(book.symbol, m);
    const out: Fill[] = [];
    for (const order of account.openOrders(book.symbol)) {
      if (order.type !== "limit" || order.limitPrice === undefined) continue;
      const lp = order.limitPrice;
      const levels = order.side === "buy" ? book.asks : book.bids;
      let avail = 0;
      for (const [price, size] of levels) {
        const ok = order.side === "buy" ? price <= lp + EPS : price >= lp - EPS;
        if (!ok) break;
        avail += size;
      }
      if (avail <= EPS) continue;

      let cap = order.remaining;
      if (order.reduceOnly) {
        const pos = account.positionSize(order.symbol);
        const reducible = order.side === "buy" ? Math.max(0, -pos) : Math.max(0, pos);
        cap = Math.min(cap, reducible);
        if (cap <= EPS) {
          order.status = "cancelled";
          order.rejectReason = "reduce_only_no_position";
          order.remaining = 0;
          order.updatedAt = now;
          continue;
        }
      }
      let take = Math.min(cap, avail * this.makerFillRatio);
      if (take <= EPS) continue;
      let trimmedReason: string | undefined;
      if (gate) {
        const g = gate(order, take, lp);
        if (g.size < take - EPS) trimmedReason = g.reason ?? "gate";
        take = Math.max(0, Math.min(take, g.size));
      }
      if (take > EPS) {
        out.push(this.applyFill(account, order, take, lp, "maker", now, false));
        order.remaining -= take;
      }
      if (trimmedReason) {
        // Fill-time rule hit: whatever the gate refused is cancelled, the order does not keep resting.
        order.status = "cancelled";
        order.rejectReason = trimmedReason;
        order.remaining = 0;
      } else if (order.remaining <= EPS) {
        order.remaining = 0;
        order.status = "filled";
      } else {
        order.status = "partially_filled";
      }
      order.updatedAt = now;
    }
    return out;
  }

  // --------------------------------------------------------------- funding

  /**
   * Accrue funding for one symbol from the last accrual time to `now`.
   * `rateHourly` is a FRACTION per hour (0.0001 = 1 bp/h). Positive = longs pay shorts.
   * Payment = size * mark * rate * hours, so a long pays when the rate is positive.
   */
  accrueFunding(
    account: SimAccount,
    symbol: string,
    markPrice: number,
    rateHourly: number,
    now: number,
  ): FundingPayment | undefined {
    const from = account.fundingAccruedTo.get(symbol);
    account.fundingAccruedTo.set(symbol, now);
    if (from === undefined || now <= from) return undefined;
    const size = account.positionSize(symbol);
    if (Math.abs(size) <= EPS) return undefined;
    const hours = (now - from) / 3_600_000;
    const amount = size * markPrice * rateHourly * hours;
    account.balance -= amount;
    account.fundingPaid += amount;
    const payment: FundingPayment = { symbol, amount, rateHourly, markPrice, positionSize: size, ts: now };
    account.fundingPayments.push(payment);
    return payment;
  }

  /** Start the funding clock for a symbol (called when a position is first opened). */
  startFundingClock(account: SimAccount, symbol: string, now: number): void {
    if (!account.fundingAccruedTo.has(symbol)) account.fundingAccruedTo.set(symbol, now);
  }

  // --------------------------------------------------------------- close-out

  /**
   * Flatten every position (breach / pass / end of challenge) and cancel resting orders.
   * Walks the supplied books; any size the book cannot absorb is closed at mark minus a haircut.
   */
  closeAll(account: SimAccount, books: Map<string, L2Book>, now: number): Fill[] {
    for (const o of account.openOrders()) this.cancel(account, o.id, now);
    const out: Fill[] = [];
    for (const pos of [...account.positions.values()]) {
      const side: Side = pos.size > 0 ? "sell" : "buy";
      const book = books.get(pos.symbol);
      const order: Order = {
        id: account.nextId("ord"),
        symbol: pos.symbol,
        side,
        type: "market",
        size: Math.abs(pos.size),
        remaining: Math.abs(pos.size),
        reduceOnly: true,
        postOnly: false,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      account.orders.set(order.id, order);
      let remaining = order.remaining;
      if (book) {
        const levels = side === "buy" ? book.asks : book.bids;
        for (const [price, size] of levels) {
          if (remaining <= EPS) break;
          const take = Math.min(remaining, size);
          out.push(this.applyFill(account, order, take, this.applyLatency(price, side), "taker", now, true));
          remaining -= take;
        }
      }
      if (remaining > EPS) {
        const mark = account.markOf(pos.symbol) ?? pos.entryPrice;
        const h = this.forceHaircutBps / 10_000;
        const px = side === "buy" ? mark * (1 + h) : mark * (1 - h);
        out.push(this.applyFill(account, order, remaining, px, "taker", now, true));
        remaining = 0;
      }
      order.remaining = 0;
      order.status = "filled";
      order.updatedAt = now;
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private applyLatency(price: number, side: Side): number {
    if (this.latencyBps === 0) return price;
    const f = this.latencyBps / 10_000;
    return side === "buy" ? price * (1 + f) : price * (1 - f);
  }

  private settleOrderStatus(
    order: Order,
    anyFill: boolean,
    type: "market" | "limit",
    remaining: number,
    now: number,
  ): void {
    order.updatedAt = now;
    if (remaining <= EPS) {
      order.remaining = 0;
      order.status = "filled";
    } else if (type === "market") {
      // Market orders never rest: unfilled remainder (thin book) is dropped.
      order.status = anyFill ? "partially_filled" : "rejected";
      if (!anyFill) order.rejectReason = "no_liquidity";
      order.remaining = 0;
    } else {
      order.status = anyFill ? "partially_filled" : "open";
    }
  }

  private execStats(fills: Fill[], side: Side, arrivalMid: number | undefined) {
    if (fills.length === 0) return {};
    let n = 0;
    let q = 0;
    for (const f of fills) {
      n += f.price * f.size;
      q += f.size;
    }
    const avgPrice = n / q;
    if (arrivalMid === undefined) return { avgPrice };
    const adverse = side === "buy" ? avgPrice - arrivalMid : arrivalMid - avgPrice;
    return { avgPrice, slippageBps: (adverse / arrivalMid) * 10_000 };
  }

  /** Apply one execution to the position + ledger. Average-entry accounting, supports flips. */
  private applyFill(
    account: SimAccount,
    order: Order,
    size: number,
    price: number,
    liquidity: Liquidity,
    now: number,
    forced: boolean,
  ): Fill {
    const signed = order.side === "buy" ? size : -size;
    const pos = account.positions.get(order.symbol);
    const cur = pos?.size ?? 0;
    const entry = pos?.entryPrice ?? price;

    let realized = 0;
    let closedSize = 0;
    let closedDirection: "long" | "short" | undefined;
    let newSize = cur + signed;
    let newEntry = entry;

    if (Math.abs(cur) <= EPS || Math.sign(cur) === Math.sign(signed)) {
      // opening or adding: blend entry
      const total = Math.abs(cur) + size;
      newEntry = (Math.abs(cur) * entry + size * price) / total;
    } else {
      // reducing / closing / flipping
      closedSize = Math.min(Math.abs(cur), size);
      closedDirection = cur > 0 ? "long" : "short";
      realized = (price - entry) * closedSize * Math.sign(cur);
      if (size > Math.abs(cur) + EPS) {
        newEntry = price; // flipped: remainder opens at fill price
      } else if (Math.abs(newSize) <= EPS) {
        newSize = 0;
      }
    }

    const notional = size * price;
    const rate = liquidity === "taker" ? this.fees.takerFeeRate : this.fees.makerFeeRate;
    const fee = notional * rate;

    account.balance += realized - fee;
    account.realizedPnl += realized;
    account.feesPaid += fee;

    if (Math.abs(newSize) <= EPS) account.positions.delete(order.symbol);
    else account.positions.set(order.symbol, { symbol: order.symbol, size: newSize, entryPrice: newEntry });

    if (Math.abs(cur) <= EPS && Math.abs(newSize) > EPS) this.startFundingClock(account, order.symbol, now);

    const fill: Fill = {
      id: account.nextId("fill"),
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      price,
      size,
      notional,
      fee,
      liquidity,
      realizedPnl: realized,
      closedSize,
      closedDirection,
      positionAfter: Math.abs(newSize) <= EPS ? 0 : newSize,
      forced,
      ts: now,
    };
    account.fills.push(fill);
    return fill;
  }
}
