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
  type: "market" | "limit" | "stop";
  size: number;
  remaining: number;
  limitPrice?: number;
  triggerPrice?: number;
  stopLoss?: number;
  reduceOnly: boolean;
  postOnly: boolean;
  status: string;
  createdAt: number;
  takeProfit?: number;
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
  /** Evaluation accounts: Path to Funded progress and claim. Null on funded accounts (absent on older servers). */
  pathToFunded?: PathToFunded | null;
  /** Funded accounts: funded level within the tier and progress to the next one. Null otherwise (absent on older servers). */
  scaling?: FundedScaling | null;
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

export interface BestDayCheck {
  bestDay: number;
  bestDayKey?: string;
  profitableTotal: number;
  share: number | null;
  maxShare: number;
  ok: boolean;
}

export type ClaimStatus = "kyc_pending" | "under_review" | "approved" | "rejected";

export interface FundedClaim {
  status: ClaimStatus;
  kyc: "pending" | "approved" | "rejected";
  claimedAt: number;
  kycAt?: number;
  reviewedAt?: number;
  reason?: string;
  fundedId?: string;
}

/** Path to Funded (rulebook section 9): the four pass requirements, then claim, identity check and risk review. */
export interface PathToFunded {
  targetBalance: number;
  closedProfit: number;
  targetProfit: number;
  targetMet: boolean;
  openPositions: number;
  flat: boolean;
  tradingDays: number;
  minTradingDays: number;
  daysMet: boolean;
  bestDay: BestDayCheck;
  eligible: boolean;
  claim?: FundedClaim;
  next: "trade" | "claim" | "verify_identity" | "under_review" | "funded" | "rejected" | "none";
}

export type ScalingTier = Exclude<TierId, "demo">;

export interface LevelUpRecord {
  ts: number;
  fromTier: TierId;
  fromLevel: number;
  fromSize: number;
  toTier: TierId;
  toLevel: number;
  toSize: number;
  profit: number;
  payouts: number;
}

/** Funded scaling (rulebook section 16): "Knight Lv.2", its size, and progress on the flat level-up rule. */
export interface FundedScaling {
  tier: ScalingTier;
  level: number;
  label: string;
  size: number;
  profitSinceLevel: number;
  profitTarget: number;
  profitMet: boolean;
  payoutsSinceLevel: number;
  payoutsNeeded: number;
  payoutsMet: boolean;
  eligible: boolean;
  next?: { tier: ScalingTier; level: number; size: number; graduates: boolean; label: string };
  atCap: boolean;
  levelSince: number;
  history: LevelUpRecord[];
  capHeld: boolean;
  waitingForFlat: boolean;
}

export interface ScalingRules {
  levelUpProfitPct: number;
  levelUpPayouts: number;
  ascendedStepUsd: number;
  ascendedMaxUsd: number;
  table: { tier: ScalingTier; name: string; levels: { level: number; size: number }[]; graduatesTo?: ScalingTier }[];
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
  payouts: boolean;
}

export interface Rules {
  common: { profitTargetPct: number; dailyLossPct: number; maxDrawdownPct: number; profitSplit: number; minPayoutUsd: number; minTradingDays?: number; bestDayMaxShare?: number };
  pathToFunded?: { minTradingDays: number; bestDayMaxShare: number; kyc: "auto" | "manual"; riskReview: "auto" | "manual"; riskReviewTarget: string; payoutWaitingPeriodDays: number };
  tiers: Record<TierId, TierSpec>;
  fees: { takerFeeRate: number; makerFeeRate: number };
  markets: { symbol: string; class: string; maxLeverage: number }[];
  revive: { discount: number; maxPerKnight: number; cooldownHours: number };
  /** Funded scaling ladder and rule (absent on older servers). */
  scaling?: ScalingRules;
  /** The configured payout policy (absent on older servers). */
  payouts?: { split: number; minUsd: number; autoApproveUpToUsd: number; enabled: boolean };
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

export interface MarketTrade {
  price: number;
  size: number;
  time: number;
  side: "buy" | "sell";
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
  reason?: "no_profit" | "below_minimum" | "open_positions" | "best_day_rule";
  newBalance: number;
  /** Best-day rule over the current payout cycle. */
  bestDay?: BestDayCheck;
  destination?: string;
  split?: number;
  minUsd?: number;
  /** The share is at or under the auto-approve ceiling: it is sent without a review. */
  autoApprove?: boolean;
}

export type PayoutStatus = "pending_approval" | "approved" | "sending" | "submitted" | "paid" | "rejected" | "failed";

/** A payout as the trader sees it (GET /payouts). Internals (attempts, errors) are not exposed. */
export interface PayoutView {
  id: string;
  challengeId: string;
  status: PayoutStatus;
  destination: string;
  amountUsd: number;
  grossProfitUsd: number;
  firmShareUsd: number;
  split: number;
  needsApproval: boolean;
  delayed: boolean;
  signature?: string;
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
  paidAt?: number;
  replayed?: boolean;
}

/** A knight NFT the signed-in wallet holds (GET /knights; absent when the server has no chain). */
export interface KnightInfo {
  asset: string;
  owner: string;
  name: string;
  /** The knight's tier (art follows it). */
  tier: "squire" | "knight" | "paladin" | "ascended";
  /** Funded level within the tier (1 until the funded account levels up). */
  level: number;
  status: "active" | "funded" | "wounded" | "ascended" | "idle";
  wins: number;
  revives: number;
  frozen: boolean;
  genuine: boolean;
}

/** GET /early/status */
export interface EarlyStatus {
  enabled: boolean;
  cluster: "mainnet-beta" | "devnet";
  priceUsd: number;
  currency: "USDC";
  minted: number;
  waitlist: number;
}

export interface EarlyPayment {
  claimId: string;
  orderId: string;
  cluster: string;
  mint: string;
  treasury: string;
  decimals: number;
  amountUsd: number;
  amountBaseUnits: string;
  reference: string;
  expiresAt: number;
  wallet: string;
  payer: string;
  asset: string;
  /** Pre-signed legacy transaction (base64): USDC payment + NFT mint in one. The wallet signs and sends it. */
  transaction: string;
  lastValidBlockHeight: number;
}

export type EarlyOutcome =
  | { status: "waitlist"; claimId: string; alreadyOnList: boolean }
  | { status: "awaiting_payment"; claimId: string; payment: EarlyPayment }
  | { status: "minted"; claimId: string; asset: string; signature?: string; explorer: string; alreadyMinted: boolean }
  | { status: "paid"; claimId: string; message: string }
  | { status: "refund_due"; claimId: string; message: string };
