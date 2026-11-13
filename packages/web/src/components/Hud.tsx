import { Fragment } from "react";
import type { ChallengeState } from "../lib/types";
import { hms, msToUtcReset, num, pct, usd } from "../lib/format";
import { Bar } from "./Art";
import { useNow } from "../lib/hooks";

function Tile({ label, big, of, rows, pctUsed, color, note }: { label: string; big: string; of?: string; rows: [string, React.ReactNode][]; pctUsed: number; color: string; note: string }) {
  return (
    <div className="hud">
      <div className="lbl">{label}</div>
      <div className="hud-big">
        {big}
        {of && <small> / {of}</small>}
      </div>
      <Bar pct={pctUsed} color={color} h={8} />
      <div className="acc-grid">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </Fragment>
        ))}
      </div>
      <div className="note">{note}</div>
    </div>
  );
}

/** Funded scaling progress: the flat rule is 5% profit of the current size plus one paid payout since the last level up. */
export function ScalingTile({ s }: { s: NonNullable<ChallengeState["scaling"]> }) {
  const profitPct = s.profitTarget > 0 ? Math.min(1, Math.max(0, s.profitSinceLevel) / s.profitTarget) : 1;
  const payPct = s.payoutsNeeded > 0 ? Math.min(1, s.payoutsSinceLevel / s.payoutsNeeded) : 1;
  const note = s.atCap
    ? "Top level reached"
    : s.capHeld
      ? "Level up held by the funded account cap"
      : s.eligible && s.waitingForFlat
        ? "Ready: applies when you are flat"
        : s.next?.graduates
          ? `Next: graduate to ${s.next.label}`
          : `Next: ${s.next?.label ?? ""}`;
  return (
    <div className="hud" data-testid="scaling-tile">
      <div className="lbl">Level up · {s.label}</div>
      <div className="hud-big">{usd(s.size, s.size % 1 ? 2 : 0)}</div>
      <Bar pct={((profitPct + payPct) / 2) * 100} color="var(--fire)" h={8} />
      <div className="acc-grid">
        <span>Profit</span>
        <b className={s.profitMet ? "up" : undefined} data-testid="scaling-profit">
          {usd(Math.max(0, s.profitSinceLevel))} / {usd(s.profitTarget)}
        </b>
        <span>Payouts</span>
        <b className={s.payoutsMet ? "up" : undefined} data-testid="scaling-payouts">
          {s.payoutsSinceLevel} / {s.payoutsNeeded}
        </b>
        <span>Next size</span>
        <b data-testid="scaling-next">{s.next ? usd(s.next.size, s.next.size % 1 ? 2 : 0) : "Max"}</b>
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
        <Tile label="Profit target (closed)" big={usd(Math.max(0, r.balance - r.startingBalance))} of={usd(target)} pctUsed={(r.targetProgressPct ?? 0) * 100} color="var(--fire)" rows={[["Closed balance", usd(r.balance)], ["Progress", <span className={r.balance >= r.startingBalance ? "up" : "dn"}>{pct(r.targetProgressPct ?? 0)}</span>]]} note="Only closed trades count" />
      ) : (
        c.scaling ? (
          <ScalingTile s={c.scaling} />
        ) : (
          <Tile label="Profit (cycle)" big={usd(r.profitLoss)} pctUsed={0} color="var(--fire)" rows={[["Equity", usd(r.equity)], ["Your split", "80%"]]} note="Funded: no target, keep the buffers" />
        )
      )}
      <Tile label="Daily loss" big={usd(dailyUsed)} of={usd(r.dailyLossLimit)} pctUsed={dailyUsedPct * 100} color="var(--violet)" rows={[["Buffer", usd(Math.max(0, r.dailyRemaining))], ["Used", pct(dailyUsedPct, 0)]]} note={`Knight HP · resets in ${hms(reset)}`} />
      <Tile label="Max drawdown" big={usd(ddUsed)} of={usd(ddLimit)} pctUsed={ddUsedPct * 100} color="var(--violet2)" rows={[["Buffer", usd(Math.max(0, ddLimit - ddUsed))], ["Used", pct(ddUsedPct, 0)]]} note={`Armor · static from ${usd(r.startingBalance)}`} />
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
