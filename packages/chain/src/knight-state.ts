import type { Lifecycle, Stage, TierId, ChallengeStatus } from "@garuda/risk-engine";
import { levelIndex, type KnightAttrs, type KnightLevel } from "./types.js";

/** One challenge a knight has fought (a light summary row; no ledger needed). */
export interface KnightHistoryRow {
  id: string;
  tier: TierId;
  stage: Stage;
  status: ChallengeStatus;
  lifecycle: Lifecycle;
  createdAt: number;
  /** Set on a challenge opened by a revive. */
  reviveOf?: string;
}

/** Level a knight reaches by passing the evaluation of a tier (rulebook section 16). */
export const PASS_LEVEL: Record<Exclude<TierId, "demo">, KnightLevel> = {
  squire: "knight",
  knight: "knight",
  paladin: "paladin",
  ascended: "ascended",
};

/** Live = still fighting: active and not archived. Dormant funded accounts are still live (still locked). */
export const isLive = (r: Pick<KnightHistoryRow, "status" | "lifecycle">): boolean => r.status === "active" && r.lifecycle !== "archived";

/**
 * What the knight's onchain state SHOULD be, derived only from its challenge history. Deterministic and idempotent,
 * so any sync (after a breach, a pass, a revive, or a retry after an RPC failure) converges on the same answer.
 *
 * - level: Squire, raised by passed evaluations (Squire or Knight pass -> Knight, Paladin pass -> Paladin, Ascended pass -> Ascended), never lowered
 * - wins: passed evaluations; revives: challenges opened by a revive (the scars)
 * - frozen (transfer lock): any live challenge, funded included
 * - status: funded (live funded account) / active (live challenge) / wounded (latest fight breached) / ascended (level 4, nothing live) / idle
 */
export function deriveKnightState(rows: readonly KnightHistoryRow[]): { attrs: KnightAttrs; frozen: boolean } {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  let level: KnightLevel = "squire";
  let wins = 0;
  for (const r of sorted) {
    if (r.tier === "demo" || r.status !== "passed" || r.stage !== "evaluation") continue;
    wins++;
    const to = PASS_LEVEL[r.tier];
    if (levelIndex(to) > levelIndex(level)) level = to;
  }
  const revives = sorted.filter((r) => r.reviveOf !== undefined).length;
  const live = sorted.filter(isLive);
  const focus = live.length ? live[live.length - 1]! : sorted[sorted.length - 1];
  const tier = (focus && focus.tier !== "demo" ? focus.tier : "squire") as KnightLevel;
  let status: KnightAttrs["status"];
  if (live.some((r) => r.stage === "funded")) status = "funded";
  else if (live.length) status = "active";
  else if (focus?.status === "wounded") status = "wounded";
  else if (level === "ascended") status = "ascended";
  else status = "idle";
  return { attrs: { level, status, tier, challengeId: focus?.id ?? "", wins, revives }, frozen: live.length > 0 };
}
