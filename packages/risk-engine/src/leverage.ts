import { leverageCap } from "./markets.js";

export interface ExposureLeg {
  symbol: string;
  /** Signed base size. */
  size: number;
  markPrice: number;
}

/** Required margin = sum over positions of notional at mark / that market's cap (rulebook §12). */
export function requiredMargin(legs: ExposureLeg[]): number {
  let m = 0;
  for (const l of legs) {
    const cap = leverageCap(l.symbol);
    if (cap === undefined) {
      // Non-whitelisted (reduce-only leftovers): be strict, treat as 1x.
      m += Math.abs(l.size) * l.markPrice;
    } else {
      m += (Math.abs(l.size) * l.markPrice) / cap;
    }
  }
  return m;
}

export interface LeverageCheck {
  allowed: boolean;
  reason?: "leverage_cap_exceeded" | "market_not_whitelisted";
  requiredMarginBefore: number;
  requiredMarginAfter: number;
  equity: number;
  /** Effective account leverage after the order: gross notional / equity. */
  effectiveLeverageAfter: number;
}

/**
 * Pre-trade check: an order that would push required margin above equity is rejected (§12).
 * Orders that do not increase required margin (reducing orders) are always allowed.
 */
export function checkOrderLeverage(args: {
  equity: number;
  positions: ExposureLeg[];
  order: { symbol: string; side: "buy" | "sell"; size: number; markPrice: number; reduceOnly?: boolean };
}): LeverageCheck {
  const { equity, positions, order } = args;
  const before = requiredMargin(positions);
  const delta = order.side === "buy" ? order.size : -order.size;
  const legs = new Map(positions.map((p) => [p.symbol, { ...p }]));
  const leg = legs.get(order.symbol) ?? { symbol: order.symbol, size: 0, markPrice: order.markPrice };
  leg.size += delta;
  leg.markPrice = order.markPrice;
  legs.set(order.symbol, leg);
  const after = requiredMargin([...legs.values()]);
  let gross = 0;
  for (const l of legs.values()) gross += Math.abs(l.size) * l.markPrice;
  const base = { requiredMarginBefore: before, requiredMarginAfter: after, equity, effectiveLeverageAfter: gross / Math.max(equity, 1e-9) };

  if (order.reduceOnly || after <= before + 1e-9) return { allowed: true, ...base };
  if (leverageCap(order.symbol) === undefined) return { allowed: false, reason: "market_not_whitelisted", ...base };
  if (after > equity + 1e-9) return { allowed: false, reason: "leverage_cap_exceeded", ...base };
  return { allowed: true, ...base };
}

/** Largest base size that can be added in `side` for a market without breaching the margin rule. */
export function maxOrderSize(args: {
  equity: number;
  positions: ExposureLeg[];
  symbol: string;
  side: "buy" | "sell";
  markPrice: number;
}): number {
  const cap = leverageCap(args.symbol);
  if (cap === undefined) return 0;
  const before = requiredMargin(args.positions);
  const cur = args.positions.find((p) => p.symbol === args.symbol)?.size ?? 0;
  const dir = args.side === "buy" ? 1 : -1;
  const c = cur * dir < 0 ? Math.abs(cur) : 0; // exposure this order would first close
  const perUnit = args.markPrice / cap;
  const free = args.equity - before;
  // s <= c always reduces margin; beyond that margin = before + (s - 2c) * perUnit.
  return Math.max(c, free / perUnit + 2 * c, 0);
}
