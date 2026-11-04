import { describe, expect, it } from "vitest";
import { RiskMonitor, limitsForTier, msUntilNextReset, utcDayKey, type RiskEvent } from "../src/index.js";

const D1 = Date.UTC(2026, 10, 4, 9, 0, 0); // 2026-11-04 09:00 UTC
const knight = () => new RiskMonitor({ limits: limitsForTier("knight"), createdAt: D1 });
const ev = (e: RiskEvent[], t: RiskEvent["type"]) => e.filter((x) => x.type === t);

describe("limits (Knight $25k)", () => {
  it("derives the rulebook floors and target", () => {
    const m = knight();
    expect(m.dailyLossLimit).toBeCloseTo(750, 8);
    expect(m.dailyFloor).toBeCloseTo(24_250, 8);
    expect(m.ddFloor).toBeCloseTo(23_500, 8);
    expect(m.target).toBeCloseTo(27_500, 8);
    expect(m.effectiveFloor).toBeCloseTo(24_250, 8); // daily bites first on day one
  });

  it("tier table matches the rulebook", () => {
    const f = (t: Parameters<typeof limitsForTier>[0]) => {
      const m = new RiskMonitor({ limits: limitsForTier(t), createdAt: D1 });
      return [m.ddFloor, m.target];
    };
    expect(f("demo")).toEqual([4_700, 5_500]);
    expect(f("squire")).toEqual([9_400, 11_000]);
    expect(f("paladin")).toEqual([47_000, 55_000]);
    expect(f("ascended")).toEqual([94_000, 110_000]);
  });
});

describe("daily loss", () => {
  it("breaches on equity (floating loss) at or below the daily floor, no grace", () => {
    const m = knight();
    expect(m.evaluate({ balance: 25_000, equity: 24_250.01, now: D1 })).toEqual([
      expect.objectContaining({ type: "warning", rule: "daily_loss", level: 0.5 }),
      expect.objectContaining({ type: "warning", rule: "daily_loss", level: 0.8 }),
    ]);
    const e = m.evaluate({ balance: 25_000, equity: 24_250, now: D1 + 1000 });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ type: "breach", rule: "daily_loss", floor: 24_250, equity: 24_250 });
    expect(m.status).toBe("wounded");
  });

  it("start-of-day basis is the BALANCE: it rolls at 00:00 UTC from the last evaluated balance", () => {
    const m = knight();
    m.evaluate({ balance: 26_000, equity: 26_000, now: D1 + 3_600_000 }); // banked +1000
    // Next UTC day: limit = 3% of 26,000 = 780, floor 25,220 (rulebook example)
    const next = Date.UTC(2026, 10, 5, 0, 0, 1);
    const e = m.evaluate({ balance: 26_000, equity: 26_000, now: next });
    expect(ev(e, "day_reset")[0]).toMatchObject({ startOfDayBalance: 26_000, dailyLossLimit: 780, dailyFloor: 25_220 });
    expect(m.dailyFloor).toBeCloseTo(25_220, 8);
  });

  it("limit shrinks after a losing day (rulebook: $23,800 balance -> $714 limit, floor $23,086)", () => {
    // Use a Paladin-sized buffer so a 23.8k balance is still alive: construct on $25k with a custom path.
    const m = knight();
    // Day 1: end at 23,800 balance with equity above the 24,250 daily floor? Not possible; breach would occur.
    // Verify the arithmetic through the monitor's own state on a new account that never breached:
    const m2 = new RiskMonitor({ limits: { ...limitsForTier("knight"), startingBalance: 25_000 }, createdAt: D1, restore: { startOfDayBalance: 23_800, lastBalance: 23_800, lastEquity: 23_800 } });
    expect(m2.dailyLossLimit).toBeCloseTo(714, 8);
    expect(m2.dailyFloor).toBeCloseTo(23_086, 8);
    expect(m2.effectiveFloor).toBeCloseTo(23_500, 8); // static DD floor is higher and bites
    expect(m.status).toBe("active");
  });

  it("does not reset within the same UTC day and resets exactly at 00:00", () => {
    const m = knight();
    expect(m.evaluate({ balance: 25_000, equity: 25_000, now: Date.UTC(2026, 10, 4, 23, 59, 59) })).toHaveLength(0);
    const e = m.evaluate({ balance: 25_000, equity: 25_000, now: Date.UTC(2026, 10, 5, 0, 0, 0) });
    expect(ev(e, "day_reset")).toHaveLength(1);
    expect(utcDayKey(Date.UTC(2026, 10, 5, 0, 0, 0))).toBe("2026-11-05");
    expect(msUntilNextReset(Date.UTC(2026, 10, 4, 23, 0, 0))).toBe(3_600_000);
  });

  it("a new day restores the daily buffer and re-arms its warnings", () => {
    const m = knight();
    m.evaluate({ balance: 24_700, equity: 24_600, now: D1 }); // 53% used -> 50% warning
    expect(m.state.warned.daily_loss).toBe(0.5);
    // Next day: balance 24,700 => SOD 24,700, floor 23,959 (but DD floor 23,500 is lower, so 23,959 binds)
    const e = m.evaluate({ balance: 24_700, equity: 24_600, now: Date.UTC(2026, 10, 5, 1, 0, 0) });
    expect(ev(e, "day_reset")).toHaveLength(1);
    expect(ev(e, "warning")).toHaveLength(0); // 13% used of the new buffer
    expect(m.state.warned.daily_loss).toBe(0);
  });

  it("skipped days still roll once, using the last balance", () => {
    const m = knight();
    m.evaluate({ balance: 25_400, equity: 25_400, now: D1 });
    const e = m.evaluate({ balance: 25_400, equity: 25_400, now: Date.UTC(2026, 10, 9, 12, 0, 0) });
    expect(ev(e, "day_reset")).toHaveLength(1);
    expect(m.state.startOfDayBalance).toBe(25_400);
  });
});

