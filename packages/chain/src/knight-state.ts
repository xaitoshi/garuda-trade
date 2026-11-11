import type { Lifecycle, Stage, TierId, ChallengeStatus } from "@garuda/risk-engine";
import type { KnightAttrs, KnightTier } from "./types.js";

/** One challenge a knight has fought (a light summary row; no ledger needed). */
export interface KnightHistoryRow {
  id: string;
  /** The account's tier now (a funded account that graduated reports its new tier). */
  tier: TierId;
  stage: Stage;
  status: ChallengeStatus;
  lifecycle: Lifecycle;
  createdAt: number;
  /** Set on a challenge opened by a revive. */
  reviveOf?: string;
  /** Funded accounts: the current funded level within the tier (Funded scaling). */
  fundedLevel?: number;
}

/** Live = still fighting: active and not archived. Dormant funded accounts are still live (still locked). */
export const isLive = (r: Pick<KnightHistoryRow, "status" | "lifecycle">): boolean => r.status === "active" && r.lifecycle !== "archived";

/**
 * What the knight's onchain state SHOULD be, derived only from its challenge history. Deterministic and idempotent,
 * so any sync (after a breach, a pass, a level-up, a revive, or a retry after an RPC failure) converges on the same answer.
 *
 * - tier: the tier of the focus account (the live one, else the latest). Passing a challenge never changes the tier;
 *   only a funded graduation does (the funded account's tier moves up, so the knight's does too)
 * - level: the focus account's funded level when it is a funded account, else 1 (a fresh or re-funded account starts at Lv.1)
 * - wins: passed evaluations; revives: challenges opened by a revive (the scars)
 * - frozen (transfer lock): any live challenge, funded included
 * - status: funded (live funded account) / active (live challenge) / wounded (latest fight breached) / idle
 */
export function deriveKnightState(rows: readonly KnightHistoryRow[]): { attrs: KnightAttrs; frozen: boolean } {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const wins = sorted.filter((r) => r.tier !== "demo" && r.status === "passed" && r.stage === "evaluation").length;
  const revives = sorted.filter((r) => r.reviveOf !== undefined).length;
  const live = sorted.filter(isLive);
  // A live funded account is the knight's headline; otherwise the newest live account; otherwise the newest one.
  const focus = live.find((r) => r.stage === "funded") ?? (live.length ? live[live.length - 1]! : sorted[sorted.length - 1]);
  const tier = (focus && focus.tier !== "demo" ? focus.tier : "squire") as KnightTier;
  const level = focus?.stage === "funded" ? Math.max(1, focus.fundedLevel ?? 1) : 1;
  let status: KnightAttrs["status"];
  if (live.some((r) => r.stage === "funded")) status = "funded";
  else if (live.length) status = "active";
  else if (focus?.status === "wounded") status = "wounded";
  else status = "idle";
  return { attrs: { tier, level, status, challengeId: focus?.id ?? "", wins, revives }, frozen: live.length > 0 };
}
