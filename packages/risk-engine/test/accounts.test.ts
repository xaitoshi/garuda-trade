import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  checkAccountCaps,
  checkRevive,
  countsTowardCaps,
  demoRestartAt,
  nextLifecycle,
  type HeldAccount,
} from "../src/index.js";

const T0 = Date.UTC(2026, 0, 1);
const held = (tier: HeldAccount["tier"], size: number, over: Partial<HeldAccount> = {}): HeldAccount => ({
  tier,
  size,
  stage: "evaluation",
  status: "active",
  lifecycle: "active",
  ...over,
});

describe("account caps (rulebook section 20)", () => {
  it("allows exactly 200k aggregate evaluation size and rejects one dollar more", () => {
    const two100k = [held("ascended", 100_000), held("ascended", 100_000)];
    expect(checkAccountCaps({ held: [held("ascended", 100_000)], stage: "evaluation", tier: "ascended" })).toMatchObject({ ok: true, used: 100_000, cap: 200_000 });
    expect(checkAccountCaps({ held: two100k, stage: "evaluation", tier: "squire" })).toMatchObject({ ok: false, reason: "evaluation_cap_exceeded", used: 200_000 });
    expect(checkAccountCaps({ held: [held("ascended", 100_000), held("paladin", 50_000), held("paladin", 50_000)], stage: "evaluation", tier: "squire" }).ok).toBe(false);
    expect(checkAccountCaps({ held: [held("ascended", 100_000), held("paladin", 50_000)], stage: "evaluation", tier: "paladin" }).ok).toBe(true);
  });

  it("funded cap is 300k and tracked separately from evaluation", () => {
    const funded = [held("ascended", 100_000, { stage: "funded" }), held("ascended", 100_000, { stage: "funded" }), held("ascended", 100_000, { stage: "funded" })];
    expect(checkAccountCaps({ held: funded, stage: "funded", tier: "squire" })).toMatchObject({ ok: false, reason: "funded_cap_exceeded", cap: 300_000, used: 300_000 });
    // 300k funded does not block a new evaluation, and vice versa
    expect(checkAccountCaps({ held: funded, stage: "evaluation", tier: "ascended" }).ok).toBe(true);
    expect(checkAccountCaps({ held: [held("ascended", 100_000), held("ascended", 100_000)], stage: "funded", tier: "ascended" }).ok).toBe(true);
  });

  it("duplicate sizes are fine within the cap; wounded, passed, archived and demo accounts do not count", () => {
    const list = [
      held("ascended", 100_000, { status: "wounded" }),
      held("ascended", 100_000, { status: "passed" }),
      held("ascended", 100_000, { lifecycle: "archived" }),
      held("demo", 5_000),
      held("knight", 25_000),
      held("knight", 25_000),
    ];
    expect(list.filter(countsTowardCaps)).toHaveLength(2);
    expect(checkAccountCaps({ held: list, stage: "evaluation", tier: "ascended" })).toMatchObject({ ok: true, used: 50_000 });
  });

  it("demo is never capped", () => {
    expect(checkAccountCaps({ held: [held("ascended", 100_000), held("ascended", 100_000)], stage: "evaluation", tier: "demo" }).ok).toBe(true);
  });
});

describe("funded dormancy and archive (rulebook section 18)", () => {
  const base = { stage: "funded" as const, tier: "knight" as const, status: "active" as const, lifecycle: "active" as const, lastActivityAt: T0 };
  it("stays active until 90 days of no activity, then dormant effective exactly at day 90", () => {
    expect(nextLifecycle({ ...base, now: T0 + 89 * DAY_MS }).lifecycle).toBe("active");
    expect(nextLifecycle({ ...base, now: T0 + 90 * DAY_MS - 1 }).lifecycle).toBe("active");
    expect(nextLifecycle({ ...base, now: T0 + 90 * DAY_MS })).toEqual({ lifecycle: "dormant", at: T0 + 90 * DAY_MS });
  });
  it("archives 365 days after going dormant, not after the last order", () => {
    const dormantSince = T0 + 90 * DAY_MS;
    const dormant = { ...base, lifecycle: "dormant" as const, dormantSince };
    expect(nextLifecycle({ ...dormant, now: dormantSince + 364 * DAY_MS }).lifecycle).toBe("dormant");
    expect(nextLifecycle({ ...dormant, now: dormantSince + 365 * DAY_MS })).toEqual({ lifecycle: "archived", at: dormantSince + 365 * DAY_MS });
  });
  it("challenge accounts, demo, breached accounts and archived accounts never change", () => {
    const far = T0 + 1000 * DAY_MS;
    expect(nextLifecycle({ ...base, stage: "evaluation", now: far }).lifecycle).toBe("active");
    expect(nextLifecycle({ ...base, tier: "demo", now: far }).lifecycle).toBe("active");
    expect(nextLifecycle({ ...base, status: "wounded", now: far }).lifecycle).toBe("active");
    expect(nextLifecycle({ ...base, lifecycle: "archived", now: far }).lifecycle).toBe("archived");
  });
});

describe("revive rules (rulebook section 17)", () => {
  const ok = { tier: "knight" as const, status: "wounded" as const, alreadyRevived: false, revivesUsed: 0, breachAt: T0 };
  const H24 = 24 * 3_600_000;
  it("prices a revive at 20% off the same tier", () => {
    expect(checkRevive({ ...ok, tier: "squire", now: T0 + H24 }).fee).toBe(95.2);
    expect(checkRevive({ ...ok, tier: "knight", now: T0 + H24 }).fee).toBe(220);
    expect(checkRevive({ ...ok, tier: "paladin", now: T0 + H24 }).fee).toBe(399.2);
    expect(checkRevive({ ...ok, tier: "ascended", now: T0 + H24 }).fee).toBe(719.2);
  });
  it("waits out the 24h cooldown from the breach", () => {
    expect(checkRevive({ ...ok, now: T0 + H24 - 1 })).toMatchObject({ eligible: false, reason: "revive_cooldown", availableAt: T0 + H24 });
    expect(checkRevive({ ...ok, now: T0 + H24 })).toMatchObject({ eligible: true, revivesLeft: 3 });
  });
  it("caps at 3 revives per knight", () => {
    expect(checkRevive({ ...ok, revivesUsed: 2, now: T0 + H24 })).toMatchObject({ eligible: true, revivesLeft: 1 });
    expect(checkRevive({ ...ok, revivesUsed: 3, now: T0 + H24 })).toMatchObject({ eligible: false, reason: "revive_cap_reached", revivesLeft: 0 });
  });
  it("only wounded, not-yet-revived, non-demo accounts", () => {
    expect(checkRevive({ ...ok, status: "active", now: T0 + H24 }).reason).toBe("not_wounded");
    expect(checkRevive({ ...ok, status: "passed", now: T0 + H24 }).reason).toBe("not_wounded");
    expect(checkRevive({ ...ok, alreadyRevived: true, now: T0 + H24 }).reason).toBe("already_revived");
    expect(checkRevive({ ...ok, tier: "demo", now: T0 + H24 })).toMatchObject({ eligible: false, reason: "demo_no_revive", fee: 0 });
  });
});

describe("demo restart", () => {
  it("opens one hour after the breach", () => {
    expect(demoRestartAt(T0, T0 + 59 * 60_000)).toBe(T0 + 3_600_000);
    expect(demoRestartAt(T0, T0 + 3_600_000)).toBeUndefined();
    expect(demoRestartAt(undefined, T0)).toBeUndefined();
  });
});
