import { describe, expect, it } from "vitest";
import { breachPrice, estSlippagePct, roundSize, sizeForPct, sizeStep, walkBook, applyTick } from "../src/lib/trade";
import { clamp, hms, msToUtcReset, pct, pctSigned, shortAddr, usd, usdSigned } from "../src/lib/format";
import { artState, displayName, knightView, tierOfLevel, uiStatus } from "../src/lib/knight";
import { buildBreachSeries } from "../src/lib/breach";
import { groupKnights, matches, summary } from "../src/lib/barracks";
import { bestKnight, eligibilityFor } from "../src/lib/eligibility";
import type { ChallengeState, KnightInfo, MarketView, Position } from "../src/lib/types";

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
    expect(knightView(ch({ tier: "squire" })).title).toBe("Sir Pudding · LV.1");
    expect(knightView(ch({ tier: "knight" })).label).toBe("LV.2 Knight");
    expect(displayName(undefined, true)).toBe("Demo recruit");
    expect(displayName("Sir Unnamed")).toBe("Sir Unnamed");
    expect(tierOfLevel(9)).toBe("ascended");
  });

  it("maps a challenge to one status chip and one PNG state", () => {
    expect(uiStatus(ch({ status: "wounded" }))).toBe("wounded");
    expect(uiStatus(ch({ status: "passed" }))).toBe("passed");
    expect(uiStatus(ch({ stage: "funded" }))).toBe("funded");
    expect(uiStatus(ch({ stage: "funded", tier: "ascended" }))).toBe("ascended");
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
  const knights = (o: Partial<KnightInfo>): KnightInfo[] => [{ asset: "A1", owner: "w", name: "k", level: "knight", status: "idle", tier: "knight", wins: 1, revives: 0, frozen: false, genuine: true, ...o } as KnightInfo];

  it("uses onchain knights when the chain is on: not wounded, not busy, genuine", () => {
    expect(bestKnight(knights({}), [])).toEqual({ level: 2, asset: "A1" });
    expect(bestKnight(knights({ status: "wounded" }), []).level).toBe(0);
    expect(bestKnight(knights({ status: "active" }), []).level).toBe(0);
    expect(bestKnight(knights({ genuine: false }), []).level).toBe(0);
  });

  it("without a chain it infers from the player's own passed accounts", () => {
    expect(bestKnight(null, []).level).toBe(0);
    expect(bestKnight(null, [ch({ tier: "squire", status: "passed" })]).level).toBe(2);
    expect(bestKnight(null, [ch({ tier: "knight", status: "wounded" })]).level).toBe(0);
    expect(bestKnight(null, [ch({ tier: "demo", demo: true, status: "passed" })]).level).toBe(0);
  });

  it("locks Paladin until a Knight-level knight is held, and says why", () => {
    const locked = eligibilityFor("paladin", "knight", { level: 1 });
    expect(locked.locked).toBe(true);
    expect(locked.pill.text).toBe("Needs Knight NFT");
    const open = eligibilityFor("paladin", "knight", { level: 2, asset: "A1" });
    expect(open).toMatchObject({ locked: false, asset: "A1" });
    expect(eligibilityFor("squire", undefined, { level: 0 }).pill.text).toBe("Open to all");
  });
});
