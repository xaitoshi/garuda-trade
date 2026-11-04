import type { Candle, MarketView, Position, Risk } from "./types";

type Level = [number, number];

/** Walk one side of the book for `size` base units: average fill price and how much the book could fill. */
export function walkBook(levels: readonly Level[], size: number): { avg: number; filled: number } {
  let left = size;
  let cost = 0;
  for (const [p, q] of levels) {
    const take = Math.min(left, q);
    cost += take * p;
    left -= take;
    if (left <= 1e-12) break;
  }
  const filled = size - Math.max(0, left);
  return { avg: filled > 0 ? cost / filled : 0, filled };
}

/** Estimated slippage of a market order versus the mid, in percent (positive = worse for the trader). */
export function estSlippagePct(m: MarketView, side: "buy" | "sell", size: number): number {
  const w = walkBook(side === "buy" ? m.book.asks : m.book.bids, size);
  if (!w.filled || !m.mid) return 0;
  return (side === "buy" ? w.avg / m.mid - 1 : 1 - w.avg / m.mid) * 100;
}

/** Order size granularity: the largest power of ten that is worth at most about one dollar (SOL 0.01, ETH 0.001, BTC 0.00001). */
export function sizeStep(price: number): number {
  if (!(price > 0)) return 0.01;
  return 10 ** Math.floor(Math.log10(1 / price));
}

export function roundSize(size: number, price: number): number {
  const step = sizeStep(price);
  const dec = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(size / step + 1e-9) * step).toFixed(dec));
}

/** Largest size that `pct` (0..1) of the account supports at `leverage` times equity. */
export function sizeForPct(pct: number, equity: number, leverage: number, price: number): number {
  if (!(price > 0) || !(equity > 0)) return 0;
  return roundSize((pct * equity * leverage) / price, price);
}

/** Share of equity a size uses at the market's leverage cap (what the server's margin check will see). */
export function marginFor(notional: number, cap: number): number {
  return cap > 0 ? notional / cap : notional;
}

/**
 * Mark price at which this position, on its own, takes equity down to the breach floor.
 * It is the "liquidation" line of a prop account: crossing it ends the challenge.
 */
export function breachPrice(p: Position, risk: Pick<Risk, "bufferRemaining">): number {
  const dir = p.side === "long" ? 1 : -1;
  const px = p.markPrice - (dir * risk.bufferRemaining) / p.size;
  return Math.max(0, px);
}

/** Fold a live price into the last candle (or open a new one when the bucket rolls over). Pure. */
export function applyTick(candles: Candle[], tfMs: number, price: number, now: number): Candle[] {
  if (!candles.length || !(price > 0)) return candles;
  const bucket = Math.floor(now / tfMs) * tfMs;
  const last = candles[candles.length - 1]!;
  if (bucket <= last.time) {
    const upd: Candle = { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) };
    return [...candles.slice(0, -1), upd];
  }
  return [...candles.slice(-499), { time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 }];
}

export function sma(candles: Candle[], n: number): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  let sum = 0;
  candles.forEach((c, i) => {
    sum += c.close;
    if (i >= n) sum -= candles[i - n]!.close;
    if (i >= n - 1) out.push({ time: c.time, value: sum / n });
  });
  return out;
}

/** 24h-style change versus the candle `bars` ago (for the header chip). */
export function changePct(candles: Candle[], mark: number, bars = 24): number | undefined {
  const ref = candles[Math.max(0, candles.length - 1 - bars)];
  return ref && ref.open > 0 ? mark / ref.open - 1 : undefined;
}
