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

export interface Candle {
  /** Bucket start, ms epoch. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One public fill on the market tape. Side is the taker side when the venue reports it, else inferred by the tick rule. */
export interface MarketTrade {
  price: number;
  size: number;
  /** ms epoch */
  time: number;
  side: "buy" | "sell";
}

export const CANDLE_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];
export const TIMEFRAME_MS: Record<CandleTimeframe, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** Read-only market data. Implementations: live Phoenix (Rise SDK), recorded replay, synthetic. */
export interface MarketDataProvider {
  readonly name: string;
  snapshot(symbol: string): Promise<MarketSnapshot>;
  listMarkets(): Promise<MarketInfo[]>;
  /** Price history for charts. Optional: providers without history return nothing and the UI draws from live marks. */
  candles?(symbol: string, timeframe: CandleTimeframe, limit: number): Promise<{ candles: Candle[]; source: "phoenix-live" | "synthetic" }>;
  /** Recent public trades on the market, newest first. Optional. */
  recentTrades?(symbol: string, limit: number): Promise<{ trades: MarketTrade[]; source: "phoenix-live" | "synthetic" }>;
  /** Returns true if the upstream is reachable. Never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
