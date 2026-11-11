import type { Fill } from "@garuda/sim-engine";

export type RoutingMode = "disabled" | "dry_run" | "live";
/** A-book: mirrored onto the firm's Phoenix account. B-book: kept internal (the firm takes the other side in simulation). */
export type Book = "A" | "B";
export type RouteAction = "open" | "increase" | "reduce" | "close" | "skip" | "drift";
export type RouteStatus = "dry_run" | "pending" | "sent" | "failed" | "skipped" | "drift";

/** What the challenge service reports after every batch of simulated fills (all stages; the router filters). */
export interface FillEvent {
  challengeId: string;
  stage: "evaluation" | "funded";
  demo: boolean;
  wallet?: string;
  /** Risk status after the fills ("active", "breached", "passed", ...). */
  status: string;
  fills: Fill[];
  /** Signed base size per symbol AFTER the fills (0 or missing = flat). */
  positions: Record<string, number>;
}

/** A trader's current simulated book, read during reconciliation. */
export interface TraderBook {
  stage: "evaluation" | "funded";
  demo: boolean;
  wallet?: string;
  status: string;
  positions: Record<string, { size: number; markPrice: number }>;
}

export interface PlaceMirrorOrder {
  symbol: string;
  side: "buy" | "sell";
  /** Base units (e.g. SOL), always positive. */
  size: number;
  /** Worst acceptable price (slippage limit). */
  limitPrice: number;
  reduceOnly: boolean;
  /** USDC moved into the isolated subaccount for an opening order (0 for reduce). */
  collateralUsd: number;
}

/** The only surface the router needs from Phoenix. The live implementation is RisePhoenixClient; tests use a mock. */
export interface PhoenixTradingClient {
  readonly name: string;
  /** Firm trader authority (owner wallet) and the delegate (position authority) public key. Public keys only. */
  readonly firmAuthority: string;
  readonly delegate: string;
  placeMarketOrder(o: PlaceMirrorOrder): Promise<{ signature: string }>;
  /** Signed base size per symbol summed over the firm's subaccounts. */
  positions(): Promise<Record<string, number>>;
}

export interface RoutingTrader {
  challengeId: string;
  wallet?: string;
  enabled: boolean;
  /** Overrides the global size multiplier for this trader. */
  multiplier?: number;
  note?: string;
  updatedAt: number;
  updatedBy: string;
}

export interface RoutingOrderRecord {
  id: string;
  ts: number;
  mode: Exclude<RoutingMode, "disabled">;
  challengeId: string;
  wallet?: string;
  symbol: string;
  side?: "buy" | "sell";
  size: number;
  notional: number;
  refPrice?: number;
  limitPrice?: number;
  book: Book;
  action: RouteAction;
  reason?: string;
  status: RouteStatus;
  signature?: string;
  error?: string;
  triggerFillId?: string;
  updatedAt: number;
}

export interface RoutedPosition {
  mode: Exclude<RoutingMode, "disabled">;
  challengeId: string;
  symbol: string;
  size: number;
  avgPrice: number;
  updatedAt: number;
}
