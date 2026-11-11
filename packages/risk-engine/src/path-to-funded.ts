import { COMMON_RULES, targetEquity } from "./rules.js";

/**
 * Path to Funded (rulebook section 9). A challenge passes only when ALL of these hold:
 *   1. closed (realized) balance >= starting balance x (1 + 10%); open profit does not count,
 *   2. the book is flat (no open positions),
 *   3. at least 3 UTC trading days (a day counts when a position is opened or closed),
 *   4. best-day rule: the best UTC day's realized profit <= 50% of the sum of the profitable days (losing days ignored).
 * Rules 3 and 4 are soft gates: missing them never breaches, the trader just keeps trading. The best-day rule also
 * gates funded payout requests (over the current payout cycle).
 */

const EPS = 1e-9;

export const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** Minimal fill shape (structurally compatible with the sim-engine Fill). */
export interface LedgerFill {
  ts: number;
  side: "buy" | "sell";
  size: number;
  realizedPnl: number;
  fee: number;
  positionAfter: number;
}

export interface LedgerFunding {
  ts: number;
  /** Positive = account paid. */
  amount: number;
}

/** Did this fill open or close a position (a flip does both)? Adding to or trimming a position does neither. */
export function fillOpensOrCloses(f: LedgerFill): boolean {
  const after = f.positionAfter;
  const before = after - (f.side === "buy" ? f.size : -f.size);
  const flat = (x: number) => Math.abs(x) < 1e-12;
  if (flat(before) && !flat(after)) return true;
  if (!flat(before) && flat(after)) return true;
  return !flat(before) && !flat(after) && Math.sign(before) !== Math.sign(after);
}

export interface DailyLedger {
  /** UTC day -> realized P&L that day (fills net of fees, minus funding paid). */
  dayPnl: Record<string, number>;
  /** Sorted UTC days with at least one position opened or closed. */
  tradingDays: string[];
}

/** Build the per-day realized ledger, optionally only from `since` (exclusive), e.g. the last payout sweep. */
export function dailyLedger(fills: readonly LedgerFill[], funding: readonly LedgerFunding[] = [], since?: number): DailyLedger {
  const dayPnl: Record<string, number> = {};
  const days = new Set<string>();
  const after = (ts: number) => since === undefined || ts > since;
  for (const f of fills) {
    if (!after(f.ts)) continue;
    const d = utcDay(f.ts);
    dayPnl[d] = (dayPnl[d] ?? 0) + f.realizedPnl - f.fee;
    if (fillOpensOrCloses(f)) days.add(d);
  }
  for (const p of funding) {
    if (!after(p.ts)) continue;
    const d = utcDay(p.ts);
    dayPnl[d] = (dayPnl[d] ?? 0) - p.amount;
  }
  return { dayPnl, tradingDays: [...days].sort() };
}

export interface BestDayCheck {
  /** Best single day's realized profit (0 when no profitable day). */
  bestDay: number;
  bestDayKey?: string;
  /** Sum of the profitable days (losing days ignored). */
  profitableTotal: number;
  /** bestDay / profitableTotal, null when there is no profitable day. */
  share: number | null;
  maxShare: number;
  ok: boolean;
}

export function bestDayCheck(dayPnl: Record<string, number>, maxShare: number = COMMON_RULES.bestDayMaxShare): BestDayCheck {
  let best = 0;
  let bestKey: string | undefined;
  let total = 0;
  for (const [d, v] of Object.entries(dayPnl)) {
    if (v <= EPS) continue;
    total += v;
    if (v > best) {
      best = v;
      bestKey = d;
    }
  }
  const share = total > EPS ? best / total : null;
  return { bestDay: best, bestDayKey: bestKey, profitableTotal: total, share, maxShare, ok: share !== null && share <= maxShare + 1e-9 };
}

export interface FundedProgress {
  /** Rule 1 */
  targetBalance: number;
  closedProfit: number;
  targetProfit: number;
  targetMet: boolean;
  /** Rule 2 */
  openPositions: number;
  flat: boolean;
  /** Rule 3 */
  tradingDays: number;
  minTradingDays: number;
  daysMet: boolean;
  /** Rule 4 */
  bestDay: BestDayCheck;
  /** All four met: the evaluation passes and the trader can claim the funded account. */
  eligible: boolean;
}

export function fundedProgress(args: {
  startingBalance: number;
  balance: number;
  openPositions: number;
  ledger: DailyLedger;
  profitTargetPct?: number;
  minTradingDays?: number;
  bestDayMaxShare?: number;
}): FundedProgress {
  const pct = args.profitTargetPct ?? COMMON_RULES.profitTargetPct;
  const minDays = args.minTradingDays ?? COMMON_RULES.minTradingDays;
  const targetBalance = targetEquity(args.startingBalance, pct);
  const targetMet = args.balance >= targetBalance - EPS;
  const flat = args.openPositions === 0;
  const daysMet = args.ledger.tradingDays.length >= minDays;
  const bestDay = bestDayCheck(args.ledger.dayPnl, args.bestDayMaxShare ?? COMMON_RULES.bestDayMaxShare);
  return {
    targetBalance,
    closedProfit: args.balance - args.startingBalance,
    targetProfit: targetBalance - args.startingBalance,
    targetMet,
    openPositions: args.openPositions,
    flat,
    tradingDays: args.ledger.tradingDays.length,
    minTradingDays: minDays,
    daysMet,
    bestDay,
    eligible: targetMet && flat && daysMet && bestDay.ok,
  };
}
