import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNIGHT_STATUSES, KNIGHT_TIERS, isKnightTierName, type KnightAttrs, type KnightStatus, type KnightTier } from "./types.js";

export const COLLECTION_NAME = "Garuda Knights";
export const COLLECTION_SYMBOL = "KNIGHT";
/** Repo-relative art folder (knight-1.png Squire through knight-4.png Ascended). Resolved from this module, then cwd. */
const ART_FROM_MODULE = join(dirname(fileURLToPath(import.meta.url)), "../../../art/knights");
const ART_FROM_CWD = join(process.cwd(), "art/knights");
export const DEFAULT_ART_DIR = existsSync(ART_FROM_MODULE) ? ART_FROM_MODULE : ART_FROM_CWD;

/** One 1:1 PNG per tier, served at /nft/images/knight-N.png (art follows the tier). */
export const TIER_IMAGE: Record<KnightTier, string> = {
  squire: "knight-1.png",
  knight: "knight-2.png",
  paladin: "knight-3.png",
  ascended: "knight-4.png",
};
export const TIER_TITLE: Record<KnightTier, string> = { squire: "Squire", knight: "Knight", paladin: "Paladin", ascended: "Ascended" };

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const imageUrl = (baseUrl: string, tier: KnightTier) => `${trimSlash(baseUrl)}/nft/images/${TIER_IMAGE[tier]}`;
/** Metadata URI per tier: the asset's URI moves to the next tier's file when the knight's funded account graduates. */
export const tierMetadataUri = (baseUrl: string, tier: KnightTier) => `${trimSlash(baseUrl)}/nft/metadata/${tier}.json`;
export const collectionMetadataUri = (baseUrl: string) => `${trimSlash(baseUrl)}/nft/collection.json`;

/** Attributes plugin key/value list (all values are strings onchain). Order is stable so diffs are exact. */
export function toAttributeList(a: KnightAttrs): { key: string; value: string }[] {
  return [
    { key: "tier", value: a.tier },
    { key: "level", value: String(a.level) },
    { key: "status", value: a.status },
    { key: "challenge_id", value: a.challengeId },
    { key: "wins", value: String(a.wins) },
    { key: "revives", value: String(a.revives) },
  ];
}

/**
 * Parse the plugin list back. Undefined if a required key is missing or malformed: the asset is not a Garuda knight.
 * Knights minted before Funded scaling carry `level` as a tier NAME (the old knight level); that reads as Lv.1 and the
 * next sync rewrites it as a number.
 */
export function fromAttributeList(list: readonly { key: string; value: string }[]): KnightAttrs | undefined {
  const m = new Map(list.map((x) => [x.key, x.value]));
  const rawLevel = m.get("level");
  const status = m.get("status");
  const tier = m.get("tier");
  const wins = Number(m.get("wins"));
  const revives = Number(m.get("revives"));
  if (!rawLevel || !status || !(KNIGHT_STATUSES as readonly string[]).includes(status)) return undefined;
  const level = isKnightTierName(rawLevel) ? 1 : Number(rawLevel);
  if (!Number.isInteger(level) || level < 1) return undefined;
  if (!tier || !isKnightTierName(tier) || !Number.isInteger(wins) || wins < 0 || !Number.isInteger(revives) || revives < 0) return undefined;
  return { tier, level, status: status as KnightStatus, challengeId: m.get("challenge_id") ?? "", wins, revives };
}

export const sameAttrs = (a: KnightAttrs, b: KnightAttrs) =>
  a.level === b.level && a.status === b.status && a.tier === b.tier && a.challengeId === b.challengeId && a.wins === b.wins && a.revives === b.revives;

/** Metaplex token-metadata style JSON for one tier. Per-asset truth (funded level, status, wins, revives) is the onchain Attributes plugin. */
export function tierMetadata(baseUrl: string, tier: KnightTier) {
  const image = imageUrl(baseUrl, tier);
  return {
    name: `Garuda Knight - ${TIER_TITLE[tier]}`,
    symbol: COLLECTION_SYMBOL,
    description: `A ${TIER_TITLE[tier]} tier Garuda knight. It fights challenges on a simulated Phoenix Perps account. Once funded it levels up within its tier (${TIER_TITLE[tier]} Lv.1, Lv.2 and so on) and graduates to the next tier. Tier, funded level, status, wins and revives live onchain in the Attributes plugin. Rarity is cosmetic and never changes rules, size or payout.`,
    image,
    external_url: trimSlash(baseUrl),
    attributes: [
      { trait_type: "Tier", value: TIER_TITLE[tier] },
      { trait_type: "Tier number", value: KNIGHT_TIERS.indexOf(tier) + 1, display_type: "number" },
    ],
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

export function collectionMetadata(baseUrl: string) {
  const image = imageUrl(baseUrl, "squire");
  return {
    name: COLLECTION_NAME,
    symbol: COLLECTION_SYMBOL,
    description: "Garuda knight NFTs: one per paid challenge (Squire, Knight, Paladin or Ascended). Devnet.",
    image,
    external_url: trimSlash(baseUrl),
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

/** Image bytes for the static route; undefined for anything that is not one of the four known art files (no path traversal). */
export function readArt(dir: string, file: string): Buffer | undefined {
  if (!(Object.values(TIER_IMAGE) as string[]).includes(file)) return undefined;
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p) : undefined;
}

export const allTiers = KNIGHT_TIERS;
