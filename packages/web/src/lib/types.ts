// Shapes the web app reads from the Garuda API (see packages/api: ChallengeState, PaymentInstructions, ...).
export type TierId = "demo" | "squire" | "knight" | "paladin" | "ascended";
export type Status = "active" | "passed" | "wounded";
export type Lifecycle = "active" | "dormant" | "archived";

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  forced: boolean;
  ts: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  size: number;
  remaining: number;
  limitPrice?: number;
  reduceOnly: boolean;
  postOnly: boolean;
  status: string;
  createdAt: number;
}

export interface CombatEntry {
  ts: number;
  kind: "strike" | "scorch" | "advance" | "warning" | "breach" | "pass" | "dawn" | "tribute";
  text: string;
  amount?: number;
}

export interface Breach {
  type: "breach";
  ts: number;
  rule: "daily_loss" | "max_drawdown";
  alsoBreached?: string;
  equity: number;
  floor: number;
  dailyFloor: number;
  drawdownFloor: number;
}

export interface Risk {
  status: Status;
  ts: number;
  dayKey: string;
  startingBalance: number;
  startOfDayBalance: number;
  balance: number;
  equity: number;
  dailyLossLimit: number;
  dailyFloor: number;
  drawdownFloor: number;
  effectiveFloor: number;
  dailyUsedPct: number;
  drawdownUsedPct: number;
  dailyRemaining: number;
  drawdownRemaining: number;
  bufferRemaining: number;
  targetEquity: number | null;
  targetProgressPct: number | null;
  profitLoss: number;
  msUntilReset: number;
  breach?: Breach;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  notional: number;
  unrealizedPnl: number;
  leverageCap?: number;
}

export interface ChallengeState {
  id: string;
  simulated: true;
  tier: TierId;
  stage: "evaluation" | "funded";
  knight: string;
  knightId?: string;
  demo: boolean;
  wallet?: string;
  status: Status;
  lifecycle: Lifecycle;
  lastActivityAt: number;
  payoutsEnabled: boolean;
  reviveOf?: string;
  revivedBy?: string;
  scars: number;
  createdAt: number;
  dataSource?: string;
  account: {
    startingBalance: number;
    balance: number;
    equity: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feesPaid: number;
    fundingPaid: number;
    grossNotional: number;
    requiredMargin: number;
    effectiveLeverage: number;
  };
  risk: Risk;
  positions: Position[];
  openOrders: Order[];
  recentFills: Fill[];
  combatLog: CombatEntry[];
}

export interface PlaceOrderResult {
  accepted: boolean;
  reason?: string;
  order?: Order;
  fills: Fill[];
  avgPrice?: number;
  slippageBps?: number;
  state: ChallengeState;
}

export interface TierSpec {
  id: TierId;
  name: string;
  accountSize: number;
  fee: number;
  reviveFee: number;
  requires?: TierId;
  payouts: boolean;
}

export interface Rules {
  common: { profitTargetPct: number; dailyLossPct: number; maxDrawdownPct: number; profitSplit: number; minPayoutUsd: number };
  tiers: Record<TierId, TierSpec>;
  fees: { takerFeeRate: number; makerFeeRate: number };
  markets: { symbol: string; class: string; maxLeverage: number }[];
  revive: { discount: number; maxPerKnight: number; cooldownHours: number };
}

export interface Health {
  ok: boolean;
  authRequired: boolean;
  simulated: boolean;
  marketData: string;
  marketDataReachable: boolean;
  /** "off", a devnet descriptor, or "stub" (the local stub server: payments are simulated). */
  chain?: "off" | "stub" | { cluster: string; collection: string; usdcMint: string; treasury: string };
}

export interface MarketView {
  symbol: string;
  display: string;
  class: string;
  maxLeverage: number;
  mark: number;
  bestBid?: number;
  bestAsk?: number;
  mid: number;
  fundingRateHourly: number;
  tradable: boolean;
  tradableReason?: string;
  source: string;
  fetchedAt: number;
  book: { bids: [number, number][]; asks: [number, number][] };
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReviveInfo {
  challengeId: string;
  knightId?: string;
  tier: TierId;
  eligible: boolean;
  reason?: "demo_no_revive" | "not_wounded" | "already_revived" | "revive_cap_reached" | "revive_cooldown";
  fee: number;
  revivesUsed: number;
  revivesLeft: number;
  availableAt?: number;
}

export interface PaymentInstructions {
  orderId: string;
  kind: "challenge" | "revive";
  tier: TierId;
  listUsd: number;
  discountPct: number;
  amountUsd: number;
  amountBaseUnits: string;
  decimals: number;
  mint: string;
  treasury: string;
  reference: string;
  expiresAt: number;
  cluster: string;
}

export interface PaymentOrder {
  id: string;
  kind: "challenge" | "revive";
  wallet: string;
  tier: TierId;
  status: "pending" | "paid" | "fulfilled" | "refund_pending" | "refund_failed" | "refunded" | "expired";
  amountUsd: number;
  signature?: string;
  challengeId?: string;
  knightId?: string;
  failure?: string;
}

export interface ConfirmOutcome {
  status: "pending" | "fulfilled" | "refunded" | "refund_pending";
  order: PaymentOrder;
}

export interface PayoutQuote {
  grossProfit: number;
  traderShare: number;
  firmShare: number;
  eligible: boolean;
  reason?: "no_profit" | "below_minimum" | "open_positions";
  newBalance: number;
  kycRequired: true;
  destination?: string;
}

/** A knight NFT the signed-in wallet holds (GET /knights; absent when the server has no chain). */
export interface KnightInfo {
  asset: string;
  owner: string;
  name: string;
  level: "squire" | "knight" | "paladin" | "ascended";
  status: "active" | "funded" | "wounded" | "ascended" | "idle";
  tier: "squire" | "knight" | "paladin" | "ascended";
  wins: number;
  revives: number;
  frozen: boolean;
  genuine: boolean;
}
