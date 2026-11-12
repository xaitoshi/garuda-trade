import type { ArtState, KnightLevel, BossState } from "../lib/knight";
import { knightCardSrc, knightSrc } from "../lib/knight";

export function KnightImg({ level, state = "active", size = 120, className = "", alt, fill, variant }: { level: KnightLevel; state?: ArtState; size?: number; className?: string; alt?: string; fill?: boolean; variant?: "card" | "square" }) {
  const src = variant === "card" ? knightCardSrc(level) : knightSrc(level, state);
  const cls = `knight knight-${state}${fill ? " knight-fill" : ""} ${className}`.trim();
  const label = alt ?? `Level ${level} knight, ${state}`;
  if (fill) return <img className={cls} src={src} alt={label} draggable={false} />;
  return <img className={cls} src={src} width={size} height={size} alt={label} draggable={false} />;
}

/** Phoenix art. Default is the geometric mark (Revive, Ascension). `fill` is the dotted illustration, used on the terminal battle card. */
export function BossImg({ state = "full", size = 160, className = "", fill, alt }: { state?: BossState; size?: number; className?: string; fill?: boolean; alt?: string }) {
  const label = alt ?? `The Phoenix, ${state}`;
  if (fill) {
    return (
      <div className={`boss-bleed boss-${state} ${className}`.trim()} role="img" aria-label={label}>
        <picture>
          <source type="image/webp" srcSet="/art/phoenix/dotted.webp" />
          <img src="/art/phoenix/dotted.png" alt="" draggable={false} />
        </picture>
      </div>
    );
  }
  return (
    <div className={`boss-mark boss-${state} ${className}`} style={{ width: size, height: size }} role="img" aria-label={label}>
      <span className="boss-ring" aria-hidden />
      <span className="boss-core" aria-hidden />
      <span className="boss-label">{state === "defeated" ? "Fallen" : "Phoenix"}</span>
    </div>
  );
}

export function Bar({ pct, color, h = 8 }: { pct: number; color: string; h?: number }) {
  return (
    <div className="bar" style={{ height: h }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  );
}

/** The dotted Halftone mark: its pieces strike into place on load, then a glint crosses it every few seconds. */
export const Logo = ({ h = 26 }: { h?: number }) => <img src="/brand/garuda-mark.svg" alt="" height={h} style={{ height: h, width: "auto" }} />;

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
