import type { ArtState, KnightLevel, BossState } from "../lib/knight";
import { bossSrc, knightSrc } from "../lib/knight";

export function KnightImg({ level, state = "active", size = 120, className = "", alt }: { level: KnightLevel; state?: ArtState; size?: number; className?: string; alt?: string }) {
  return <img className={`knight ${className}`} src={knightSrc(level, state)} width={size} height={size} alt={alt ?? `Level ${level} knight, ${state}`} draggable={false} />;
}

export function BossImg({ state = "full", size = 160, className = "" }: { state?: BossState; size?: number; className?: string }) {
  return <img className={`boss ${className}`} src={bossSrc(state)} width={size} height={size} alt={`The Phoenix, ${state}`} draggable={false} />;
}

export function Bar({ pct, color, h = 8 }: { pct: number; color: string; h?: number }) {
  return (
    <div className="bar" style={{ height: h }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  );
}

export const Logo = ({ h = 26 }: { h?: number }) => <img src="/logo-white.svg" alt="" height={h} style={{ height: h, width: "auto" }} />;

export const Spark = ({ color = "#bbb4fb", size = 24, style }: { color?: string; size?: number; style?: React.CSSProperties }) => (
  <svg style={style} width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
    <path d="M12 1l2 8 8 3-8 3-2 8-2-8-8-3 8-3z" />
  </svg>
);

export const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
    <path d="M4 12l5 5L20 6" />
  </svg>
);

export const Lock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);
