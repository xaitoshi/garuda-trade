import { useEffect, useRef, useState } from "react";
import type { ChallengeState } from "../lib/types";
import { artState, bossState, knightView } from "../lib/knight";
import { usd } from "../lib/format";
import { BossImg, KnightImg } from "./Art";

const SEGS = 18;

/** A fighting-game health bar made of dot segments. Segments lost in the last hit break off and fall. */
function SegBar({ pct, lost, side, hitId }: { pct: number; lost: number; side: "k" | "b"; hitId: number }) {
  const lit = Math.max(0, Math.min(SEGS, Math.ceil((pct / 100) * SEGS - 0.001)));
  const was = Math.max(lit, Math.min(SEGS, Math.ceil((lost / 100) * SEGS - 0.001)));
  return (
    <div className={`vs-bar ${side}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: SEGS }, (_, i) => (
        <i key={i < lit ? i : `${i}-${hitId}`} className={i < lit ? "on" : i < was ? "lost" : ""} style={{ ["--n" as string]: i < was ? was - i : 0 }} />
      ))}
    </div>
  );
}

interface Hit { id: number; side: "k" | "b"; amount: number; from: number }

/**
 * Knight vs Phoenix, as a fighting-game VS card. Knight HP is the buffer to the nearer floor (daily loss or max drawdown); the Phoenix's HP is the distance to
 * the profit target (closed balance only). A closed win knocks a chunk off the Phoenix, a closed loss hits the knight.
 * Below 25% the Phoenix is enraged.
 */
export function BattleSlot({ c, symbol }: { c: ChallengeState; symbol: string }) {
  const k = knightView(c);
  const r = c.risk;
  // the knight dies at whichever floor is nearer: the daily loss line or the max drawdown line (equity based)
  const dailyHp = 100 - Math.max(0, Math.min(1, r.dailyUsedPct)) * 100;
  const ddHp = 100 - Math.max(0, Math.min(1, r.drawdownUsedPct)) * 100;
  const ddBinds = r.drawdownRemaining < r.dailyRemaining;
  const kHp = Math.min(dailyHp, ddHp);
  const kLeft = Math.max(0, ddBinds ? r.drawdownRemaining : r.dailyRemaining);
  const hasBoss = r.targetProgressPct !== null;
  const bHp = hasBoss ? Math.max(0, 100 - r.targetProgressPct! * 100) : 0;
  const toGo = hasBoss ? Math.max(0, r.targetEquity! - r.balance) : 0;
  const enraged = hasBoss && bHp > 0 && bHp < 25;
  const defeated = hasBoss && bHp <= 0;
  const kLow = kHp < 25;

  // a closed trade moves the closed balance: that is the blow landing
  const prev = useRef<{ bal: number; k: number; b: number } | null>(null);
  const [hit, setHit] = useState<Hit | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { bal: r.balance, k: kHp, b: bHp };
    if (!p) return;
    const d = r.balance - p.bal;
    if (Math.abs(d) < 0.01) return;
    setHit({ id: Date.now(), side: d > 0 ? "b" : "k", amount: Math.abs(d), from: d > 0 ? p.b : p.k });
  }, [r.balance, kHp, bHp]);
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(null), 1600);
    return () => clearTimeout(t);
  }, [hit]);

  const cls = ["panel", "vs", enraged && "enraged", defeated && "defeated", kLow && "k-low", hit && `hit-${hit.side}`].filter(Boolean).join(" ");
  return (
    <div className={cls} data-testid="battle-slot">
      <div className="vs-side k">
        <div className="vs-por">
          <KnightImg level={k.level} state={artState(c)} fill className="vs-img" />
        </div>
        <div className="vs-info">
          <div className="vs-name" data-testid="knight-title">{k.title}</div>
          <SegBar pct={kHp} lost={hit?.side === "k" ? hit.from : kHp} side="k" hitId={hit?.id ?? 0} />
          <div className="vs-num"><b>{usd(kLeft, 0)}</b><span>{ddBinds ? "to max drawdown" : "daily buffer"}</span></div>
        </div>
        {hit?.side === "k" && <span key={hit.id} className="vs-dmg k">-{usd(hit.amount, hit.amount < 100 ? 2 : 0)}</span>}
      </div>

      <div className="vs-mid" aria-hidden>VS</div>

      <div className="vs-side b">
        <div className="vs-por">
          <BossImg state={bossState(c)} fill className="vs-img" />
          <span className="vs-eyes" aria-hidden />
        </div>
        <div className="vs-info">
          <div className="vs-name">{hasBoss ? (defeated ? "The Phoenix · slain" : enraged ? "The Phoenix · enraged" : "The Phoenix") : "Funded account"}</div>
          <SegBar pct={hasBoss ? bHp : 100} lost={hit?.side === "b" ? hit.from : bHp} side="b" hitId={hit?.id ?? 0} />
          <div className="vs-num">
            <b>{hasBoss ? usd(toGo, 0) : usd(Math.max(0, r.profitLoss), 0)}</b>
            <span>{hasBoss ? (defeated ? "target hit" : "to go") : "profit"}</span>
          </div>
        </div>
        {hit?.side === "b" && <span key={hit.id} className="vs-dmg b">-{usd(hit.amount, hit.amount < 100 ? 2 : 0)}</span>}
      </div>

      <div className="vs-foot">
        <span>Account · {k.label}</span>
        <span>Live · {symbol}-PERP</span>
      </div>
    </div>
  );
}
