import { LEVELS, levelOfTier } from "./knight";
import type { ChallengeState, KnightInfo, TierId } from "./types";

export interface Eligibility {
  /** Held knight levels, from the chain when the API has one, else inferred from the player's own challenges. */
  best: number;
  /** A knight to present for a gated tier (needed by the API when it verifies knights onchain). */
  asset?: string;
  locked: boolean;
  /** Pill text and style on the tier card. */
  pill: { kind: "" | "ok" | "lock"; text: string };
  reason?: string;
}

/** Highest knight level the wallet can use (wounded knights cannot enter gated tiers). */
export function bestKnight(knights: KnightInfo[] | null | undefined, challenges: ChallengeState[]): { level: number; asset?: string } {
  if (knights) {
    const usable = knights.filter((k) => k.genuine && k.status !== "wounded" && k.status !== "active" && k.status !== "funded");
    let best = 0;
    let asset: string | undefined;
    for (const k of usable) {
      const lv = LEVELS.findIndex((l) => l.tier === k.level) + 1;
      if (lv > best) {
        best = lv;
        asset = k.asset;
      }
    }
    return { level: best, asset };
  }
  // No chain: a knight levels up when it passes, so infer from the accounts the player has played.
  let best = 0;
  for (const c of challenges) {
    if (c.demo || c.status === "wounded") continue;
    const lv = levelOfTier(c.tier) + (c.status === "passed" && c.stage === "evaluation" ? 1 : 0);
    best = Math.max(best, Math.min(4, lv));
  }
  return { level: best };
}

export function eligibilityFor(tier: TierId, requires: TierId | undefined, held: { level: number; asset?: string }): Eligibility {
  if (!requires || tier === "demo") return { best: held.level, locked: false, pill: { kind: "", text: "Open to all" }, asset: undefined };
  const need = levelOfTier(requires);
  const name = LEVELS[need - 1]!.name;
  if (held.level >= need) return { best: held.level, locked: false, asset: held.asset, pill: { kind: "ok", text: `${name} NFT owned` } };
  return { best: held.level, locked: true, pill: { kind: "lock", text: `Needs ${name} NFT` }, reason: `Needs a ${name}-level knight in your wallet.` };
}
