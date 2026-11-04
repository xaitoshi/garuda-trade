import { COMMON_RULES } from "./rules.js";

export interface PayoutQuote {
  grossProfit: number;
  traderShare: number;
  firmShare: number;
  eligible: boolean;
  reason?: "no_profit" | "below_minimum" | "open_positions";
  /** Balance after payout: resets to starting balance (§11). */
  newBalance: number;
}

/** Payout = (balance - starting) x 80%; sweeps all profit; min $20; all positions must be closed. */
export function quotePayout(args: {
  startingBalance: number;
  balance: number;
  hasOpenPositions?: boolean;
  split?: number;
  minPayout?: number;
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
  };
  if (args.hasOpenPositions) return { ...quote, eligible: false, reason: "open_positions", newBalance: args.balance };
  if (gross <= 0) return { ...quote, eligible: false, reason: "no_profit", newBalance: args.balance };
  if (trader < min) return { ...quote, eligible: false, reason: "below_minimum", newBalance: args.balance };
  return quote;
}
