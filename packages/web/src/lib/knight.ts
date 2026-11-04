import type { ChallengeState, TierId } from "./types";

/** Knight levels. One source of truth so the name and level shown on every screen agree (the mocks disagreed: LV.1 vs LV.2). */
export const LEVELS = [
  { level: 1, tier: "squire", name: "Squire" },
  { level: 2, tier: "knight", name: "Knight" },
  { level: 3, tier: "paladin", name: "Paladin" },
  { level: 4, tier: "ascended", name: "Ascended" },
] as const;

export type KnightLevel = 1 | 2 | 3 | 4;
export type ArtState = "active" | "wounded" | "victory" | "dormant";
export type BossState = "full" | "hurt" | "low" | "defeated";

/** A Demo has no knight NFT; it fights as a level 1 recruit. */
export function levelOfTier(tier: TierId): KnightLevel {
  return tier === "demo" ? 1 : ((LEVELS.findIndex((l) => l.tier === tier) + 1) as KnightLevel);
}

export const levelName = (l: KnightLevel): string => LEVELS[l - 1]!.name;
export const tierOfLevel = (l: number): TierId => LEVELS[Math.min(4, Math.max(1, l)) - 1]!.tier;

/** What the player sees: "Sir Pudding", "LV.2", "Knight". Everything on screen reads from this. */
export interface KnightView {
  name: string;
  level: KnightLevel;
  levelName: string;
  /** "LV.2 Knight" */
  label: string;
  /** "Sir Pudding · LV.2" */
  title: string;
  tier: TierId;
  demo: boolean;
}

export function displayName(raw: string | undefined, demo = false): string {
  const n = raw?.trim();
  if (!n || n === "Sir Unnamed") return demo ? "Demo recruit" : "Sir Unnamed";
  return n;
}

export function knightView(c: Pick<ChallengeState, "knight" | "tier" | "demo">): KnightView {
  const level = levelOfTier(c.tier);
  const name = displayName(c.knight, c.demo);
  return { name, level, levelName: levelName(level), label: `LV.${level} ${levelName(level)}`, title: `${name} · LV.${level}`, tier: c.tier, demo: c.demo };
}

export type UiStatus = "active" | "funded" | "wounded" | "ascended" | "passed" | "dormant" | "archived";

/** One chip per challenge. */
export function uiStatus(c: ChallengeState): UiStatus {
  if (c.status === "wounded") return "wounded";
  if (c.lifecycle === "archived") return "archived";
  if (c.lifecycle === "dormant") return "dormant";
  if (c.status === "passed") return "passed";
  if (c.stage === "funded") return c.tier === "ascended" ? "ascended" : "funded";
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

/** Boss art by remaining HP (1 = full) and outcome. */
export function bossState(c: Pick<ChallengeState, "status" | "risk">): BossState {
  if (c.status === "passed") return "defeated";
  const hp = 1 - (c.risk.targetProgressPct ?? 0);
  return hp > 0.66 ? "full" : hp > 0.33 ? "hurt" : "low";
}
export const bossSrc = (s: BossState): string => `/art/boss/${s}.png`;

/** Cosmetic names offered by the "Name" button on the reveal screen. */
export const KNIGHT_NAMES = ["Sir Pudding", "Lady Ember", "Sir Rook", "Bramble", "Pip", "Tiny", "Dame Ash", "Sir Lag", "Moonpaw", "Nightowl"] as const;
export const randomKnightName = (seed = Math.random()): string => KNIGHT_NAMES[Math.floor(seed * KNIGHT_NAMES.length) % KNIGHT_NAMES.length]!;
