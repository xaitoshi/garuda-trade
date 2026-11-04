import type { BreachSeries } from "../lib/breach";
import { clock, usd } from "../lib/format";

/** Inline SVG equity line with the breach floor and the breach point (mock 05). */
export function BreachChart({ s, W = 800, H = 250 }: { s: BreachSeries; W?: number; H?: number }) {
  const L = 10, R = 74, T = 14, B = 26;
  const t0 = s.points[0]!.ts;
  const t1 = s.points[s.points.length - 1]!.ts;
  const X = (ts: number) => L + ((ts - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const Y = (v: number) => T + ((s.hi - v) / (s.hi - s.lo)) * (H - T - B);
  const line = s.points.map((p) => `${X(p.ts).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const area = `${X(t0).toFixed(1)},${H - B} ${line} ${X(t1).toFixed(1)},${H - B}`;
  const fy = Y(s.floor);
  const bx = X(t1);
  const by = Y(s.equity);
  const step = (s.hi - s.lo) / 4;
  const grid = [0, 1, 2, 3, 4].map((i) => s.lo + step * i).filter((v) => Math.abs(Y(v) - fy) > 14);
  const ticks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3);
  const tipW = 130;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label={`Equity fell to ${usd(s.equity)} against a floor of ${usd(s.floor)}`} data-testid="breach-chart">
      <defs>
        <linearGradient id="eqa" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#bbb4fb" stopOpacity=".25" />
          <stop offset="1" stopColor="#bbb4fb" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="#242122" />
          <text x={W - R + 8} y={Y(v) + 4} className="ax">{usd(v)}</text>
        </g>
      ))}
      {ticks.map((t, i) => (
        <text key={i} x={X(t)} y={H - 6} className="ax" textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>{clock(t)}</text>
      ))}
      <polygon points={area} fill="url(#eqa)" />
      <polyline points={line} fill="none" stroke="#bbb4fb" strokeWidth="2" strokeLinejoin="round" />
      <line x1={L} x2={W - R} y1={fy} y2={fy} stroke="#ff5f6d" strokeDasharray="6 5" />
      <text x={W - R + 8} y={fy + 4} className="ax" fill="#ff5f6d">{usd(s.floor)}</text>
      <rect x={L + 8} y={fy + 8} width={230} height={22} rx={6} fill="#2a1316" stroke="#ff5f6d" strokeOpacity=".5" />
      <text x={L + 18} y={fy + 23} className="ax" fill="#ff5f6d">{s.rule === "daily_loss" ? "Daily loss floor" : "Drawdown floor"} {usd(s.floor)}</text>
      <circle cx={bx} cy={by} r="12" fill="#ff5f6d" opacity=".25" />
      <circle cx={bx} cy={by} r="5" fill="#ff5f6d" />
      <rect x={bx - tipW - 14} y={by - 52} width={tipW} height={30} rx={8} fill="#161415" stroke="#3b3738" />
      <text x={bx - 14 - tipW / 2} y={by - 33} className="ax" fill="#f2f0f0" textAnchor="middle">{clock(s.breachTs)} · {usd(s.equity)}</text>
    </svg>
  );
}
