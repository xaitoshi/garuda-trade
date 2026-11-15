import { createRequire } from "node:module";
import { createPhoenixClient, createPhoenixWsClient, toWebSocketUrl } from "@ellipsis-labs/rise";
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
  /**
   * Stream books and marks over Phoenix's WebSocket (one connection) instead of polling REST. Default on outside tests.
   * Phoenix rate-limits REST per IP, and on a shared server other apps eat that quota: polling then fails with 429.
   */
  stream?: boolean;
}

/** Live state for one market, kept current by the WebSocket. */
interface LiveMarket {
  bids?: Level[];
  asks?: Level[];
  bookAt: number;
  slot?: number;
  mark?: number;
  markAt: number;
  usedAt: number;
  abort: AbortController;
  ready: Promise<void>;
}

/**
 * The socket only sends when something changes, so a quiet market can go a while without a message. A book older than
 * this is no longer trusted and the REST path answers instead; a mark that old falls back to the book mid.
 */
const LIVE_STALE_MS = 30_000;
/** A message on any stream within this window means the socket is up. */
const SOCKET_ALIVE_MS = 3_000;
/** Markets nobody asked about for this long are unsubscribed. */
const LIVE_IDLE_MS = 10 * 60_000;
/** Funding moves slowly: one REST call per market per this period. */
const FUNDING_TTL_MS = 60_000;

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
  private readonly apiUrl: string;
  private readonly stream: boolean;
  private ws?: ReturnType<typeof createPhoenixWsClient>;
  private readonly live = new Map<string, LiveMarket>();
  private readonly funding = new Map<string, { at: number; rate: number; p?: Promise<number> }>();
  private sweeper?: ReturnType<typeof setInterval>;
  /** Last message on any stream: the socket is alive (and quiet books are simply unchanged) while this is recent. */
  private lastMsgAt = 0;

  constructor(opts: PhoenixProviderOptions = {}) {
    this.apiUrl = opts.apiUrl ?? process.env.PHOENIX_API_URL ?? "https://perp-api.phoenix.trade";
    this.stream = opts.stream ?? (process.env.VITEST === undefined && process.env.PHOENIX_STREAM !== "off");
    this.client = createPhoenixClient({
      apiUrl: this.apiUrl,
      rpcUrl: opts.rpcUrl ?? process.env.PHOENIX_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      // fail fast instead of hanging a chart for a minute: the caching layer serves the last good value meanwhile
      timeout: 8_000,
      rateLimitRetry: { maxRetries: 1, maxTotalWaitMs: 2_000 },
      rateLimitCooldown: { maxDelayMs: 5_000 },
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

  /** Opens the WebSocket on first use. Node 20 has no global WebSocket: the `ws` package stands in. */
  private wsClient(): ReturnType<typeof createPhoenixWsClient> {
    if (!this.ws) {
      const g = globalThis as { WebSocket?: unknown };
      if (!g.WebSocket) g.WebSocket = createRequire(import.meta.url)("ws");
      this.ws = createPhoenixWsClient({ url: toWebSocketUrl(this.apiUrl) });
      this.sweeper = setInterval(() => this.sweep(), 60_000);
      this.sweeper.unref?.();
    }
    return this.ws;
  }

  /** Subscribe to a market's book and mark (once), resolving when the first of each arrived or after 4s. */
  private watch(symbol: string): LiveMarket {
    const hit = this.live.get(symbol);
    if (hit) {
      hit.usedAt = this.now();
      return hit;
    }
    const ws = this.wsClient();
    const abort = new AbortController();
    let gotBook!: () => void;
    let gotMark!: () => void;
    const bookP = new Promise<void>((ok) => (gotBook = ok));
    const markP = new Promise<void>((ok) => (gotMark = ok));
    const lm: LiveMarket = {
      bookAt: 0,
      markAt: 0,
      usedAt: this.now(),
      abort,
      ready: Promise.race([Promise.all([bookP, markP]).then(() => undefined), new Promise<void>((ok) => setTimeout(ok, 4_000))]),
    };
    this.live.set(symbol, lm);
    const levels = (xs: unknown): Level[] => (xs as [number, number][]).slice(0, this.maxLevels).map(([p, q]) => [Number(p), Number(q)] as const);
    const drop = () => {
      // the stream ended (closed or failed): forget it so the next request subscribes again
      if (this.live.get(symbol) === lm) this.live.delete(symbol);
    };
    void (async () => {
      for await (const m of ws.l2Book(symbol, abort.signal) as AsyncIterable<{ bids: unknown; asks: unknown; slot: bigint }>) {
        lm.bids = levels(m.bids);
        lm.asks = levels(m.asks);
        lm.slot = Number(m.slot) || undefined;
        lm.bookAt = this.now();
        this.lastMsgAt = lm.bookAt;
        gotBook();
      }
    })().catch(() => {}).finally(drop);
    void (async () => {
      for await (const m of ws.markPrice(symbol, abort.signal) as AsyncIterable<{ markPrice: number }>) {
        lm.mark = Number(m.markPrice);
        lm.markAt = this.now();
        this.lastMsgAt = lm.markAt;
        gotMark();
      }
    })().catch(() => {}).finally(drop);
    return lm;
  }

  private sweep(): void {
    const t = this.now();
    for (const [sym, lm] of this.live) {
      if (t - lm.usedAt > LIVE_IDLE_MS) {
        lm.abort.abort();
        this.live.delete(sym);
      }
    }
  }

  /** Hourly funding as a fraction, from REST at most once a minute per market (it barely moves). */
  private async fundingRate(symbol: string): Promise<number> {
    const t = this.now();
    const f = this.funding.get(symbol);
    if (f && t - f.at < FUNDING_TTL_MS) return f.rate;
    if (f?.p) return f.rate;
    const entry = f ?? { at: 0, rate: 0 };
    entry.p = (async () => {
      const stats = (await this.client.api.markets().getLatestMarketStats(symbol)) as unknown as { current_funding_rate?: number };
      // percent per hour on the wire (verified against annualized_funding_rate): convert to a fraction
      return Number(stats.current_funding_rate ?? 0) / 100;
    })();
    this.funding.set(symbol, entry);
    try {
      entry.rate = await entry.p;
      entry.at = this.now();
    } catch {
      // keep the last rate (0 before the first answer) rather than failing the whole snapshot over funding
      entry.at = this.now() - FUNDING_TTL_MS + 10_000;
    } finally {
      entry.p = undefined;
    }
    return entry.rate;
  }

  async snapshot(symbolIn: string): Promise<MarketSnapshot> {
    const symbol = normalizeSymbol(symbolIn);
    if (this.stream) {
      const lm = this.watch(symbol);
      if (!lm.bookAt) await lm.ready;
      const t = this.now();
      // the socket only sends changes: while it is alive (any message lately) a quiet book is simply unchanged, so it is
      // current now; if the socket has gone quiet, REST answers instead
      if (lm.bids?.length && lm.asks?.length && t - lm.bookAt < LIVE_STALE_MS && t - this.lastMsgAt < SOCKET_ALIVE_MS) {
        const mid = (lm.bids[0]![0] + lm.asks[0]![0]) / 2;
        const mark = lm.mark !== undefined && t - lm.markAt < LIVE_STALE_MS ? lm.mark : mid;
        const [markets, fundingRateHourly] = await Promise.all([this.markets().catch(() => this.marketsCache?.byKey ?? new Map<string, RawMarket>()), this.fundingRate(symbol)]);
        const st = PhoenixSdkProvider.tradableState(markets.get(symbol));
        return {
          symbol,
          book: { symbol, bids: lm.bids, asks: lm.asks, ts: lm.bookAt },
          markPrice: mark,
          fundingRateHourly,
          tradable: st.tradable,
          tradableReason: st.reason,
          fetchedAt: t,
          source: "phoenix-live",
          slot: lm.slot,
        };
      }
      // no fresh stream data yet (or the socket is down): fall through to REST
    }
    return this.restSnapshot(symbol);
  }

  private async restSnapshot(symbol: string): Promise<MarketSnapshot> {
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
    for (let i = 0; i < 3; i++) {
      try {
        const ob = await this.client.api.orderbook().getOrderbook("SOL");
        return Array.isArray(ob.bids) && ob.bids.length > 0;
      } catch (e) {
        // rate-limited means reachable: never fall back to recorded prices over a 429 (a shared IP hits it often)
        if (/429|rate.?limit/i.test(String((e as Error)?.message ?? e))) return true;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const lm of this.live.values()) lm.abort.abort();
    this.live.clear();
    this.ws?.close();
    this.ws = undefined;
    await (this.client as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
  }
}
