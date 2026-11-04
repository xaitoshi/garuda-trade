import type { RiskEvent } from "./monitor.js";

export type CombatKind = "strike" | "scorch" | "advance" | "warning" | "breach" | "pass" | "dawn" | "tribute";

export interface CombatLogEntry {
  ts: number;
  kind: CombatKind;
  text: string;
  /** Signed USD for strike / scorch entries. */
  amount?: number;
}

/** Minimal fill shape so this package does not depend on sim-engine. */
export interface FillLike {
  orderId?: string;
  ts: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  realizedPnl: number;
  closedSize: number;
  closedDirection?: "long" | "short";
  forced?: boolean;
}

export function usd(n: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(n);
  const digits = abs >= 10 ? 0 : 2;
  const body = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = n < 0 ? "-" : opts.sign ? "+" : "";
  return `${sign}$${body}`;
}

function fmtPrice(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toFixed(4);
}

function fmtSize(s: number): string {
  return Number(s.toPrecision(6)).toString();
}

const STRIKES = ["pokes", "strikes", "lands a heavy blow", "unleashes a mighty blow"] as const;
const SCORCHES = ["is singed", "is scorched", "is badly burned", "is engulfed in flame"] as const;

/** Intensity tier from PnL as a share of the starting balance. */
function tier(pct: number): 0 | 1 | 2 | 3 {
  const a = Math.abs(pct);
  if (a < 0.001) return 0;
  if (a < 0.02) return 1;
  if (a < 0.04) return 2;
  return 3;
}

export interface CombatContext {
  knight: string;
  startingBalance: number;
}

/**
 * Turn a fill into combat-log text. Only fills that close exposure are "strikes" (profit) or
 * "scorches" (loss); opening fills are "advance" lines.
 * Example: "Sir Pudding strikes for +$312 (SOL long closed)".
 */
export function fillToCombat(ctx: CombatContext, fill: FillLike): CombatLogEntry {
  const label = `${fill.symbol} ${fill.closedDirection ?? (fill.side === "buy" ? "long" : "short")}`;
  if (fill.closedSize > 0) {
    const net = fill.realizedPnl - fill.fee;
    const t = tier(net / ctx.startingBalance);
    const forced = fill.forced ? ", forced exit" : "";
    if (net >= 0) {
      return { ts: fill.ts, kind: "strike", amount: net, text: `${ctx.knight} ${STRIKES[t]} for ${usd(net, { sign: true })} (${label} closed${forced})` };
    }
    return { ts: fill.ts, kind: "scorch", amount: net, text: `${ctx.knight} ${SCORCHES[t]} for ${usd(net)} (${label} closed${forced})` };
  }
  const verb = fill.side === "buy" ? "charges long" : "dives short";
  return {
    ts: fill.ts,
    kind: "advance",
    amount: -fill.fee,
    text: `${ctx.knight} ${verb}: ${fmtSize(fill.size)} ${fill.symbol} @ ${fmtPrice(fill.price)} (fee ${usd(fill.fee)})`,
  };
}

/**
 * Aggregate fills by order so a market order that walks 8 book levels is ONE combat-log line.
 * An order that flips a position yields a closing line (strike / scorch) and an opening line.
 */
export function fillsToCombat(ctx: CombatContext, fills: FillLike[]): CombatLogEntry[] {
  const groups = new Map<string, FillLike[]>();
  fills.forEach((f, i) => {
    const key = f.orderId ?? `__${i}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  });
  const out: CombatLogEntry[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    let size = 0;
    let notional = 0;
    let fee = 0;
    let realized = 0;
    let closed = 0;
    for (const f of g) {
      size += f.size;
      notional += f.price * f.size;
      fee += f.fee;
      realized += f.realizedPnl;
      closed += f.closedSize;
    }
    const avg = notional / size;
    const base: FillLike = { ...first, ts: g[g.length - 1]!.ts, price: avg, forced: g.some((f) => f.forced) };
    if (closed > 0) {
      const share = closed / size;
      out.push(fillToCombat(ctx, { ...base, size: closed, fee: fee * share, realizedPnl: realized, closedSize: closed, closedDirection: first.closedDirection }));
    }
    const opened = size - closed;
    if (opened > 1e-12) {
      out.push(fillToCombat(ctx, { ...base, size: opened, fee: fee * (opened / size), realizedPnl: 0, closedSize: 0, closedDirection: undefined }));
    }
  }
  return out;
}

const RULE_NAME = { daily_loss: "Daily Loss", max_drawdown: "Max Drawdown" } as const;

/** Turn a risk event into combat-log text. */
export function riskEventToCombat(ctx: CombatContext, ev: RiskEvent): CombatLogEntry {
  switch (ev.type) {
    case "warning": {
      const pct = Math.round(ev.level * 100);
      const bar = ev.rule === "daily_loss" ? "HP" : "armor";
      return {
        ts: ev.ts,
        kind: "warning",
        text: `${ctx.knight}'s ${bar} is at ${100 - pct}%: ${pct}% of the ${RULE_NAME[ev.rule]} buffer is gone, ${usd(ev.remaining)} left before the line`,
      };
    }
    case "breach":
      return {
        ts: ev.ts,
        kind: "breach",
        text: `${ctx.knight} falls, Wounded! ${RULE_NAME[ev.rule]} limit breached at equity ${usd(ev.equity)} (limit ${usd(ev.floor)}). Revive to ride again`,
      };
    case "pass":
      return {
        ts: ev.ts,
        kind: "pass",
        text: `${ctx.knight} slays the boss! Equity ${usd(ev.equity)} reached the ${usd(ev.targetEquity)} target. Challenge PASSED`,
      };
    case "day_reset":
      return {
        ts: ev.ts,
        kind: "dawn",
        text: `A new day dawns for ${ctx.knight}: HP restored, daily limit ${usd(ev.dailyLossLimit)} (floor ${usd(ev.dailyFloor)})`,
      };
  }
}
