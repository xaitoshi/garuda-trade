import type { ChallengeState } from "./types";

export interface BreachSeries {
  points: { ts: number; value: number }[];
  floor: number;
  /** Axis range, padded so the floor and the breach point sit inside. */
  lo: number;
  hi: number;
  rule: "daily_loss" | "max_drawdown";
  breachTs: number;
  equity: number;
}

export const RULE_LABEL = { daily_loss: "3% daily loss", max_drawdown: "6% max drawdown" } as const;
export const RULE_CHIP = { daily_loss: "Daily loss limit", max_drawdown: "Max drawdown limit" } as const;

/**
 * "What broke": realised balance after each fill, then the equity at the breach. The API keeps no equity history, so this
 * is rebuilt from fills (fees and realised PnL), which is exact for the realised part and shows the breach point on top.
 */
export function buildBreachSeries(c: Pick<ChallengeState, "recentFills" | "risk" | "account">): BreachSeries | undefined {
  const b = c.risk.breach;
  if (!b) return undefined;
  const start = c.risk.startingBalance;
  const fills = [...c.recentFills].filter((f) => f.ts <= b.ts).sort((a, z) => a.ts - z.ts);
  const pts: { ts: number; value: number }[] = [];
  let bal = start;
  const first = fills[0]?.ts ?? b.ts - 3_600_000;
  pts.push({ ts: first - 60_000, value: start });
  for (const f of fills) {
    bal += f.realizedPnl - f.fee;
    pts.push({ ts: f.ts, value: bal });
  }
  if (pts[pts.length - 1]!.ts < b.ts) pts.push({ ts: b.ts, value: b.equity });
  else pts[pts.length - 1] = { ts: b.ts, value: b.equity };
  const values = pts.map((p) => p.value).concat(b.floor, start);
  const span = Math.max(...values) - Math.min(...values) || start * 0.02;
  return { points: pts, floor: b.floor, lo: Math.min(...values) - span * 0.12, hi: Math.max(...values) + span * 0.12, rule: b.rule, breachTs: b.ts, equity: b.equity };
}
