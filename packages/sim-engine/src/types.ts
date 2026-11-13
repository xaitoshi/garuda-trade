export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type Liquidity = "taker" | "maker";

/** [price, size] in quote / base units, as returned by the Phoenix L2 orderbook. */
export type Level = readonly [price: number, size: number];

export interface L2Book {
  /** Phoenix market symbol, e.g. "SOL" (the "-PERP" suffix is stripped upstream). */
  symbol: string;
  /** Best bid first (descending price). */
  bids: Level[];
  /** Best ask first (ascending price). */
  asks: Level[];
  /** ms epoch the book was observed. */
  ts: number;
}

export interface FeeSchedule {
  /** Fraction of notional, e.g. 0.00035 = 3.5 bps. */
  takerFeeRate: number;
  makerFeeRate: number;
}

/** Phoenix Perps base fees: 0.035% taker / 0.005% maker. */
export const PHOENIX_FEES: FeeSchedule = { takerFeeRate: 0.00035, makerFeeRate: 0.00005 };

export interface Position {
  symbol: string;
  /** Signed base size: >0 long, <0 short. */
  size: number;
  entryPrice: number;
}

export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled" | "rejected";

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  /** Requested base size. */
  size: number;
  remaining: number;
  limitPrice?: number;
  reduceOnly: boolean;
  postOnly: boolean;
  status: OrderStatus;
  rejectReason?: string;
  createdAt: number;
  updatedAt: number;
  /** Take-profit attached to an entry: on each fill the service places a reduce-only limit here for the filled size. */
  takeProfit?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  price: number;
  size: number;
  notional: number;
  fee: number;
  liquidity: Liquidity;
  /** Gross realized PnL from the portion of this fill that closed existing exposure (before fee). */
  realizedPnl: number;
  /** Base size of existing exposure this fill closed (0 for a pure open). */
  closedSize: number;
  /** Direction of the exposure that was closed, if any. */
  closedDirection?: "long" | "short";
  /** Signed position size after the fill. */
  positionAfter: number;
  /** True when produced by forced liquidation / breach close-out. */
  forced: boolean;
  ts: number;
}

export interface FundingPayment {
  symbol: string;
  /** Positive = account paid, negative = account received. */
  amount: number;
  rateHourly: number;
  markPrice: number;
  positionSize: number;
  ts: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  size: number;
  type: OrderType;
  limitPrice?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
}

export interface OrderResult {
  order: Order;
  fills: Fill[];
  /** Volume-weighted average fill price of this call, if any fill happened. */
  avgPrice?: number;
  /** Adverse slippage vs the arrival mid, in bps (positive = worse). */
  slippageBps?: number;
}

/**
 * A non-trading change to the cash balance, recorded in the account ledger so a replay reproduces it.
 * `amount` is the SIGNED change to balance: a payout sweep is negative, its reversal (a rejected payout) is positive.
 * `id` is unique per account: applying the same id twice is a no-op, which makes payout retries idempotent.
 */
export interface BalanceAdjustment {
  id: string;
  kind: "payout_sweep" | "payout_reversal" | "level_up";
  amount: number;
  /** What caused it (the payout id). */
  ref: string;
  ts: number;
}
