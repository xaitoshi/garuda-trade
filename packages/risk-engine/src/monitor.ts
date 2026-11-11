import { cents, drawdownFloor, targetEquity, type RiskLimits } from "./rules.js";

export type RuleId = "daily_loss" | "max_drawdown";
export type ChallengeStatus = "active" | "passed" | "wounded";

export type RiskEvent =
  | { type: "day_reset"; ts: number; dayKey: string; startOfDayBalance: number; dailyLossLimit: number; dailyFloor: number }
  | {
      type: "warning";
      ts: number;
      rule: RuleId;
      /** 0.5 or 0.8 */
      level: number;
      usedPct: number;
      equity: number;
      floor: number;
      remaining: number;
    }
  | {
      type: "breach";
      ts: number;
      /** Binding rule (the one with the higher floor). */
      rule: RuleId;
      alsoBreached?: RuleId;
      equity: number;
      floor: number;
      dailyFloor: number;
      drawdownFloor: number;
    }
  | { type: "pass"; ts: number; equity: number; targetEquity: number; balance?: number };

export interface RiskSnapshot {
  status: ChallengeStatus;
  ts: number;
  dayKey: string;
  startingBalance: number;
  startOfDayBalance: number;
  balance: number;
  equity: number;
  dailyLossLimit: number;
  dailyFloor: number;
  drawdownFloor: number;
  /** max(dailyFloor, drawdownFloor): the live breach line. */
  effectiveFloor: number;
  /** 0..1+ share of the daily buffer consumed (knight HP bar = 1 - this). */
  dailyUsedPct: number;
  /** 0..1+ share of the static drawdown buffer consumed (armor bar = 1 - this). */
  drawdownUsedPct: number;
  dailyRemaining: number;
  drawdownRemaining: number;
  /** Equity room above the effective floor. */
  bufferRemaining: number;
  /** Target CLOSED balance (Path to Funded rule 1); null in the funded stage. Name kept for API compatibility. */
  targetEquity: number | null;
  /** 0..1 progress of the CLOSED balance to the profit target (boss HP = 1 - this); null in the funded stage. */
  targetProgressPct: number | null;
  profitLoss: number;
  msUntilReset: number;
  breach?: Extract<RiskEvent, { type: "breach" }>;
}

export const EPS = 1e-9;

export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function msUntilNextReset(ts: number): number {
  const d = new Date(ts);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return next - ts;
}

export interface RiskMonitorInit {
  limits: RiskLimits;
  createdAt: number;
  /** Restore support for persisted state. */
  restore?: Partial<RiskMonitorState>;
}

export interface RiskMonitorState {
  status: ChallengeStatus;
  dayKey: string;
  startOfDayBalance: number;
  lastBalance: number;
  lastEquity: number;
  lastTs: number;
  /** Highest warning level already emitted per rule for the current "armed" cycle. */
  warned: Record<RuleId, number>;
  breach?: Extract<RiskEvent, { type: "breach" }>;
}

/**
 * Pure rule evaluator. Feed it (balance, equity, now) every time either changes; it returns the
 * events produced. It does not know about orders, markets or time sources.
 *
 * Rules (Garuda rulebook):
 *  - daily floor  = start-of-day BALANCE x (1 - dailyLossPct); snapshot at 00:00 UTC from the last
 *    evaluated balance; measured against EQUITY.
 *  - static floor = starting balance x (1 - maxDrawdownPct); never moves.
 *  - effective floor = max(daily, static). equity <= effective floor => breach (no grace).
 *  - pass (evaluation only), Path to Funded: CLOSED balance >= target AND flat book AND the caller's soft gates
 *    (minimum trading days, best-day rule) are met. Open profit never passes. Breach is checked first.
 *  - warnings at 50% / 80% of either buffer; re-armed once the buffer recovers below the level.
 */
export class RiskMonitor {
  limits: RiskLimits;
  private s: RiskMonitorState;

