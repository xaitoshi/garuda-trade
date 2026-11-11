import { cents, TIERS, type TierId } from "./rules.js";

/**
 * Funded scaling (rulebook section 16, "Funded scaling"). Challenge tiers are Squire, Knight, Paladin and Ascended,
 * all open to buy. A passed and claimed challenge opens a funded account at Lv.1 of its tier. From there ONE flat rule,
 * identical at every level and tier, levels the account up:
 *
 *   level up  <=>  realized profit since the last level-up >= 5% of the CURRENT level's account size
 *                  AND at least one payout requested after the last level-up has completed (paid).
 *
 * Each level-up moves the account to the next size. Squire, Knight and Paladin have three sizes each (one third of the
 * gap to the next tier per step); levelling up from Lv.3 graduates the account into the next tier at Lv.1. Ascended
 * steps +$5,000 per level up to $100,000 at Lv.16, the cap. The split stays 80%.
 */

export type ScalingTier = Exclude<TierId, "demo">;

export const SCALING_RULES = {
  /** Realized profit since the last level-up, as a share of the current level's size. */
  levelUpProfitPct: 0.05,
  /** Completed payouts (requested after the last level-up) needed for a level-up. */
  levelUpPayouts: 1,
  /** Ascended: +$5,000 per level. */
  ascendedStepUsd: 5_000,
  /** Ascended: the top size. */
  ascendedMaxUsd: 100_000,
} as const;

/** The next tier up the ladder (undefined for Ascended). */
export const NEXT_TIER: Record<ScalingTier, ScalingTier | undefined> = { squire: "knight", knight: "paladin", paladin: "ascended", ascended: undefined };

/** Highest level of a tier: 3 for Squire, Knight and Paladin (Lv.3 graduates), 16 for Ascended. */
export function maxLevel(tier: ScalingTier): number {
  if (tier === "ascended") return 1 + Math.round((SCALING_RULES.ascendedMaxUsd - TIERS.ascended.accountSize) / SCALING_RULES.ascendedStepUsd);
  return 3;
}

export const isScalingTier = (t: TierId): t is ScalingTier => t !== "demo";

/** Funded account size at a tier and level, rounded to cents. */
export function levelSize(tier: ScalingTier, level: number): number {
  const lv = Math.max(1, Math.min(maxLevel(tier), Math.floor(level)));
  const base = TIERS[tier].accountSize;
  if (tier === "ascended") return cents(base + (lv - 1) * SCALING_RULES.ascendedStepUsd);
  const next = TIERS[NEXT_TIER[tier]!].accountSize;
  return cents(base + ((next - base) * (lv - 1)) / 3);
}

export interface TierLevel {
  tier: ScalingTier;
  level: number;
}

/** Where a level-up from (tier, level) lands: the next level, a graduation into the next tier at Lv.1, or nothing at the cap. */
export function nextStep(tier: ScalingTier, level: number): (TierLevel & { size: number; graduates: boolean }) | undefined {
  if (level < maxLevel(tier)) return { tier, level: level + 1, size: levelSize(tier, level + 1), graduates: false };
  const up = NEXT_TIER[tier];
  if (!up) return undefined;
  return { tier: up, level: 1, size: levelSize(up, 1), graduates: true };
}

/** "Squire Lv.2" */
export const tierLevelLabel = (tier: ScalingTier, level: number): string => `${TIERS[tier].name} Lv.${level}`;

/** The full scaling ladder (for /rules and the Rules page). */
export function scalingTable(): { tier: ScalingTier; name: string; levels: { level: number; size: number }[]; graduatesTo?: ScalingTier }[] {
  return (["squire", "knight", "paladin", "ascended"] as const).map((tier) => ({
    tier,
    name: TIERS[tier].name,
    levels: Array.from({ length: maxLevel(tier) }, (_, i) => ({ level: i + 1, size: levelSize(tier, i + 1) })),
    graduatesTo: NEXT_TIER[tier],
  }));
}

export interface LevelProgress {
  tier: ScalingTier;
  level: number;
  /** "Knight Lv.2" */
  label: string;
  size: number;
  /** Realized profit since the last level-up (fills net of fees and funding, payouts included). */
  profitSinceLevel: number;
  /** Profit needed: 5% of the current size. */
  profitTarget: number;
  profitMet: boolean;
  /** Completed payouts requested since the last level-up. */
  payoutsSinceLevel: number;
  payoutsNeeded: number;
  payoutsMet: boolean;
  /** Both conditions met. The level-up is applied when the book is flat. */
  eligible: boolean;
  /** Undefined at the Ascended Lv.16 cap. */
  next?: TierLevel & { size: number; graduates: boolean; label: string };
  atCap: boolean;
}

export function levelProgress(a: { tier: ScalingTier; level: number; profitSinceLevel: number; payoutsSinceLevel: number }): LevelProgress {
  const size = levelSize(a.tier, a.level);
  const profitTarget = cents(size * SCALING_RULES.levelUpProfitPct);
  const n = nextStep(a.tier, a.level);
  const profitMet = a.profitSinceLevel >= profitTarget - 1e-9;
  const payoutsMet = a.payoutsSinceLevel >= SCALING_RULES.levelUpPayouts;
  return {
    tier: a.tier,
    level: a.level,
    label: tierLevelLabel(a.tier, a.level),
    size,
    profitSinceLevel: a.profitSinceLevel,
    profitTarget,
    profitMet,
    payoutsSinceLevel: a.payoutsSinceLevel,
    payoutsNeeded: SCALING_RULES.levelUpPayouts,
    payoutsMet,
    eligible: Boolean(n) && profitMet && payoutsMet,
    next: n ? { ...n, label: tierLevelLabel(n.tier, n.level) } : undefined,
    atCap: !n,
  };
}
