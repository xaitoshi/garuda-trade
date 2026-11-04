import type { L2Book } from "@garuda/sim-engine";

export interface MarketSnapshot {
  /** Phoenix symbol without "-PERP", e.g. "SOL". */
  symbol: string;
  book: L2Book;
  /** Phoenix mark price (falls back to book mid). */
  markPrice: number;
  /** Funding rate as a FRACTION per hour (0.0001 = 1 bp/h). Positive: longs pay shorts. */
  fundingRateHourly: number;
  /** False when Phoenix reports the market inactive / in a closed period (reduce-only). */
  tradable: boolean;
  tradableReason?: string;
  /** ms epoch the snapshot was assembled locally. */
  fetchedAt: number;
  source: "phoenix-live" | "replay" | "synthetic";
  /** Phoenix slot of the book, when known. */
  slot?: number;
}

export interface MarketInfo {
  symbol: string;
  status: string;
  /** Phoenix's own protocol max leverage (the Garuda cap is lower). */
  phoenixMaxLeverage?: number;
  isolatedOnly?: boolean;
  tradable: boolean;
}

/** Read-only market data. Implementations: live Phoenix (Rise SDK), recorded replay, synthetic. */
export interface MarketDataProvider {
  readonly name: string;
  snapshot(symbol: string): Promise<MarketSnapshot>;
  listMarkets(): Promise<MarketInfo[]>;
  /** Returns true if the upstream is reachable. Never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
