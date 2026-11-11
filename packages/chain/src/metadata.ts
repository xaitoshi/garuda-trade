import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNIGHT_LEVELS, KNIGHT_STATUSES, isKnightLevel, type KnightAttrs, type KnightLevel, type KnightStatus } from "./types.js";

export const COLLECTION_NAME = "Garuda Knights";
export const COLLECTION_SYMBOL = "KNIGHT";
/** Repo-relative art folder (knight-1.png Squire through knight-4.png Ascended). Resolved from this module, then cwd. */
const ART_FROM_MODULE = join(dirname(fileURLToPath(import.meta.url)), "../../../art/knights");
const ART_FROM_CWD = join(process.cwd(), "art/knights");
export const DEFAULT_ART_DIR = existsSync(ART_FROM_MODULE) ? ART_FROM_MODULE : ART_FROM_CWD;

/** One 1:1 PNG per level, served at /nft/images/knight-N.png. */
export const LEVEL_IMAGE: Record<KnightLevel, string> = {
  squire: "knight-1.png",
  knight: "knight-2.png",
  paladin: "knight-3.png",
  ascended: "knight-4.png",
};
export const LEVEL_TITLE: Record<KnightLevel, string> = { squire: "Squire", knight: "Knight", paladin: "Paladin", ascended: "Ascended" };
const LEVEL_NUMBER: Record<KnightLevel, number> = { squire: 1, knight: 2, paladin: 3, ascended: 4 };

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const imageUrl = (baseUrl: string, level: KnightLevel) => `${trimSlash(baseUrl)}/nft/images/${LEVEL_IMAGE[level]}`;
/** Metadata URI per level: the asset's URI moves to the next level's file when the knight levels up. */
export const levelMetadataUri = (baseUrl: string, level: KnightLevel) => `${trimSlash(baseUrl)}/nft/metadata/${level}.json`;
export const collectionMetadataUri = (baseUrl: string) => `${trimSlash(baseUrl)}/nft/collection.json`;

/** Attributes plugin key/value list (all values are strings onchain). Order is stable so diffs are exact. */
export function toAttributeList(a: KnightAttrs): { key: string; value: string }[] {
  return [
    { key: "level", value: a.level },
    { key: "status", value: a.status },
    { key: "tier", value: a.tier },
    { key: "challenge_id", value: a.challengeId },
    { key: "wins", value: String(a.wins) },
    { key: "revives", value: String(a.revives) },
  ];
}

/** Parse the plugin list back. Undefined if a required key is missing or malformed: the asset is not a Garuda knight. */
export function fromAttributeList(list: readonly { key: string; value: string }[]): KnightAttrs | undefined {
  const m = new Map(list.map((x) => [x.key, x.value]));
  const level = m.get("level");
  const status = m.get("status");
  const tier = m.get("tier");
  const wins = Number(m.get("wins"));
  const revives = Number(m.get("revives"));
  if (!level || !isKnightLevel(level) || !status || !(KNIGHT_STATUSES as readonly string[]).includes(status)) return undefined;
  if (!tier || !isKnightLevel(tier) || !Number.isInteger(wins) || wins < 0 || !Number.isInteger(revives) || revives < 0) return undefined;
  return { level, status: status as KnightStatus, tier, challengeId: m.get("challenge_id") ?? "", wins, revives };
}

export const sameAttrs = (a: KnightAttrs, b: KnightAttrs) =>
  a.level === b.level && a.status === b.status && a.tier === b.tier && a.challengeId === b.challengeId && a.wins === b.wins && a.revives === b.revives;

/** Metaplex token-metadata style JSON for one level. Per-asset truth (wins, revives, status) is the onchain Attributes plugin. */
export function levelMetadata(baseUrl: string, level: KnightLevel) {
  const image = imageUrl(baseUrl, level);
  return {
    name: `Garuda Knight - ${LEVEL_TITLE[level]}`,
    symbol: COLLECTION_SYMBOL,
    description: `A Garuda knight at level ${LEVEL_NUMBER[level]} (${LEVEL_TITLE[level]}). It fights challenges on a simulated Phoenix Perps account. Level, status, wins and revives live onchain in the Attributes plugin. Rarity is cosmetic and never changes rules, size or payout.`,
    image,
    external_url: trimSlash(baseUrl),
    attributes: [
      { trait_type: "Level", value: LEVEL_TITLE[level] },
      { trait_type: "Level number", value: LEVEL_NUMBER[level], display_type: "number" },
    ],
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

export function collectionMetadata(baseUrl: string) {
  const image = imageUrl(baseUrl, "squire");
  return {
    name: COLLECTION_NAME,
    symbol: COLLECTION_SYMBOL,
    description: "Garuda knight NFTs: one per paid Squire or Knight challenge. Devnet.",
    image,
    external_url: trimSlash(baseUrl),
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

/** Image bytes for the static route; undefined for anything that is not one of the four known art files (no path traversal). */
export function readArt(dir: string, file: string): Buffer | undefined {
  if (!(Object.values(LEVEL_IMAGE) as string[]).includes(file)) return undefined;
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p) : undefined;
}

export const allLevels = KNIGHT_LEVELS;