describe("static max drawdown", () => {
  it("never trails: the floor stays at $23,500 after the account grows", () => {
    const m = knight();
    m.evaluate({ balance: 27_000, equity: 27_000, now: D1 });
    expect(m.ddFloor).toBe(23_500);
    // next day: daily floor = 27,000*0.97 = 26,190 binds; DD floor still 23,500
    m.evaluate({ balance: 27_000, equity: 27_000, now: Date.UTC(2026, 10, 5, 0, 0, 5) });
    expect(m.ddFloor).toBe(23_500);
    expect(m.effectiveFloor).toBeCloseTo(26_190, 8);
  });

  it("breaches max drawdown when it binds (after losing days)", () => {
    // Account at 24,000 balance at SOD: daily floor 23,280 < DD floor 23,500 => DD binds
    const m = new RiskMonitor({
      limits: limitsForTier("knight"),
      createdAt: D1,
      restore: { startOfDayBalance: 24_000, lastBalance: 24_000, lastEquity: 24_000 },
    });
    const e = m.evaluate({ balance: 24_000, equity: 23_499, now: D1 + 5000 });
    expect(ev(e, "breach")[0]).toMatchObject({ rule: "max_drawdown", floor: 23_500 });
    expect(m.snapshot().breach?.rule).toBe("max_drawdown");
  });

  it("reports both rules when one tick crosses both floors; the higher floor is the binding rule", () => {
    const m = knight();
    const e = m.evaluate({ balance: 25_000, equity: 23_000, now: D1 });
    const b = ev(e, "breach")[0] as Extract<RiskEvent, { type: "breach" }>;
    expect(b.rule).toBe("daily_loss"); // 24,250 > 23,500
    expect(b.alsoBreached).toBe("max_drawdown");
  });
});

describe("buffer warnings (50% / 80%)", () => {
  it("emits 50% then 80% once each as equity falls, never repeats, re-arms on recovery", () => {
    const m = knight();
    // daily buffer is $750: 50% = 375 -> equity 24,625 ; 80% = 600 -> equity 24,400
    expect(m.evaluate({ balance: 25_000, equity: 24_700, now: D1 })).toHaveLength(0);
    const a = m.evaluate({ balance: 25_000, equity: 24_625, now: D1 + 1 });
    expect(a).toEqual([expect.objectContaining({ type: "warning", level: 0.5, rule: "daily_loss", remaining: expect.closeTo(375, 6) })]);
    expect(m.evaluate({ balance: 25_000, equity: 24_600, now: D1 + 2 })).toHaveLength(0); // no repeat
    const b = m.evaluate({ balance: 25_000, equity: 24_400, now: D1 + 3 });
    expect(b).toEqual([expect.objectContaining({ type: "warning", level: 0.8 })]);
    // recover fully, then fall again -> re-warn
    m.evaluate({ balance: 25_000, equity: 25_100, now: D1 + 4 });
    expect(m.state.warned.daily_loss).toBe(0);
    expect(m.evaluate({ balance: 25_000, equity: 24_620, now: D1 + 5 })).toHaveLength(1);
  });

  it("drawdown warnings trigger at 50% / 80% of the $1,500 static buffer", () => {
    const m = new RiskMonitor({
      limits: limitsForTier("knight"),
      createdAt: D1,
      restore: { startOfDayBalance: 24_000, lastBalance: 24_000, lastEquity: 24_000 }, // daily buffer 720 is wider than DD remaining
    });
    // DD used 50% at equity 24,250? start 25,000 - 750 = 24,250; daily floor = 23,280 so daily used = 35%
    const e = m.evaluate({ balance: 24_000, equity: 24_250, now: D1 });
    expect(e).toEqual([expect.objectContaining({ rule: "max_drawdown", level: 0.5 })]);
    const f = m.evaluate({ balance: 24_000, equity: 23_800, now: D1 + 1 }); // DD used 80%
    expect(f).toContainEqual(expect.objectContaining({ rule: "max_drawdown", level: 0.8 }));
  });

  it("a gap straight past 80% reports both levels", () => {
    const m = knight();
    const e = m.evaluate({ balance: 25_000, equity: 24_350, now: D1 });
    expect(e.map((x) => x.type === "warning" && x.level)).toEqual([0.5, 0.8]);
  });
});

