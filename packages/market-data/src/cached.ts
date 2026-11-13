import type { CandleTimeframe, MarketDataProvider, MarketInfo, MarketSnapshot } from "./types.js";

export interface CachedProviderOptions {
  /** A snapshot younger than this is served as is. */
  snapshotTtlMs?: number;
  /** While a refresh is on its way, a snapshot up to this old is served instead of waiting. Never older for fills. */
  snapshotStaleMs?: number;
  candlesTtlMs?: number;
  candlesStaleMs?: number;
  tradesTtlMs?: number;
  tradesStaleMs?: number;
  now?: () => number;
}

interface Entry<T> {
  at: number;
  value?: T;
  inflight?: Promise<T>;
}

/**
 * One upstream request per key at a time, shared by the risk worker and every HTTP caller, plus a short cache. The
 * upstream (Phoenix) rate-limits per IP and its SDK then pauses EVERY request for up to 30s: without this, a few open
 * terminals plus the worker could push the API into that pause and the chart and book would hang for a minute.
 * While a refresh is running, callers get the last good value (if it is fresh enough) instead of waiting on it.
 */
export class CachedProvider implements MarketDataProvider {
  private readonly snaps = new Map<string, Entry<MarketSnapshot>>();
  private readonly candleCache = new Map<string, Entry<Awaited<ReturnType<NonNullable<MarketDataProvider["candles"]>>>>>();
  private readonly tradeCache = new Map<string, Entry<Awaited<ReturnType<NonNullable<MarketDataProvider["recentTrades"]>>>>>();
  private readonly o: Required<Omit<CachedProviderOptions, "now">>;
  private readonly now: () => number;
  candles?: MarketDataProvider["candles"];
  recentTrades?: MarketDataProvider["recentTrades"];

  constructor(
    private readonly inner: MarketDataProvider,
    opts: CachedProviderOptions = {},
  ) {
    this.o = {
      snapshotTtlMs: opts.snapshotTtlMs ?? 800,
      snapshotStaleMs: opts.snapshotStaleMs ?? 3_000,
      candlesTtlMs: opts.candlesTtlMs ?? 15_000,
      candlesStaleMs: opts.candlesStaleMs ?? 5 * 60_000,
      tradesTtlMs: opts.tradesTtlMs ?? 2_000,
      tradesStaleMs: opts.tradesStaleMs ?? 30_000,
    };
    this.now = opts.now ?? Date.now;
    if (inner.candles) {
      const f = inner.candles.bind(inner);
      this.candles = (symbol: string, tf: CandleTimeframe, limit: number) =>
        this.get(this.candleCache, `${symbol}:${tf}:${limit}`, () => f(symbol, tf, limit), this.o.candlesTtlMs, this.o.candlesStaleMs);
    }
    if (inner.recentTrades) {
      const f = inner.recentTrades.bind(inner);
      this.recentTrades = (symbol: string, limit: number) => this.get(this.tradeCache, `${symbol}:${limit}`, () => f(symbol, limit), this.o.tradesTtlMs, this.o.tradesStaleMs);
    }
  }

  get name(): string {
    return this.inner.name;
  }

  snapshot(symbol: string): Promise<MarketSnapshot> {
    return this.get(this.snaps, symbol, () => this.inner.snapshot(symbol), this.o.snapshotTtlMs, this.o.snapshotStaleMs);
  }

  listMarkets(): Promise<MarketInfo[]> {
    return this.inner.listMarkets();
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private get<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>, ttl: number, stale: number): Promise<T> {
    const t = this.now();
    let e = map.get(key);
    if (!e) {
      e = { at: 0 };
      map.set(key, e);
    }
    const age = t - e.at;
    if (e.value !== undefined && age < ttl) return Promise.resolve(e.value);
    if (!e.inflight) {
      const entry = e;
      entry.inflight = load().then(
        (v) => {
          entry.value = v;
          entry.at = this.now();
          entry.inflight = undefined;
          return v;
        },
        (err) => {
          entry.inflight = undefined;
          throw err;
        },
      );
      // a background refresh that fails must not surface as an unhandled rejection
      entry.inflight.catch(() => {});
    }
    if (e.value !== undefined && age < stale) return Promise.resolve(e.value);
    return e.inflight!;
  }
}
