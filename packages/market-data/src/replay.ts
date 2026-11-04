import type { L2Book, Level } from "@garuda/sim-engine";
import { TIMEFRAME_MS, type Candle, type CandleTimeframe, type MarketDataProvider, type MarketInfo, type MarketSnapshot } from "./types.js";

export interface RecordedMarket {
  symbol: string;
  recordedAt: string;
  slot?: number;
  markPrice: number;
  /** Fraction per hour. */
  fundingRateHourly: number;
  bids: [number, number][];
  asks: [number, number][];
}

/**
 * Offline provider. Serves recorded (real) Phoenix books, optionally shifted by a price factor so
 * tests and demos can script market moves. Used as the fallback when live Phoenix is unreachable
 * and for deterministic tests.
 */
export class ReplayProvider implements MarketDataProvider {
  readonly name: string;
  private markets = new Map<string, RecordedMarket>();
  private shift = new Map<string, number>();
  private funding = new Map<string, number>();
  private untradable = new Map<string, string>();
  private clock: () => number;

  constructor(recorded: RecordedMarket[], opts: { name?: string; now?: () => number } = {}) {
    this.name = opts.name ?? "replay";
    this.clock = opts.now ?? Date.now;
    for (const m of recorded) this.markets.set(m.symbol, m);
  }

  /** Move a market's whole book and mark by a fractional change relative to the recording (0.01 = +1%). */
  setMove(symbol: string, fraction: number): void {
    this.shift.set(symbol, 1 + fraction);
  }

  /** Move relative to the CURRENT shifted level. */
  moveBy(symbol: string, fraction: number): void {
    this.shift.set(symbol, (this.shift.get(symbol) ?? 1) * (1 + fraction));
  }

  setFunding(symbol: string, fractionPerHour: number): void {
    this.funding.set(symbol, fractionPerHour);
  }

  setTradable(symbol: string, tradable: boolean, reason = "after_hours"): void {
    if (tradable) this.untradable.delete(symbol);
    else this.untradable.set(symbol, reason);
  }

  async snapshot(symbol: string): Promise<MarketSnapshot> {
    const m = this.markets.get(symbol);
    if (!m) throw new Error(`replay: no recording for ${symbol}`);
    const k = this.shift.get(symbol) ?? 1;
    const scale = (xs: [number, number][]): Level[] => xs.map(([p, s]) => [p * k, s] as const);
    const ts = this.clock();
    const book: L2Book = { symbol, ts, bids: scale(m.bids), asks: scale(m.asks) };
    const reason = this.untradable.get(symbol);
    return {
      symbol,
      book,
      markPrice: m.markPrice * k,
      fundingRateHourly: this.funding.get(symbol) ?? m.fundingRateHourly,
      tradable: !reason,
      tradableReason: reason,
      fetchedAt: ts,
      source: "replay",
      slot: m.slot,
    };
  }

  async listMarkets(): Promise<MarketInfo[]> {
    return [...this.markets.keys()].map((symbol) => ({ symbol, status: "active", tradable: !this.untradable.has(symbol) }));
  }

  /**
   * Deterministic SYNTHETIC history (a seeded random walk ending at the current mark) so a chart has something to draw
   * offline. Labelled `source: "synthetic"`; never presented as real prices.
   */
  async candles(symbol: string, timeframe: CandleTimeframe, limit: number) {
    const m = this.markets.get(symbol);
    if (!m) throw new Error(`replay: no recording for ${symbol}`);
    const step = TIMEFRAME_MS[timeframe];
    const end = Math.floor(this.clock() / step) * step;
    let seed = 0;
    for (const ch of `${symbol}:${timeframe}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const last = m.markPrice * (this.shift.get(symbol) ?? 1);
    const vol = 0.0035 * Math.sqrt(step / 3_600_000 + 0.25);
    const closes: number[] = [last];
    for (let i = 1; i < limit; i++) closes.unshift(closes[0]! / (1 + (rnd() - 0.5) * 2 * vol + 0.0004));
    const candles: Candle[] = closes.map((close, i) => {
      const open = i === 0 ? close / (1 + (rnd() - 0.5) * vol) : closes[i - 1]!;
      const hi = Math.max(open, close) * (1 + rnd() * vol * 0.6);
      const lo = Math.min(open, close) * (1 - rnd() * vol * 0.6);
      return { time: end - (limit - 1 - i) * step, open, high: hi, low: lo, close, volume: 40 + rnd() * 160 + Math.abs(close - open) / close * 20000 };
    });
    return { candles, source: "synthetic" as const };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
