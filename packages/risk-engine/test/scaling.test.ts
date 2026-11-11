import { describe, expect, it } from "vitest";
import { ACCOUNT_CAPS, SCALING_RULES, TIERS, levelProgress, levelSize, maxLevel, nextStep, scalingTable, tierLevelLabel } from "../src/index.js";

describe("funded scaling ladder", () => {
  it("every tier is open to buy (no knight-level requirement)", () => {
    for (const t of Object.values(TIERS)) expect((t as unknown as Record<string, unknown>).requires).toBeUndefined();
  });

  it("sizes are one third of the gap to the next tier, rounded to cents; Ascended steps $5,000 to $100,000 at Lv.16", () => {
    expect([1, 2, 3].map((l) => levelSize("squire", l))).toEqual([5_000, 6_666.67, 8_333.33]);
    expect([1, 2, 3].map((l) => levelSize("knight", l))).toEqual([10_000, 11_666.67, 13_333.33]);
    expect([1, 2, 3].map((l) => levelSize("paladin", l))).toEqual([15_000, 18_333.33, 21_666.67]);
    expect(maxLevel("ascended")).toBe(16);
    expect(levelSize("ascended", 1)).toBe(25_000);
    expect(levelSize("ascended", 2)).toBe(30_000);
    expect(levelSize("ascended", 16)).toBe(100_000);
    expect(levelSize("ascended", 99)).toBe(100_000);
  });

  it("Lv.3 of Squire, Knight and Paladin graduates into Lv.1 of the next tier; Ascended Lv.16 is the cap", () => {
    expect(nextStep("squire", 1)).toEqual({ tier: "squire", level: 2, size: 6_666.67, graduates: false });
    expect(nextStep("squire", 3)).toEqual({ tier: "knight", level: 1, size: 10_000, graduates: true });
    expect(nextStep("knight", 3)).toEqual({ tier: "paladin", level: 1, size: 15_000, graduates: true });
    expect(nextStep("paladin", 3)).toEqual({ tier: "ascended", level: 1, size: 25_000, graduates: true });
    expect(nextStep("ascended", 15)).toMatchObject({ tier: "ascended", level: 16, size: 100_000 });
    expect(nextStep("ascended", 16)).toBeUndefined();
    expect(tierLevelLabel("knight", 2)).toBe("Knight Lv.2");
  });

  it("the table the API and the Rules page show", () => {
    const t = scalingTable();
    expect(t.map((r) => [r.tier, r.levels.length, r.graduatesTo])).toEqual([
      ["squire", 3, "knight"],
      ["knight", 3, "paladin"],
      ["paladin", 3, "ascended"],
      ["ascended", 16, undefined],
    ]);
  });

  it("one flat rule at every level: +5% of the CURRENT size realized since the last level-up AND one completed payout", () => {
    expect(SCALING_RULES).toMatchObject({ levelUpProfitPct: 0.05, levelUpPayouts: 1 });
    const base = { tier: "squire" as const, level: 2 };
    expect(levelProgress({ ...base, profitSinceLevel: 333.33, payoutsSinceLevel: 1 })).toMatchObject({ profitTarget: 333.33, eligible: true, label: "Squire Lv.2", next: { label: "Squire Lv.3", size: 8_333.33 } });
    expect(levelProgress({ ...base, profitSinceLevel: 333.32, payoutsSinceLevel: 3 }).eligible).toBe(false);
    expect(levelProgress({ ...base, profitSinceLevel: 9_999, payoutsSinceLevel: 0 }).eligible).toBe(false);
    expect(levelProgress({ tier: "ascended", level: 16, profitSinceLevel: 99_999, payoutsSinceLevel: 9 })).toMatchObject({ eligible: false, atCap: true, next: undefined });
  });

  it("the largest funded account ($100,000) fits under the funded aggregate cap", () => {
    expect(levelSize("ascended", 16)).toBeLessThanOrEqual(ACCOUNT_CAPS.fundedAggregateUsd);
    expect(ACCOUNT_CAPS.fundedAggregateUsd).toBe(300_000);
  });
});
