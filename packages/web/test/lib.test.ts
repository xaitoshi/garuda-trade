import { describe, expect, it } from "vitest";
import { breachPrice, estSlippagePct, roundSize, sizeForPct, sizeStep, walkBook, applyTick } from "../src/lib/trade";
import { clamp, hms, msToUtcReset, pct, pctSigned, shortAddr, usd, usdSigned } from "../src/lib/format";
import { artState, displayName, fallbackScalingTable, knightView, tierLevelLabel, tierOfLevel, uiStatus } from "../src/lib/knight";
import { buildBreachSeries } from "../src/lib/breach";
import { groupKnights, matches, summary } from "../src/lib/barracks";
import { eligibilityFor } from "../src/lib/eligibility";
import { pendingCelebration } from "../src/components/LevelUp";
import { explorerTxUrl, isOpenPayout, notEligibleText, openPayout, payoutStatusText, totalPaid } from "../src/lib/payout";
import type { ChallengeState, MarketView, PayoutView, Position } from "../src/lib/types";

const ch = (o: Record<string, unknown> = {}): ChallengeState =>
  ({
    id: "ch_1",
    tier: "squire",
    stage: "evaluation",
    status: "active",
    lifecycle: "active",
    demo: false,
    knight: "Sir Pudding",
    knightId: "KnightAsset1234",
    createdAt: 1,
    lastActivityAt: 1,
    recentFills: [],
    account: {},
    risk: { startingBalance: 10_000, profitLoss: 0, bufferRemaining: 300 },
    ...o,
  }) as unknown as ChallengeState;

describe("trade math", () => {
  it("walks the book and reports the average fill and what it could fill", () => {
    const w = walkBook([[100, 1], [101, 2]], 2);
    expect(w.filled).toBe(2);
    expect(w.avg).toBeCloseTo(100.5);
    expect(walkBook([[100, 1]], 5)).toEqual({ avg: 100, filled: 1 });
    expect(walkBook([], 1)).toEqual({ avg: 0, filled: 0 });
  });

  it("slippage is positive when the fill is worse than mid, for both sides", () => {
    const m = { mid: 100, book: { asks: [[101, 10]], bids: [[99, 10]] } } as unknown as MarketView;
    expect(estSlippagePct(m, "buy", 1)).toBeCloseTo(1);
    expect(estSlippagePct(m, "sell", 1)).toBeCloseTo(1);
  });

  it("size steps follow the price (SOL 0.01, ETH 0.001, BTC 0.00001) and rounding never rounds up", () => {
    expect(sizeStep(93)).toBe(0.01);
    expect(sizeStep(3200)).toBe(0.0001);
    expect(sizeStep(78_000)).toBe(0.00001);
    expect(roundSize(1.2399, 93)).toBe(1.23);
    expect(roundSize(0.0009, 93)).toBe(0);
  });

  it("sizes by percent of leveraged equity", () => {
    expect(sizeForPct(0.5, 10_000, 5, 100)).toBe(250);
    expect(sizeForPct(1, 0, 5, 100)).toBe(0);
  });

  it("the breach price sits below a long and above a short by buffer / size", () => {
    const long = { side: "long", size: 10, markPrice: 100 } as Position;
    const short = { side: "short", size: 10, markPrice: 100 } as Position;
    expect(breachPrice(long, { bufferRemaining: 300 })).toBe(70);
    expect(breachPrice(short, { bufferRemaining: 300 })).toBe(130);
    expect(breachPrice(long, { bufferRemaining: 5000 })).toBe(0);
  });

  it("folds a tick into the open candle or opens a new one on rollover", () => {
    const c = [{ time: 0, open: 1, high: 2, low: 1, close: 2, volume: 0 }];
    const same = applyTick(c, 60_000, 3, 30_000);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ high: 3, close: 3 });
    const next = applyTick(c, 60_000, 1.5, 61_000);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ open: 2, close: 1.5 });
  });
});

