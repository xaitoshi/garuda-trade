/** Market whitelist (rulebook §13) and leverage caps (§12). Whitelist is the 2026-11-04 weekly review. */

export type AssetClass =
  | "major_crypto"
  | "other_crypto"
  | "equity"
  | "index_sp500_nasdaq"
  | "index_other"
  | "commodity_major"
  | "commodity_other";

export const MAJOR_CRYPTO = ["BTC", "ETH", "SOL"] as const;
export const OTHER_CRYPTO = [
  "HYPE", "ZEC", "NEAR", "JUP", "UNI", "SUI", "DOGE", "TRX", "BNB", "LTC", "LINK",
] as const;
export const EQUITIES = [
  "AAPL", "AMD", "AMAT", "AMZN", "ASML", "BABA", "COIN", "DELL", "GOOGL", "HOOD", "INTC", "META", "MSFT",
  "MSTR", "MU", "NBIS", "NFLX", "NVDA", "ORCL", "PLTR", "SKHY", "SNDK", "SPCX", "TSLA", "TSM",
] as const;
export const INDEX_SP_NASDAQ = ["SPY", "QQQ"] as const;
export const INDEX_OTHER = ["TLT"] as const;
export const COMMODITY_MAJOR = ["GOLD", "SILVER", "WTIOIL"] as const;
export const COMMODITY_OTHER = ["COPPER"] as const;

/** Max leverage per asset class (x). The lower of this and Phoenix's own cap applies. */
export const LEVERAGE_CAP_BY_CLASS: Record<AssetClass, number> = {
  major_crypto: 10,
  other_crypto: 2,
  equity: 4,
  index_sp500_nasdaq: 10,
  index_other: 5,
  commodity_major: 8,
  commodity_other: 5,
};

const CLASS_BY_SYMBOL = new Map<string, AssetClass>();
const reg = (list: readonly string[], c: AssetClass) => list.forEach((s) => CLASS_BY_SYMBOL.set(s, c));
reg(MAJOR_CRYPTO, "major_crypto");
reg(OTHER_CRYPTO, "other_crypto");
reg(EQUITIES, "equity");
reg(INDEX_SP_NASDAQ, "index_sp500_nasdaq");
reg(INDEX_OTHER, "index_other");
reg(COMMODITY_MAJOR, "commodity_major");
reg(COMMODITY_OTHER, "commodity_other");

export const WHITELIST: readonly string[] = [...CLASS_BY_SYMBOL.keys()];

/** "SOL-PERP", "sol" -> "SOL". */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-?PERP$/, "");
}

export function isWhitelisted(symbol: string): boolean {
  return CLASS_BY_SYMBOL.has(normalizeSymbol(symbol));
}

export function assetClassOf(symbol: string): AssetClass | undefined {
  return CLASS_BY_SYMBOL.get(normalizeSymbol(symbol));
}

/** Rulebook leverage cap for a symbol; undefined when not whitelisted. */
export function leverageCap(symbol: string): number | undefined {
  const c = assetClassOf(symbol);
  return c ? LEVERAGE_CAP_BY_CLASS[c] : undefined;
}

/** Circuit-breaker thresholds (§13). */
export const CIRCUIT_BREAKER = {
  maxSpreadBps: 100,
  minSideDepthUsd: 10_000,
  depthBandPct: 0.005,
  staleFeedMs: 2_000,
} as const;
