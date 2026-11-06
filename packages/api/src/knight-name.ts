/** Default cosmetic name when create/rename omit one. Combat logs use this string. */
export const DEFAULT_KNIGHT_NAME = "Sir Unnamed";

/** Paid and demo share the same cosmetic limit (purchase `knightName` is max 24). */
export const KNIGHT_NAME_MAX = 24;

/**
 * Trim and collapse internal whitespace. Empty / whitespace-only → undefined (caller falls back to default).
 * Length is capped at KNIGHT_NAME_MAX after trim.
 */
export function normalizeKnightName(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = raw.trim().replace(/\s+/g, " ");
  if (!n) return undefined;
  return n.slice(0, KNIGHT_NAME_MAX);
}

/** True when the stored name is the placeholder (or empty). Demo UI offers a one-time rename for these. */
export function isUnnamedKnight(name: string | undefined | null): boolean {
  const n = name?.trim();
  return !n || n === DEFAULT_KNIGHT_NAME;
}