describe("format", () => {
  it("formats money, percent and addresses without glyph surprises", () => {
    expect(usd(1234.5)).toBe("$1,235");
    expect(usdSigned(-44)).toBe("-$44");
    expect(usdSigned(44)).toBe("+$44");
    expect(pct(0.1)).toBe("10.0%");
    expect(pctSigned(-0.052)).toBe("-5.2%");
    expect(shortAddr("8QuVabcdefghijklmnopqrstuvwxyz9gTk")).toBe("8QuV..9gTk");
    expect(clamp(5, 0, 3)).toBe(3);
  });

  it("counts down to the UTC reset and formats durations", () => {
    expect(hms(3_725_000)).toBe("01:02:05");
    const noon = Date.UTC(2026, 10, 4, 12, 0, 0);
    expect(msToUtcReset(noon)).toBe(12 * 3_600_000);
  });
});

describe("knights", () => {
  it("name and level are one fact: the same view feeds every screen", () => {
    // a challenge shows the tier; a funded account shows tier and funded level
    expect(knightView(ch({ tier: "squire" })).title).toBe("Sir Pudding · Squire");
    expect(knightView(ch({ tier: "knight" })).label).toBe("Knight");
    expect(knightView(ch({ tier: "knight", stage: "funded" })).label).toBe("Knight Lv.1");
    expect(knightView(ch({ tier: "squire", stage: "funded", scaling: { level: 2 } })).title).toBe("Sir Pudding · Squire Lv.2");
    expect(knightView(ch({ tier: "paladin", stage: "funded", scaling: { level: 3 } })).level).toBe(3); // art number of the tier
    expect(tierLevelLabel("ascended", 16)).toBe("Ascended Lv.16");
    expect(displayName(undefined, true)).toBe("Demo recruit");
    expect(displayName("Sir Unnamed")).toBe("Sir Unnamed");
    expect(tierOfLevel(9)).toBe("ascended");
  });

  it("maps a challenge to one status chip and one PNG state", () => {
    expect(uiStatus(ch({ status: "wounded" }))).toBe("wounded");
    expect(uiStatus(ch({ status: "passed" }))).toBe("passed");
    expect(uiStatus(ch({ stage: "funded" }))).toBe("funded");
    expect(uiStatus(ch({ stage: "funded", tier: "ascended" }))).toBe("funded");
    expect(uiStatus(ch({ lifecycle: "dormant" }))).toBe("dormant");
    expect(artState(ch({ status: "wounded" }))).toBe("wounded");
    expect(artState(ch({ status: "passed" }))).toBe("victory");
    expect(artState(ch())).toBe("active");
  });
});

describe("breach series", () => {
  it("is undefined without a breach and ends at the breach equity with the floor inside the axis", () => {
    expect(buildBreachSeries(ch())).toBeUndefined();
    const s = buildBreachSeries(
      ch({
        status: "wounded",
        recentFills: [{ ts: 1000, realizedPnl: 0, fee: 5 }],
        risk: { startingBalance: 10_000, breach: { ts: 5000, rule: "daily_loss", equity: 9_100, floor: 9_700 } },
      }),
    )!;
    expect(s.points[s.points.length - 1]).toEqual({ ts: 5000, value: 9_100 });
    expect(s.points[1]!.value).toBe(9_995);
    expect(s.lo).toBeLessThan(9_100);
    expect(s.hi).toBeGreaterThan(10_000);
  });
});

describe("barracks", () => {
  it("one card per knight: the live account wins, demos stay separate", () => {
    const list = [
      ch({ id: "a", createdAt: 1, status: "wounded" }),
      ch({ id: "b", createdAt: 2, status: "active" }),
      ch({ id: "c", knightId: undefined, demo: true, tier: "demo", knight: undefined, createdAt: 3 }),
      ch({ id: "d", knightId: "Other9999", createdAt: 4, status: "passed" }),
    ];
    const cards = groupKnights(list);
    expect(cards).toHaveLength(3);
    const mine = cards.find((k) => k.key === "KnightAsset1234")!;
    expect(mine.c.id).toBe("b");
    expect(mine.battles).toBe(2);
    expect(summary(cards)).toMatchObject({ knights: 3, active: 2, wounded: 0 });
    expect(matches(mine, "wounded")).toBe(false);
    expect(matches(mine, "all")).toBe(true);
  });
});

