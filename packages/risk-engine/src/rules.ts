/**
 * Garuda Trading Rules, as code. Source of truth for the numbers is the "Garuda Trading Rules"
 * Notion page (/workspace/garuda/rules.md). Section numbers below refer to that rulebook.
 */

export type TierId = "demo" | "squire" | "knight" | "paladin" | "ascended";
export type Stage = "evaluation" | "funded";

/** Rule values shared by every tier (rulebook §5-§9). All one-step, static drawdown. */
export const COMMON_RULES = {
  /** §6: 3% of start-of-day BALANCE, measured on equity, resets 00:00 UTC. */
  dailyLossPct: 0.03,
  /** §7: static, from starting balance, never trails. */
  maxDrawdownPct: 0.06,
  /** §9: 10% of starting balance, evaluation only, no minimum days, no time limit. */
  profitTargetPct: 0.1,
  /** §11: 80% of profit to the trader. */
  profitSplit: 0.8,
  /** §11: minimum payout in USDC. */
  minPayoutUsd: 20,
  /** §7: warnings when this fraction of a buffer is used. */
  warningLevels: [0.5, 0.8] as const,
  /** §6: day boundary. */
  resetHourUtc: 0,
} as const;

export interface TierSpec {
  id: TierId;
  name: string;
  accountSize: number;
  /** USDC; 0 for the free demo. */
  fee: number;
  /** §17: 20% off, same tier. */
  reviveFee: number;
  /** NFT level required to buy, if any (§16). */
  requires?: TierId;
  /** Demo has no payouts / NFT. */
  payouts: boolean;
}

export const TIERS: Record<TierId, TierSpec> = {
  demo: { id: "demo", name: "Demo", accountSize: 5_000, fee: 0, reviveFee: 0, payouts: false },
  squire: { id: "squire", name: "Squire", accountSize: 10_000, fee: 119, reviveFee: 95.2, payouts: true },
  knight: { id: "knight", name: "Knight", accountSize: 25_000, fee: 275, reviveFee: 220, payouts: true },
  paladin: {
    id: "paladin",
    name: "Paladin",
    accountSize: 50_000,
    fee: 499,
    reviveFee: 399.2,
    requires: "knight",
    payouts: true,
  },
  ascended: {
    id: "ascended",
    name: "Ascended",
    accountSize: 100_000,
    fee: 899,
    reviveFee: 719.2,
    requires: "paladin",
    payouts: true,
  },
};

export const TIER_IDS = Object.keys(TIERS) as TierId[];

/** Revive limits (§17). */
export const REVIVE_RULES = { discount: 0.2, maxPerKnight: 3, cooldownHours: 24 } as const;

/** Account caps (§20). */
export const ACCOUNT_CAPS = { evaluationAggregateUsd: 200_000, fundedAggregateUsd: 300_000 } as const;

export interface RiskLimits {
  startingBalance: number;
  dailyLossPct: number;
  maxDrawdownPct: number;
  /** null in the funded stage (no target). */
  profitTargetPct: number | null;
  warningLevels: readonly number[];
}

export function limitsForTier(tier: TierId, stage: Stage = "evaluation"): RiskLimits {
  const spec = TIERS[tier];
  return {
    startingBalance: spec.accountSize,
    dailyLossPct: COMMON_RULES.dailyLossPct,
    maxDrawdownPct: COMMON_RULES.maxDrawdownPct,
    profitTargetPct: stage === "evaluation" ? COMMON_RULES.profitTargetPct : null,
    warningLevels: COMMON_RULES.warningLevels,
  };
}

/** Round to whole cents so floors and targets are exact dollar-and-cent figures. */
export function cents(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Static max-drawdown equity floor (§7): start x (1 - 6%). */
export function drawdownFloor(startingBalance: number, maxDrawdownPct: number = COMMON_RULES.maxDrawdownPct): number {
  return cents(startingBalance * (1 - maxDrawdownPct));
}

/** Profit-target equity (§9). */
export function targetEquity(startingBalance: number, profitTargetPct: number = COMMON_RULES.profitTargetPct): number {
  return cents(startingBalance * (1 + profitTargetPct));
}
