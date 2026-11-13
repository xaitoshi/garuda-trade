import { createPhoenixClient } from "@ellipsis-labs/rise";
import type { L2Book, Level } from "@garuda/sim-engine";
import { TIMEFRAME_MS, type Candle, type CandleTimeframe, type MarketDataProvider, type MarketInfo, type MarketSnapshot, type MarketTrade } from "./types.js";

export interface PhoenixProviderOptions {
  apiUrl?: string;
  rpcUrl?: string;
  /** How long to cache the exchange market list (status / leverage / closed periods). */
  marketsTtlMs?: number;
  /** Max book levels kept per side. */
  maxLevels?: number;
  now?: () => number;
}

interface RawMarket {
  symbol: string;
  marketStatus?: string;
  isolatedOnly?: boolean;
  leverageTiers?: { maxLeverage: number }[];
  commodityMetadata?: { status?: string; isAfterHours?: boolean; isReopen?: boolean };
}

/** Tick rule: a trade above the previous price was a buy, below a sell, equal keeps the previous side. Input newest first. */
export function withTickSides(rows: { price: number; size: number; time: number }[]): MarketTrade[] {
  const out: MarketTrade[] = new Array(rows.length);
  let side: "buy" | "sell" = "buy";
  for (let i = rows.length - 1; i >= 0; i--) {
    const prev = rows[i + 1];
    if (prev && rows[i]!.price > prev.price) side = "buy";
    else if (prev && rows[i]!.price < prev.price) side = "sell";
    out[i] = { ...rows[i]!, side };
  }
  return out;
}

export function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/-?PERP$/, "");
}

/**
 * Live Phoenix Perps data through the Rise SDK (`@ellipsis-labs/rise`). Read-only: only the public,
 * unauthenticated REST endpoints are used (orderbook, market stats, market list). No keys, no
 * signing, no builder code.
 */
export class PhoenixSdkProvider implements MarketDataProvider {
  readonly name = "phoenix-live";
  private client: ReturnType<typeof createPhoenixClient>;
  private marketsCache?: { at: number; byKey: Map<string, RawMarket> };
  private readonly ttl: number;
  private readonly maxLevels: number;
  private readonly now: () => number;

  constructor(opts: PhoenixProviderOptions = {}) {
    this.client = createPhoenixClient({
      apiUrl: opts.apiUrl ?? process.env.PHOENIX_API_URL ?? "https://perp-api.phoenix.trade",
      rpcUrl: opts.rpcUrl ?? process.env.PHOENIX_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    });
    this.ttl = opts.marketsTtlMs ?? 60_000;
    this.maxLevels = opts.maxLevels ?? 100;
    this.now = opts.now ?? Date.now;
  }

  private async markets(): Promise<Map<string, RawMarket>> {
    const t = this.now();
    if (this.marketsCache && t - this.marketsCache.at < this.ttl) return this.marketsCache.byKey;
    const list = (await this.client.api.markets().getMarkets()) as unknown as RawMarket[];
    const byKey = new Map(list.map((m) => [normalizeSymbol(m.symbol), m]));
    this.marketsCache = { at: t, byKey };
    return byKey;
  }

  static tradableState(m: RawMarket | undefined): { tradable: boolean; reason?: string } {
    if (!m) return { tradable: false, reason: "unknown_market" };
    if (m.marketStatus && m.marketStatus !== "active") return { tradable: false, reason: `market_${m.marketStatus}` };
    const c = m.commodityMetadata;
    if (c) {
      if (c.status && c.status !== "active") return { tradable: false, reason: `session_${c.status}` };
      if (c.isAfterHours) return { tradable: false, reason: "after_hours" };
    }
    return { tradable: true };
  }

  async snapshot(symbolIn: string): Promise<MarketSnapshot> {
    const symbol = normalizeSymbol(symbolIn);
    const [ob, stats, markets] = await Promise.all([
      this.client.api.orderbook().getOrderbook(symbol),
      this.client.api.markets().getLatestMarketStats(symbol),
      this.markets(),
    ]);
    const fetchedAt = this.now();
    const toLevels = (xs: unknown): Level[] =>
      (xs as [number, number][]).slice(0, this.maxLevels).map(([p, s]) => [Number(p), Number(s)] as const);
    const book: L2Book = { symbol, bids: toLevels(ob.bids), asks: toLevels(ob.asks), ts: fetchedAt };
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;
    const s = stats as unknown as { mark_price?: number; current_funding_rate?: number };
    const markPrice = Number(s.mark_price ?? mid);
    // Live API reports current_funding_rate in PERCENT per hour (verified against annualized_funding_rate);
    // convert to a fraction.
    const fundingRateHourly = Number(s.current_funding_rate ?? 0) / 100;
    const st = PhoenixSdkProvider.tradableState(markets.get(symbol));
    return {
      symbol,
      book,
      markPrice,
      fundingRateHourly,
      tradable: st.tradable,
      tradableReason: st.reason,
      fetchedAt,
      source: "phoenix-live",
      slot: Number((ob as unknown as { slot?: number }).slot ?? 0) || undefined,
    };
  }

  async listMarkets(): Promise<MarketInfo[]> {
    const m = await this.markets();
    return [...m.values()].map((x) => {
      const st = PhoenixSdkProvider.tradableState(x);
      return {
        symbol: normalizeSymbol(x.symbol),
        status: x.marketStatus ?? "unknown",
        phoenixMaxLeverage: x.leverageTiers?.[0]?.maxLeverage,
        isolatedOnly: x.isolatedOnly,
        tradable: st.tradable,
      };
    });
  }

  /** OHLCV from Phoenix's public candles endpoint (read-only). */
  async candles(symbolIn: string, timeframe: CandleTimeframe, limit: number) {
    const symbol = normalizeSymbol(symbolIn);
    const raw = (await this.client.api.candles().getCandles(symbol, { timeframe, limit, startTime: this.now() - TIMEFRAME_MS[timeframe] * limit })) as unknown as {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
    }[];
    const candles: Candle[] = raw
      .map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
    return { candles, source: "phoenix-live" as const };
  }

  /** Public fills from Phoenix (read-only). Phoenix does not report the taker side, so it is inferred by the tick rule. */
  async recentTrades(symbolIn: string, limit: number) {
    const symbol = normalizeSymbol(symbolIn);
    const res = (await this.client.api.trades().getMarketFills(symbol, { limit })) as unknown as {
      data: { baseQty: string; price: string; timestamp: number }[];
    };
    const rows = res.data
      .map((f) => ({ price: Number(f.price), size: Math.abs(Number(f.baseQty)), time: Number(f.timestamp) < 1e12 ? Number(f.timestamp) * 1000 : Number(f.timestamp) }))
      .filter((t) => Number.isFinite(t.price) && Number.isFinite(t.size) && t.size > 0)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);
    return { trades: withTickSides(rows), source: "phoenix-live" as const };
  }

  async ping(): Promise<boolean> {
    try {
      const ob = await this.client.api.orderbook().getOrderbook("SOL");
      return Array.isArray(ob.bids) && ob.bids.length > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await (this.client as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
  }
}