describe("profit target / pass", () => {
  it("passes when equity reaches +10% (floating P&L counts), no minimum days", () => {
    const m = knight();
    expect(m.evaluate({ balance: 25_000, equity: 27_499.99, now: D1 })).toHaveLength(0);
    const e = m.evaluate({ balance: 25_000, equity: 27_500, now: D1 + 1 });
    expect(e).toEqual([{ type: "pass", ts: D1 + 1, equity: 27_500, targetEquity: 27_500 }]);
    expect(m.status).toBe("passed");
  });

  it("pass on day one in a single evaluation, state is terminal afterwards", () => {
    const m = knight();
    m.evaluate({ balance: 27_600, equity: 27_600, now: D1 });
    expect(m.evaluate({ balance: 1, equity: 1, now: D1 + 10 })).toHaveLength(0);
    expect(m.status).toBe("passed");
  });

  it("funded stage has no target", () => {
    const m = new RiskMonitor({ limits: limitsForTier("knight", "funded"), createdAt: D1 });
    expect(m.target).toBeNull();
    expect(m.evaluate({ balance: 60_000, equity: 60_000, now: D1 })).toHaveLength(0);
    expect(m.snapshot().targetProgressPct).toBeNull();
  });
});

describe("breach is terminal", () => {
  it("ignores later evaluations once wounded", () => {
    const m = knight();
    m.evaluate({ balance: 25_000, equity: 24_000, now: D1 });
    expect(m.status).toBe("wounded");
    expect(m.evaluate({ balance: 30_000, equity: 30_000, now: D1 + 5 })).toHaveLength(0);
    expect(m.status).toBe("wounded");
  });
});

describe("snapshot (HP / armor / boss bars)", () => {
  it("reports used shares and remaining dollars", () => {
    const m = knight();
    m.evaluate({ balance: 25_000, equity: 24_625, now: D1 });
    const s = m.snapshot();
    expect(s.dailyUsedPct).toBeCloseTo(0.5, 8);
    expect(s.drawdownUsedPct).toBeCloseTo(0.25, 8);
    expect(s.dailyRemaining).toBeCloseTo(375, 8);
    expect(s.drawdownRemaining).toBeCloseTo(1125, 8);
    expect(s.bufferRemaining).toBeCloseTo(375, 8);
    expect(s.targetProgressPct).toBe(0);
    m.evaluate({ balance: 25_000, equity: 26_250, now: D1 + 1 });
    expect(m.snapshot().targetProgressPct).toBeCloseTo(0.5, 8);
  });
});

describe("payout rebase (rulebook section 11: the balance resets after a payout)", () => {
  it("a sweep is not a daily loss: the start-of-day balance drops to the post-payout balance", () => {
    const m = new RiskMonitor({ limits: limitsForTier("knight", "funded"), createdAt: D1 });
    // day 1 closes at a $28,000 balance, day 2 opens from it (floor 27,160)
    m.evaluate({ balance: 28_000, equity: 28_000, now: D1 });
    const day2 = D1 + 24 * 3_600_000;
    expect(m.evaluate({ balance: 28_000, equity: 28_000, now: day2 }).map((e) => e.type)).toEqual(["day_reset"]);
    expect(m.dailyFloor).toBeCloseTo(27_160, 6);
    // WITHOUT a rebase the swept balance would breach on the next evaluation
    const naive = new RiskMonitor({ limits: limitsForTier("knight", "funded"), createdAt: D1, restore: structuredClone(m.state) as never });
    expect(naive.evaluate({ balance: 25_000, equity: 25_000, now: day2 + 1000 }).map((e) => e.type)).toContain("breach");
    // with it, the account lives and its floors are the post-payout ones (static drawdown never moves)
    m.rebaseAfterPayout(25_000, 25_000, day2 + 1000);
    expect(m.state.startOfDayBalance).toBe(25_000);
    expect(m.evaluate({ balance: 25_000, equity: 25_000, now: day2 + 2000 })).toEqual([]);
    expect(m.status).toBe("active");
    expect(m.dailyFloor).toBeCloseTo(24_250, 6);
    expect(m.ddFloor).toBeCloseTo(23_500, 6);
    // and a real loss after the payout still breaches
    expect(m.evaluate({ balance: 24_000, equity: 24_000, now: day2 + 3000 }).map((e) => e.type)).toContain("breach");
  });

  it("never raises the start-of-day balance", () => {
    const m = knight(); // SOD 25,000
    m.rebaseAfterPayout(26_000, 26_000, D1 + 1000);
    expect(m.state.startOfDayBalance).toBe(25_000);
  });
});
