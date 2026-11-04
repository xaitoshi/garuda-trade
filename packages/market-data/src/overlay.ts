import type { Level } from "@garuda/sim-engine";
import type { CandleTimeframe, MarketDataProvider, MarketInfo, MarketSnapshot } from "./types.js";

/**
 * Wraps any provider and shifts books + marks by a scripted fractional move per symbol.
 * Lets demos and tests script "price goes +1.2%" on top of a REAL (live or recorded) book:
 * book shape, depth, spread and funding stay real; only the price level is moved.
 */
export class OverlayProvider implements MarketDataProvider {
  private shift = new Map<string, number>();

  constructor(private readonly inner: MarketDataProvider) {}

  get name(): string {
    return `${this.inner.name}+scenario-overlay`;
  }

  /** Set the cumulative move for a symbol relative to the underlying price (0.01 = +1%). */
  setMove(symbol: string, fraction: number): void {
    this.shift.set(symbol, 1 + fraction);
  }

  getMove(symbol: string): number {
    return (this.shift.get(symbol) ?? 1) - 1;
  }

  async snapshot(symbol: string): Promise<MarketSnapshot> {
    const s = await this.inner.snapshot(symbol);
    const k = this.shift.get(s.symbol) ?? 1;
    if (k === 1) return s;
    const scale = (xs: readonly Level[]): Level[] => xs.map(([p, q]) => [p * k, q] as const);
    return { ...s, markPrice: s.markPrice * k, book: { ...s.book, bids: scale(s.book.bids), asks: scale(s.book.asks) } };
  }

  listMarkets(): Promise<MarketInfo[]> {
    return this.inner.listMarkets();
  }
  async candles(symbol: string, timeframe: CandleTimeframe, limit: number) {
    if (!this.inner.candles) return { candles: [], source: "synthetic" as const };
    const r = await this.inner.candles(symbol, timeframe, limit);
    const k = this.shift.get(symbol) ?? 1;
    return k === 1 ? r : { ...r, candles: r.candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k })) };
  }
  ping(): Promise<boolean> {
    return this.inner.ping();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