  constructor(init: RiskMonitorInit) {
    this.limits = init.limits;
    const start = init.limits.startingBalance;
    this.s = {
      status: "active",
      dayKey: utcDayKey(init.createdAt),
      startOfDayBalance: start,
      lastBalance: start,
      lastEquity: start,
      lastTs: init.createdAt,
      warned: { daily_loss: 0, max_drawdown: 0 },
      ...init.restore,
    };
  }

  get status(): ChallengeStatus {
    return this.s.status;
  }

  get state(): Readonly<RiskMonitorState> {
    return this.s;
  }

  get ddFloor(): number {
    return drawdownFloor(this.limits.startingBalance, this.limits.maxDrawdownPct);
  }

  get dailyLossLimit(): number {
    return cents(this.s.startOfDayBalance * this.limits.dailyLossPct);
  }

  get dailyFloor(): number {
    return this.s.startOfDayBalance - this.dailyLossLimit;
  }

  get effectiveFloor(): number {
    return Math.max(this.dailyFloor, this.ddFloor);
  }

  get target(): number | null {
    return this.limits.profitTargetPct === null
      ? null
      : targetEquity(this.limits.startingBalance, this.limits.profitTargetPct);
  }

  /** Roll the daily snapshot if `ts` is on a new UTC day. Uses the last evaluated balance. */
  private rollDay(ts: number, out: RiskEvent[]): void {
    const key = utcDayKey(ts);
    if (key === this.s.dayKey) return;
    this.s.dayKey = key;
    this.s.startOfDayBalance = this.s.lastBalance;
    // New day = fresh daily buffer: re-arm daily warnings.
    this.s.warned.daily_loss = 0;
    out.push({
      type: "day_reset",
      ts,
      dayKey: key,
      startOfDayBalance: this.s.startOfDayBalance,
      dailyLossLimit: this.dailyLossLimit,
      dailyFloor: this.dailyFloor,
    });
  }

  usedPct(equity: number): { daily: number; drawdown: number } {
    const dBuf = this.dailyLossLimit;
    const ddBuf = this.limits.startingBalance - this.ddFloor;
    return {
      daily: dBuf > 0 ? (this.s.startOfDayBalance - equity) / dBuf : 0,
      drawdown: ddBuf > 0 ? (this.limits.startingBalance - equity) / ddBuf : 0,
    };
  }

  evaluate(input: {
    balance: number;
    equity: number;
    now: number;
    /** No open positions. Default: equity equals balance. */
    flat?: boolean;
    /** Path to Funded soft gates computed from the ledger (minimum trading days and best-day rule). Default true. */
    gatesMet?: boolean;
  }): RiskEvent[] {
    const { balance, equity, now } = input;
    const out: RiskEvent[] = [];
    if (this.s.status !== "active") return out; // terminal

    this.rollDay(now, out);

    // --- breach (checked before pass: a breach can never be undone by a same-tick pass)
    const dailyHit = equity <= this.dailyFloor + EPS;
    const ddHit = equity <= this.ddFloor + EPS;
    if (dailyHit || ddHit) {
      const dailyBinds = this.dailyFloor >= this.ddFloor;
      const rule: RuleId = dailyHit && ddHit ? (dailyBinds ? "daily_loss" : "max_drawdown") : dailyHit ? "daily_loss" : "max_drawdown";
      const ev: Extract<RiskEvent, { type: "breach" }> = {
        type: "breach",
        ts: now,
        rule,
        alsoBreached: dailyHit && ddHit ? (rule === "daily_loss" ? "max_drawdown" : "daily_loss") : undefined,
        equity,
        floor: rule === "daily_loss" ? this.dailyFloor : this.ddFloor,
        dailyFloor: this.dailyFloor,
        drawdownFloor: this.ddFloor,
      };
      this.s.status = "wounded";
      this.s.breach = ev;
      this.record(balance, equity, now);
      out.push(ev);
      return out;
    }

    // --- pass
    const target = this.target;
    const flat = input.flat ?? Math.abs(equity - balance) < 1e-6;
    if (target !== null && balance >= target - EPS && flat && (input.gatesMet ?? true)) {
      this.s.status = "passed";
      this.record(balance, equity, now);
      out.push({ type: "pass", ts: now, equity, targetEquity: target, balance });
      return out;
    }

    // --- warnings with hysteresis
    const used = this.usedPct(equity);
    const buffers: [RuleId, number, number, number][] = [
      ["daily_loss", used.daily, this.dailyFloor, equity - this.dailyFloor],
      ["max_drawdown", used.drawdown, this.ddFloor, equity - this.ddFloor],
    ];
    const levels = [...this.limits.warningLevels].sort((a, b) => a - b);
    for (const [rule, used01, floor, remaining] of buffers) {
      let top = 0;
      for (const l of levels) if (used01 >= l - EPS) top = l;
      const already = this.s.warned[rule];
      if (top > already) {
        // Emit each newly crossed level (a gap straight to 80% still reports 50% then 80%).
        for (const l of levels) {
          if (l > already && l <= top) out.push({ type: "warning", ts: now, rule, level: l, usedPct: used01, equity, floor, remaining });
        }
        this.s.warned[rule] = top;
      } else if (top < already) {
        this.s.warned[rule] = top; // buffer recovered: re-arm
      }
    }

    this.record(balance, equity, now);
    return out;
  }

