import type { ChallengeState } from "../lib/types";
import { bossState, knightView } from "../lib/knight";
import { hms, msToUtcReset, num, pct, usd } from "../lib/format";
import { Bar, BossImg, KnightImg } from "./Art";
import { artState } from "../lib/knight";
import { useNow } from "../lib/hooks";

/** Knight vs Phoenix scene with the two HP bars: knight HP = daily buffer, boss HP = distance to the profit target. */
export function BattleSlot({ c, symbol }: { c: ChallengeState; symbol: string }) {
  const k = knightView(c);
  const r = c.risk;
  const dailyLeft = 100 - Math.max(0, r.dailyUsedPct) * 100;
  const hasBoss = r.targetProgressPct !== null;
  const bossHp = hasBoss ? 100 - r.targetProgressPct! * 100 : 100;
  const toGo = hasBoss ? Math.max(0, r.targetEquity! - r.equity) : 0;
  return (
    <div className="panel slot dots" data-testid="battle-slot">
      <div className="slot-hp">
        <div className="hp">
          <div className="row">
            <span className="mute" data-testid="knight-title">
              {k.title}
            </span>
          </div>
          <Bar pct={dailyLeft} color="var(--violet)" h={9} />
          <div className="row" style={{ margin: "6px 0 0" }}>
            <span className="dim">Daily buffer</span>
            <b>{usd(Math.max(0, r.dailyRemaining))} left</b>
          </div>
        </div>
        <div className="hp r">
          <div className="row">
            <span className="mute">{hasBoss ? "The Phoenix" : "Funded account"}</span>
          </div>
          <Bar pct={bossHp} color="var(--fire)" h={9} />
          <div className="row" style={{ margin: "6px 0 0" }}>
            <b>{hasBoss ? `${usd(toGo)} to go` : `${usd(Math.max(0, r.profitLoss))} profit`}</b>
            <span className="dim">{hasBoss ? `Boss HP ${Math.round(bossHp)}%` : "no target"}</span>
          </div>
        </div>
      </div>
      <div className="scene">
        <div className="slab a" />
        <div className="slab b" />
        <KnightImg level={k.level} state={artState(c)} size={150} className="sc-k" />
        <svg className="bolt" width="26" height="26" viewBox="0 0 24 24" fill="#ffc24a" aria-hidden>
          <path d="M13 1L4 14h6l-1 9 10-14h-6z" />
        </svg>
        <BossImg state={bossState(c)} size={190} className="sc-b" />
      </div>
      <span className="slot-tag a">Account · {k.label}</span>
      <span className="slot-tag b">Live · {symbol}-PERP</span>
    </div>
  );
}

function Tile({ label, big, of, left, right, pctUsed, color, note }: { label: string; big: string; of?: string; left: React.ReactNode; right: React.ReactNode; pctUsed: number; color: string; note: string }) {
  return (
    <div className="hud">
      <div className="lbl">{label}</div>
      <div className="hud-big">
        {big}
        {of && <small> / {of}</small>}
      </div>
      <Bar pct={pctUsed} color={color} h={8} />
      <div className="hud-sub">
        <span>{left}</span>
        <span>{right}</span>
      </div>
      <div className="note">{note}</div>
    </div>
  );
}

export function HudTiles({ c }: { c: ChallengeState }) {
  const r = c.risk;
  const now = useNow(1000);
  const reset = msToUtcReset(now);
  const target = r.targetEquity !== null ? r.targetEquity - r.startingBalance : null;
  const ddLimit = r.startingBalance - r.drawdownFloor;
  // Used is negative while equity is above the line it is measured from: show 0 used, not a negative number.
  const ddUsedPct = Math.max(0, r.drawdownUsedPct);
  const dailyUsedPct = Math.max(0, r.dailyUsedPct);
  const ddUsed = ddUsedPct * ddLimit;
  const dailyUsed = dailyUsedPct * r.dailyLossLimit;
  return (
    <div className="hudrow" data-testid="hud">
      {target !== null ? (
        <Tile label="Profit target" big={usd(Math.max(0, r.profitLoss))} of={usd(target)} pctUsed={(r.targetProgressPct ?? 0) * 100} color="var(--fire)" left={<>Equity <b>{usd(r.equity)}</b></>} right={<b className={r.profitLoss >= 0 ? "up" : "dn"}>{pct(r.targetProgressPct ?? 0)}</b>} note="Boss HP = distance to target" />
      ) : (
        <Tile label="Profit (cycle)" big={usd(r.profitLoss)} pctUsed={0} color="var(--fire)" left={<>Equity <b>{usd(r.equity)}</b></>} right={<b>80% yours</b>} note="Funded: no target, keep the buffers" />
      )}
      <Tile label="Daily loss" big={usd(dailyUsed)} of={usd(r.dailyLossLimit)} pctUsed={dailyUsedPct * 100} color="var(--violet)" left={<>Buffer <b>{usd(Math.max(0, r.dailyRemaining))}</b></>} right={<b>{pct(dailyUsedPct, 0)}</b>} note={`Knight HP · resets in ${hms(reset)}`} />
      <Tile label="Max drawdown" big={usd(ddUsed)} of={usd(ddLimit)} pctUsed={ddUsedPct * 100} color="var(--violet2)" left={<>Buffer <b>{usd(Math.max(0, ddLimit - ddUsed))}</b></>} right={<b>{pct(ddUsedPct, 0)}</b>} note={`Armor · static from ${usd(r.startingBalance)}`} />
      <div className="hud">
        <div className="lbl">Account</div>
        <div className="hud-big">{usd(c.account.balance)}</div>
        <div className="acc-grid">
          <span>Equity</span>
          <b>{usd(c.account.equity, 2)}</b>
          <span>Unrealised</span>
          <b className={c.account.unrealizedPnl >= 0 ? "up" : "dn"}>{c.account.unrealizedPnl >= 0 ? "+" : ""}{usd(c.account.unrealizedPnl, 2)}</b>
          <span>Fees paid</span>
          <b>{usd(c.account.feesPaid, 2)}</b>
          <span>Leverage</span>
          <b>{num(c.account.effectiveLeverage, 2)}x</b>
        </div>
        <div className="note">Day {r.dayKey} · UTC reset 00:00</div>
      </div>
    </div>
  );
}
