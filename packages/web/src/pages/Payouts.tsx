import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { knightView, artState } from "../lib/knight";
import { num, pct, usd, usdSigned } from "../lib/format";
import { Gate } from "../components/Gate";
import { KnightImg } from "../components/Art";

export function Payouts() {
  return (
    <Gate note="Payouts are tied to your funded accounts. Sign in to see them.">
      <PayoutsView />
    </Gate>
  );
}

const SAMPLE_BARS = [41, 55, 38, 62, 70, 52, 80, 66, 90, 74, 100, 86];

function PayoutsView() {
  const { rules } = useSession();
  const list = usePoll(() => api.challenges(), 10_000, "payouts-list");
  const funded = (list.data ?? []).filter((c) => c.stage === "funded").sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  const quote = usePoll(() => (funded ? api.payoutQuote(funded.id) : Promise.resolve(null)), 10_000, funded?.id ?? "none");
  const q = quote.data;
  const split = rules?.common.profitSplit ?? 0.8;
  const min = rules?.common.minPayoutUsd ?? 20;

  return (
    <main className="pg-payouts" data-testid="payouts">
      <div className="banner" role="note">
        <b>Payouts are not live yet.</b> Withdrawals need identity checks (M7) and the payout rail (M8), neither is built. This page is read-only: it shows what you would be owed under the rules, nothing moves.
      </div>
      <div className="hdr">
        <div>
          <div className="eyebrow">Funded</div>
          <h1 className="pt" style={{ fontSize: 48 }}>Payouts</h1>
        </div>
      </div>
      <div className="tp7">
        <div className="panel acct">
          <div className="ph" style={{ padding: "0 0 12px", border: 0 }}>
            <b>Funded account</b>
            {funded ? <span className="st funded">Funded</span> : <span className="st dormant">None</span>}
          </div>
          {funded ? (
            <>
              <div className="kn"><KnightImg level={knightView(funded).level} state={artState(funded)} size={170} /></div>
              <div style={{ textAlign: "center", margin: "6px 0 16px" }}>
                <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.03em" }}>{knightView(funded).name}</div>
                <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>{knightView(funded).label.toUpperCase()} · #{funded.id.slice(-4).toUpperCase()}</div>
              </div>
              <div className="kr"><span>Account size</span><b>{usd(funded.risk.startingBalance)}</b></div>
              <div className="kr"><span>Balance</span><b>{usd(funded.risk.balance)}</b></div>
              <div className="kr"><span>Profit to date</span><b className={funded.risk.profitLoss >= 0 ? "up" : "dn"}>{usdSigned(funded.risk.profitLoss)}</b></div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <KnightImg level={1} state="dormant" size={120} />
              <p className="mute" style={{ margin: "14px 0 18px" }}>You have no funded account. Pass an evaluation and claim it from the Ascension screen.</p>
              <Link to="/challenges" className="btn btn-ghost btn-sm">See challenges</Link>
            </div>
          )}
        </div>
        <div className="panel pay">
          <div className="lbl">Would be owed (read-only)</div>
          <div className="big" data-testid="owed">{q ? usd(q.traderShare) : "$0"}<span>USDC</span></div>
          <div className="split"><i style={{ width: `${split * 100}%` }} /><i style={{ width: `${(1 - split) * 100}%` }} /></div>
          <div className="sl"><span><b className="fire">{pct(split, 0)}</b> You</span><span>Garuda <b>{pct(1 - split, 0)}</b></span></div>
          <div className="brk">
            <div><span>Profit this cycle</span><b>{q ? usd(q.grossProfit, 2) : "$0.00"}</b></div>
            <div><span>Your {pct(split, 0)} share</span><b className="up">{q ? usd(q.traderShare, 2) : "$0.00"}</b></div>
            <div><span>Garuda {pct(1 - split, 0)}</span><b>{q ? usd(q.firmShare, 2) : "$0.00"}</b></div>
          </div>
          <div className="req">
            <div className="inp off"><span>{q ? num(q.traderShare, 2) : "0.00"}</span><small>MAX</small></div>
            <button className="btn btn-fire" style={{ padding: "0 34px", fontSize: 16 }} disabled data-testid="request-payout">Request payout</button>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 12, fontFamily: "GM, monospace" }}>
            {q && !q.eligible ? `Not eligible: ${q.reason ?? "no profit yet"}.` : `Minimum payout ${usd(min)}. Disabled until M7 and M8 ship.`}
          </div>
          {Boolean(quote.error) && funded && <div className="dn note" style={{ marginTop: 6 }}>{errorText(quote.error)}</div>}
        </div>
        <div className="panel tre">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="lbl">Garuda treasury</div>
            <span className="tg">Placeholder</span>
          </div>
          <div className="v">-</div>
          <div className="bars" aria-hidden style={{ opacity: 0.35 }}>{SAMPLE_BARS.map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div>
          <div className="sl" style={{ marginBottom: 18 }}><span>Weekly payouts</span><span>sample shape</span></div>
          <div className="kr"><span>Total paid out</span><b>$0</b></div>
          <div className="kr"><span>Payouts</span><b>0</b></div>
          <div className="kr"><span>Median time</span><b>n/a</b></div>
          <p className="dim note" style={{ marginTop: 10 }}>No verified treasury figure exists yet, so none is shown.</p>
        </div>
      </div>
      <div className="panel">
        <div className="ph"><b>Payout history</b><span className="mute" style={{ fontSize: 13 }}>USDC</span></div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Transaction</th><th className="r">Knight</th></tr></thead>
            <tbody><tr><td colSpan={5} className="mute" style={{ textAlign: "center", padding: 28 }}>No payouts yet. Nothing has been paid out on this network.</td></tr></tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
