export const CANDLE_TF = ["5m", "15m", "1h", "4h", "1d"] as const;
export type Tf = (typeof CANDLE_TF)[number];
export const TF_MS: Record<Tf, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Candles back that count as "24h" for the header change chip. */
export const TF_BARS: Record<Tf, number> = { "5m": 288, "15m": 96, "1h": 24, "4h": 6, "1d": 1 };
