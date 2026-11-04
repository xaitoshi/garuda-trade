import { ACCOUNT_CAPS, DEMO_RULES, DORMANCY, REVIVE_RULES, TIERS, type Stage, type TierId } from "./rules.js";
import type { ChallengeStatus } from "./monitor.js";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type Lifecycle = "active" | "dormant" | "archived";

/**
 * Funded-account lifecycle (§18). Only funded accounts go Dormant; challenge accounts never time out.
 * `lastActivityAt` is the time of the last order or payout request. Dormant -> archived is counted from `dormantSince`.
 * Returns the (possibly unchanged) lifecycle and the timestamp the transition takes effect.
 */
export function nextLifecycle(args: {
  stage: Stage;
  tier: TierId;
  status: ChallengeStatus;
  lifecycle: Lifecycle;
  lastActivityAt: number;
  dormantSince?: number;
  now: number;
}): { lifecycle: Lifecycle; at?: number } {
  const { stage, tier, status, lifecycle, lastActivityAt, dormantSince, now } = args;
  if (stage !== "funded" || tier === "demo" || status !== "active" || lifecycle === "archived") return { lifecycle };
  if (lifecycle === "active") {
    const dormantAt = lastActivityAt + DORMANCY.dormantAfterDays * DAY_MS;
    if (now < dormantAt) return { lifecycle };
    // A long outage can skip past both thresholds: report dormant first, the caller loops once more for archive.
    return { lifecycle: "dormant", at: dormantAt };
  }
  const archiveAt = (dormantSince ?? lastActivityAt + DORMANCY.dormantAfterDays * DAY_MS) + DORMANCY.archiveAfterDays * DAY_MS;
  if (now < archiveAt) return { lifecycle };
  return { lifecycle: "archived", at: archiveAt };
}

export interface HeldAccount {
  tier: TierId;
  stage: Stage;
  /** Account size (starting balance). */
  size: number;
  status: ChallengeStatus;
  lifecycle: Lifecycle;
}

/** Does this account count toward the identity's caps? Live accounts only; Demo never counts. */
export function countsTowardCaps(a: HeldAccount): boolean {
  return a.tier !== "demo" && a.status === "active" && a.lifecycle !== "archived";
}

export interface CapCheck {
  ok: boolean;
  cap: number;
  /** Aggregate of the live accounts in this stage before the new one. */
  used: number;
  requested: number;
  reason?: "evaluation_cap_exceeded" | "funded_cap_exceeded";
}

/** Rulebook §20: $200,000 aggregate evaluation account size and $300,000 aggregate funded, per identity. Demo is exempt. */
export function checkAccountCaps(args: { held: HeldAccount[]; stage: Stage; tier: TierId; size?: number }): CapCheck {
  const requested = args.size ?? TIERS[args.tier].accountSize;
  const cap = args.stage === "funded" ? ACCOUNT_CAPS.fundedAggregateUsd : ACCOUNT_CAPS.evaluationAggregateUsd;
  if (args.tier === "demo") return { ok: true, cap, used: 0, requested };
  const used = args.held.filter((a) => a.stage === args.stage && countsTowardCaps(a)).reduce((s, a) => s + a.size, 0);
  const ok = used + requested <= cap + 1e-9;
  return { ok, cap, used, requested, reason: ok ? undefined : args.stage === "funded" ? "funded_cap_exceeded" : "evaluation_cap_exceeded" };
}

export interface ReviveCheck {
  eligible: boolean;
  reason?: "demo_no_revive" | "not_wounded" | "already_revived" | "revive_cap_reached" | "revive_cooldown";
  /** USD, 20% off the tier's challenge fee, rounded to cents. */
  fee: number;
  revivesUsed: number;
  revivesLeft: number;
  /** ms epoch at which the cooldown ends (breach + 24h). */
  availableAt?: number;
}

/** Revive rules (§17): wounded only, 20% off the same tier, max 3 per knight, available 24h after the breach, not for Demo. */
export function checkRevive(args: {
  tier: TierId;
  status: ChallengeStatus;
  alreadyRevived: boolean;
  /** Revives this knight has already used across all of its challenges. */
  revivesUsed: number;
  breachAt?: number;
  now: number;
}): ReviveCheck {
  const spec = TIERS[args.tier];
  const fee = Math.round(spec.fee * (1 - REVIVE_RULES.discount) * 100) / 100;
  const base = { fee, revivesUsed: args.revivesUsed, revivesLeft: Math.max(0, REVIVE_RULES.maxPerKnight - args.revivesUsed) };
  const availableAt = args.breachAt === undefined ? undefined : args.breachAt + REVIVE_RULES.cooldownHours * HOUR_MS;
  if (args.tier === "demo") return { ...base, eligible: false, reason: "demo_no_revive", fee: 0, revivesLeft: 0 };
  if (args.status !== "wounded") return { ...base, eligible: false, reason: "not_wounded", availableAt };
  if (args.alreadyRevived) return { ...base, eligible: false, reason: "already_revived", availableAt };
  if (args.revivesUsed >= REVIVE_RULES.maxPerKnight) return { ...base, eligible: false, reason: "revive_cap_reached", availableAt };
  if (availableAt !== undefined && args.now < availableAt) return { ...base, eligible: false, reason: "revive_cooldown", availableAt };
  return { ...base, eligible: true, availableAt };
}

/** A breached Demo can be restarted for free one hour after the breach (§17). Returns the ms epoch it opens, if still closed. */
export function demoRestartAt(breachAt: number | undefined, now: number): number | undefined {
  if (breachAt === undefined) return undefined;
  const at = breachAt + DEMO_RULES.restartCooldownMs;
  return now < at ? at : undefined;
}