describe("tier eligibility", () => {
  it("every tier is open to buy", () => {
    for (const t of ["squire", "knight", "paladin", "ascended"] as const) expect(eligibilityFor(t)).toEqual({ locked: false, pill: { kind: "", text: "Open to all" } });
  });

  it("the fallback scaling table matches the rulebook ladder", () => {
    const t = fallbackScalingTable();
    expect(t[0]!.levels.map((l) => l.size)).toEqual([5_000, 6_666.67, 8_333.33]);
    expect(t[2]!.levels.map((l) => l.size)).toEqual([15_000, 18_333.33, 21_666.67]);
    expect(t[3]!.levels).toHaveLength(16);
    expect(t[3]!.levels[15]!.size).toBe(100_000);
  });
});

describe("level up celebration", () => {
  const rec = (ts: number) => ({ ts, fromTier: "squire", fromLevel: 3, fromSize: 8_333.33, toTier: "knight", toLevel: 1, toSize: 10_000, profit: 420, payouts: 1 });
  it("shows the newest unseen, recent level up only", () => {
    const now = 10 * 86_400_000;
    const c = { id: "f1", scaling: { history: [rec(now - 1000)] } } as unknown as ChallengeState;
    expect(pendingCelebration(c, 0, now)?.toTier).toBe("knight");
    expect(pendingCelebration(c, 1, now)).toBeUndefined();
    expect(pendingCelebration({ ...c, scaling: { history: [rec(0)] } } as unknown as ChallengeState, 0, now)).toBeUndefined();
    expect(pendingCelebration({ id: "x" } as ChallengeState, 0, now)).toBeUndefined();
  });
});

describe("payout helpers", () => {
  const v = (o: Record<string, unknown> = {}) => ({ id: "po_1", challengeId: "ch_1", status: "approved", needsApproval: false, delayed: false, amountUsd: 36, createdAt: 1, ...o }) as unknown as PayoutView;

  it("links devnet transactions on the explorer", () => {
    expect(explorerTxUrl("abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
  });

  it("labels each status in plain words and tells delayed from sending", () => {
    expect(payoutStatusText(v({ status: "paid" })).label).toBe("Paid");
    expect(payoutStatusText(v({ status: "pending_approval", needsApproval: true })).label).toBe("Awaiting approval");
    expect(payoutStatusText(v({ status: "approved" })).label).toBe("Sending");
    expect(payoutStatusText(v({ status: "approved", delayed: true })).label).toBe("Delayed");
    expect(payoutStatusText(v({ status: "rejected" })).tone).toBe("dn");
    expect(payoutStatusText(v({ status: "failed" })).hint).toMatch(/held, not lost/);
  });

  it("finds the open payout for an account and totals only settled ones", () => {
    const list = [v({ id: "a", status: "paid", amountUsd: 40 }), v({ id: "b", status: "rejected", amountUsd: 99 }), v({ id: "c", status: "pending_approval", createdAt: 5 }), v({ id: "d", status: "paid", amountUsd: 2.5, challengeId: "ch_2" })];
    expect(openPayout(list, "ch_1")?.id).toBe("c");
    expect(openPayout(list, "ch_2")).toBeUndefined();
    expect(isOpenPayout(list[0]!)).toBe(false);
    expect(totalPaid(list)).toBeCloseTo(42.5);
  });

  it("explains why a payout is not available", () => {
    expect(notEligibleText({ eligible: true }, 20)).toBe("");
    expect(notEligibleText(undefined, 20)).toBe("");
    expect(notEligibleText({ eligible: false, reason: "open_positions" }, 20)).toMatch(/Close all open positions/);
    expect(notEligibleText({ eligible: false, reason: "below_minimum" }, 20)).toMatch(/\$20 minimum/);
    expect(notEligibleText({ eligible: false, reason: "no_profit" }, 20)).toMatch(/No profit/);
  });
});
