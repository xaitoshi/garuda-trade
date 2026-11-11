import type { ChallengeState, TierId } from "./types";

/**
 * Knight tiers in ladder order, with the art number each one uses (art follows the TIER: /art/knights/<n>-<state>.png).
 * This number is NOT a level. Levels are funded levels within a tier (Funded scaling): "Squire Lv.2", "Knight Lv.1".
 */
export const LEVELS = [
  { level: 1, tier: "squire", name: "Squire" },
  { level: 2, tier: "knight", name: "Knight" },
  { level: 3, tier: "paladin", name: "Paladin" },
  { level: 4, tier: "ascended", name: "Ascended" },
] as const;

/** Art number of a tier (1 Squire .. 4 Ascended). */
export type KnightLevel = 1 | 2 | 3 | 4;
export type ArtState = "active" | "wounded" | "victory" | "dormant";
export type BossState = "full" | "hurt" | "low" | "defeated";

/** Art number of a tier. A Demo has no knight NFT; it uses the Squire art. */
export function levelOfTier(tier: TierId): KnightLevel {
  return tier === "demo" ? 1 : ((LEVELS.findIndex((l) => l.tier === tier) + 1) as KnightLevel);
}

export const levelName = (l: KnightLevel): string => LEVELS[l - 1]!.name;
export const tierOfLevel = (l: number): TierId => LEVELS[Math.min(4, Math.max(1, l)) - 1]!.tier;

/** What the player sees: "Sir Pudding", "Knight", "Knight Lv.2". Everything on screen reads from this. */
export interface KnightView {
  name: string;
  /** Art number of the tier (not a level). */
  level: KnightLevel;
  /** Tier name: "Knight". */
  levelName: string;
  /** Funded level within the tier; undefined for a challenge account. */
  fundedLevel?: number;
  /** "Knight Lv.2" on a funded account, "Knight" on a challenge. */
  label: string;
  /** "Sir Pudding · Knight Lv.2" */
  title: string;
  tier: TierId;
  demo: boolean;
}

export function displayName(raw: string | undefined, demo = false): string {
  const n = raw?.trim();
  if (!n || n === "Sir Unnamed") return demo ? "Demo recruit" : "Sir Unnamed";
  return n;
}

/** "Squire Lv.2" */
export const tierLevelLabel = (tier: TierId, level: number): string => `${tier === "demo" ? "Demo" : levelName(levelOfTier(tier))} Lv.${level}`;

export function knightView(c: Pick<ChallengeState, "knight" | "tier" | "demo"> & Partial<Pick<ChallengeState, "stage" | "scaling">>): KnightView {
  const level = levelOfTier(c.tier);
  const name = displayName(c.knight, c.demo);
  const fundedLevel = c.stage === "funded" && !c.demo ? (c.scaling?.level ?? 1) : undefined;
  const label = c.demo ? "Demo" : fundedLevel ? tierLevelLabel(c.tier, fundedLevel) : levelName(level);
  return { name, level, levelName: levelName(level), fundedLevel, label, title: `${name} · ${label}`, tier: c.tier, demo: c.demo };
}

/** Funded scaling ladder (same numbers as the API's /rules scaling.table; used when an older server has none). */
export function fallbackScalingTable(): { tier: Exclude<TierId, "demo">; name: string; levels: { level: number; size: number }[]; graduatesTo?: Exclude<TierId, "demo"> }[] {
  const size: Record<string, number> = { squire: 5_000, knight: 10_000, paladin: 15_000, ascended: 25_000 };
  const up: Record<string, Exclude<TierId, "demo"> | undefined> = { squire: "knight", knight: "paladin", paladin: "ascended", ascended: undefined };
  const c = (x: number) => Math.round(x * 100) / 100;
  return (["squire", "knight", "paladin", "ascended"] as const).map((tier) => {
    const base = size[tier]!;
    const next = up[tier];
    const levels = next
      ? [1, 2, 3].map((l) => ({ level: l, size: c(base + ((size[next]! - base) * (l - 1)) / 3) }))
      : Array.from({ length: 16 }, (_, i) => ({ level: i + 1, size: base + i * 5_000 }));
    return { tier, name: levelName(levelOfTier(tier)), levels, graduatesTo: next };
  });
}

export type UiStatus = "active" | "funded" | "wounded" | "ascended" | "passed" | "dormant" | "archived";

/** One chip per challenge. */
export function uiStatus(c: ChallengeState): UiStatus {
  if (c.status === "wounded") return "wounded";
  if (c.lifecycle === "archived") return "archived";
  if (c.lifecycle === "dormant") return "dormant";
  if (c.status === "passed") return "passed";
  if (c.stage === "funded") return "funded";
  return "active";
}

/** Which PNG the knight panel shows for a challenge. */
export function artState(c: ChallengeState): ArtState {
  const s = uiStatus(c);
  if (s === "wounded") return "wounded";
  if (s === "passed") return "victory";
  if (s === "dormant" || s === "archived") return "dormant";
  return "active";
}

export const knightSrc = (level: KnightLevel, state: ArtState): string => `/art/knights/${level}-${state}.png`;
/** Portrait cover-crop for tall challenge / landing cards so the dots reach every edge. */
export const knightCardSrc = (level: KnightLevel): string => `/art/cards/${level}.png`;

/** Boss art by remaining HP (1 = full) and outcome. */
export function bossState(c: Pick<ChallengeState, "status" | "risk">): BossState {
  if (c.status === "passed") return "defeated";
  const hp = 1 - (c.risk.targetProgressPct ?? 0);
  return hp > 0.66 ? "full" : hp > 0.33 ? "hurt" : "low";
}

/** Cosmetic names offered by the "Name" button on the reveal screen. */
export const KNIGHT_NAMES = ["Sir Pudding", "Lady Ember", "Sir Rook", "Bramble", "Pip", "Tiny", "Dame Ash", "Sir Lag", "Moonpaw", "Nightowl"] as const;
export const randomKnightName = (seed = Math.random()): string => KNIGHT_NAMES[Math.floor(seed * KNIGHT_NAMES.length) % KNIGHT_NAMES.length]!;
