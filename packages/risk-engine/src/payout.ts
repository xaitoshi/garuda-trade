import { COMMON_RULES } from "./rules.js";
import type { BestDayCheck } from "./path-to-funded.js";

export interface PayoutQuote {
  grossProfit: number;
  traderShare: number;
  firmShare: number;
  eligible: boolean;
  reason?: "no_profit" | "below_minimum" | "open_positions" | "best_day_rule";
  /** Best-day rule over the current payout cycle (present when the caller supplied the day ledger). */
  bestDay?: BestDayCheck;
  /** Balance after payout: resets to starting balance (§11). */
  newBalance: number;
}

/**
 * Payout = (balance - starting) x 80%; sweeps all profit; min $20; all positions must be closed; and (Path to Funded
 * rule 8) the best-day rule must hold over the current payout cycle when `bestDay` is supplied. No waiting period.
 */
export function quotePayout(args: {
  startingBalance: number;
  balance: number;
  hasOpenPositions?: boolean;
  split?: number;
  minPayout?: number;
  bestDay?: BestDayCheck;
}): PayoutQuote {
  const split = args.split ?? COMMON_RULES.profitSplit;
  const min = args.minPayout ?? COMMON_RULES.minPayoutUsd;
  const gross = Math.max(0, args.balance - args.startingBalance);
  const trader = gross * split;
  const quote: PayoutQuote = {
    grossProfit: gross,
    traderShare: trader,
    firmShare: gross - trader,
    eligible: true,
    newBalance: args.startingBalance,
    ...(args.bestDay ? { bestDay: args.bestDay } : {}),
  };
  if (args.hasOpenPositions) return { ...quote, eligible: false, reason: "open_positions", newBalance: args.balance };
  if (gross <= 0) return { ...quote, eligible: false, reason: "no_profit", newBalance: args.balance };
  if (trader < min) return { ...quote, eligible: false, reason: "below_minimum", newBalance: args.balance };
  if (args.bestDay && !args.bestDay.ok) return { ...quote, eligible: false, reason: "best_day_rule", newBalance: args.balance };
  return quote;
}

/** Operator-tunable payout policy. Defaults are the rulebook numbers (section 11) plus the Phase 1 review threshold. */
export interface PayoutPolicy {
  /** Trader's share of profit, 0 < split <= 1. Rulebook: 0.8. */
  split: number;
  /** Minimum trader payout in USD. Rulebook: 20. */
  minUsd: number;
  /** A payout up to and including this many USD (trader share) is approved automatically; above it waits for an admin. */
  autoMaxUsd: number;
  /** Best-day consistency share for payout requests (rulebook: 0.5). 1 or more disables the gate. */
  bestDayMaxShare?: number;
}

export const DEFAULT_PAYOUT_POLICY: PayoutPolicy = {
  split: COMMON_RULES.profitSplit,
  minUsd: COMMON_RULES.minPayoutUsd,
  autoMaxUsd: 500,
  bestDayMaxShare: COMMON_RULES.bestDayMaxShare,
};

/** Read GARUDA_PAYOUT_SPLIT and GARUDA_PAYOUT_AUTO_MAX. Throws on a value that is not a sane number so a typo cannot ship. */
export function payoutPolicyFromEnv(env: Record<string, string | undefined>): PayoutPolicy {
  const num = (key: string, fallback: number, ok: (n: number) => boolean, hint: string): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${key}=${raw} is invalid: ${hint}`);
    return n;
  };
  return {
    split: num("GARUDA_PAYOUT_SPLIT", DEFAULT_PAYOUT_POLICY.split, (n) => n > 0 && n <= 1, "must be a fraction above 0 and at most 1 (0.8 = 80%)"),
    minUsd: DEFAULT_PAYOUT_POLICY.minUsd,
    bestDayMaxShare: DEFAULT_PAYOUT_POLICY.bestDayMaxShare,
    autoMaxUsd: num("GARUDA_PAYOUT_AUTO_MAX", DEFAULT_PAYOUT_POLICY.autoMaxUsd, (n) => n >= 0, "must be a USD amount of 0 or more (0 sends every payout to manual approval)"),
  };
}