  /**
   * A payout swept profit out of the balance (rulebook section 11: the balance resets to the starting balance). The
   * sweep is not a trading loss, so the daily-loss baseline must not treat it as one: start-of-day balance drops to the
   * post-payout balance when that is lower. The static drawdown floor never moves. Call after the day has rolled
   * (evaluate first), on a flat book.
   */
  rebaseAfterPayout(balance: number, equity: number, now: number): void {
    this.s.startOfDayBalance = Math.min(this.s.startOfDayBalance, balance);
    this.s.warned = { daily_loss: 0, max_drawdown: 0 };
    this.record(balance, equity, now);
  }

  /**
   * Funded scaling: the account moved to a new level size. The 6% static floor and the 3% daily limit are measured
   * from the NEW size from now on: the starting balance becomes `newSize` and today's start-of-day balance resets to
   * the current balance (the level-up adds the size step to the balance, so it is newSize plus any unswept profit).
   * Warnings re-arm. Call on a flat book.
   */
  rescale(newSize: number, balance: number, equity: number, now: number): void {
    this.limits = { ...this.limits, startingBalance: newSize };
    this.s.startOfDayBalance = balance;
    this.s.warned = { daily_loss: 0, max_drawdown: 0 };
    this.record(balance, equity, now);
  }

  /** Record the latest balance/equity without evaluating rules (used after forced close-outs). Works in any state. */
  syncFinal(balance: number, equity: number, now: number): void {
    this.record(balance, equity, now);
  }

  private record(balance: number, equity: number, now: number): void {
    this.s.lastBalance = balance;
    this.s.lastEquity = equity;
    this.s.lastTs = now;
  }

  snapshot(now: number = this.s.lastTs): RiskSnapshot {
    const equity = this.s.lastEquity;
    const used = this.usedPct(equity);
    const target = this.target;
    const start = this.limits.startingBalance;
    return {
      status: this.s.status,
      ts: now,
      dayKey: this.s.dayKey,
      startingBalance: start,
      startOfDayBalance: this.s.startOfDayBalance,
      balance: this.s.lastBalance,
      equity,
      dailyLossLimit: this.dailyLossLimit,
      dailyFloor: this.dailyFloor,
      drawdownFloor: this.ddFloor,
      effectiveFloor: this.effectiveFloor,
      dailyUsedPct: used.daily,
      drawdownUsedPct: used.drawdown,
      dailyRemaining: equity - this.dailyFloor,
      drawdownRemaining: equity - this.ddFloor,
      bufferRemaining: equity - this.effectiveFloor,
      targetEquity: target,
      targetProgressPct: target === null ? null : Math.max(0, Math.min(1, (this.s.lastBalance - start) / (target - start))),
      profitLoss: equity - start,
      msUntilReset: msUntilNextReset(now),
      breach: this.s.breach,
    };
  }
}
