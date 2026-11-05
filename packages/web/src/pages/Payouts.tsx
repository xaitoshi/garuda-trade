import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, errorText } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { knightView, artState } from "../lib/knight";
import { pct, shortAddr, usd, usdSigned } from "../lib/format";
import { explorerTxUrl, notEligibleText, openPayout, payoutStatusText, totalPaid } from "../lib/payout";
import { Gate } from "../components/Gate";
import { KnightImg } from "../components/Art";

export function Payouts() {
  return (
    <Gate note="Payouts are tied to your funded accounts. Sign in to see them.">
      <PayoutsView />
    </Gate>
  );
}

const newKey = (): string => `web-payout-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function PayoutsView() {
  const { rules, wallet } = useSession();
  const list = usePoll(() => api.challenges(), 10_000, "payouts-list");
  const funded = (list.data ?? []).filter((c) => c.stage === "funded").sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  const quote = usePoll(() => (funded ? api.payoutQuote(funded.id) : Promise.resolve(null)), 10_000, funded?.id ?? "none");
  const history = usePoll(() => api.payouts(), 5_000, "payouts-history");
  const q = quote.data;
  const all = history.data ?? [];
  const live = funded ? openPayout(all, funded.id) : undefined;
  const split = q?.split ?? rules?.payouts?.split ?? rules?.common.profitSplit ?? 0.8;
  const min = q?.minUsd ?? rules?.payouts?.minUsd ?? rules?.common.minPayoutUsd ?? 20;
  const payoutsOff = rules?.payouts ? !rules.payouts.enabled : false;
  const keys = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const request = async () => {
    if (!funded || busy) return;
    setBusy(true);
    setErr(undefined);
    // One key per account until a request succeeds: a double click or a retry after a dropped response cannot pay twice.
    const key = keys.current.get(funded.id) ?? newKey();
    keys.current.set(funded.id, key);
    try {
      await api.requestPayout(funded.id, key);
      keys.current.delete(funded.id);
      await Promise.all([history.reload(), quote.reload(), list.reload()]);
    } catch (e) {
      // A definite answer from the server (not a dropped connection) ends this attempt: the next click is a new request.
      if (e instanceof ApiError && e.status > 0) keys.current.delete(funded.id);
      setErr(errorText(e));
      void history.reload();
    } finally {
      setBusy(false);
    }
  };

  const reason = notEligibleText(q, min);
  const canRequest = Boolean(funded && q?.eligible && !live && !busy && !payoutsOff);
  const st = live ? payoutStatusText(live) : undefined;

  return (
    <main className="pg-payouts" data-testid="payouts">
      <div className="banner" role="note">
        <b>Devnet payouts.</b> Payouts are paid in test USDC on Solana devnet to the wallet you are signed in with. There are no identity checks, and no real money moves on this network.
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
                <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>{knightView(funded).label} · #{funded.id.slice(-4).toUpperCase()}</div>
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
          <div className="lbl">{live ? "Payout in progress" : "Available to withdraw"}</div>
          <div className="big" data-testid="owed">{live ? usd(live.amountUsd) : q ? usd(q.traderShare) : "$0"}<span>USDC</span></div>
          <div className="split"><i style={{ width: `${split * 100}%` }} /><i style={{ width: `${(1 - split) * 100}%` }} /></div>
          <div className="sl"><span><b className="fire">{pct(split, 0)}</b> You</span><span>Garuda <b>{pct(1 - split, 0)}</b></span></div>
          <div className="brk">
            <div><span>Profit this cycle</span><b>{live ? usd(live.grossProfitUsd, 2) : q ? usd(q.grossProfit, 2) : "$0.00"}</b></div>
            <div><span>Your {pct(split, 0)} share</span><b className="up">{live ? usd(live.amountUsd, 2) : q ? usd(q.traderShare, 2) : "$0.00"}</b></div>
            <div><span>Garuda {pct(1 - split, 0)}</span><b>{live ? usd(live.firmShareUsd, 2) : q ? usd(q.firmShare, 2) : "$0.00"}</b></div>
            <div><span>Paid to</span><b className="mono" data-testid="payout-destination" title={live?.destination ?? q?.destination ?? wallet ?? undefined}>{live?.destination ?? q?.destination ?? wallet ? shortAddr((live?.destination ?? q?.destination ?? wallet)!) : "-"}</b></div>
          </div>
          <div className="req">
            <div className="inp off"><span>{live ? usd(live.amountUsd, 2) : q ? usd(q.traderShare, 2) : "$0.00"}</span><small>ALL</small></div>
            <button className="btn btn-fire" style={{ padding: "0 34px", fontSize: 16 }} disabled={!canRequest} onClick={() => void request()} data-testid="request-payout">
              {busy ? "Requesting..." : live ? "In progress" : "Request payout"}
            </button>
          </div>
          {st && live && (
            <div style={{ marginTop: 12 }} data-testid="payout-status">
              <span className={`st ${st.tone === "up" ? "funded" : "dormant"}`}>{st.label}</span>
              <span className="dim note" style={{ marginLeft: 10 }}>{st.hint}</span>
            </div>
          )}
          <div className="dim" style={{ fontSize: 12, marginTop: 12, fontFamily: "GM, monospace" }}>
            {payoutsOff
              ? "Payouts are not enabled on this server."
              : live
                ? "Requesting a payout takes your whole profit and resets the account balance to its starting size."
                : reason || `Minimum payout ${usd(min)}.${q?.autoApprove === false ? " This one is above the auto-approve limit, so Garuda reviews it first." : ""} Requesting takes your whole profit and resets the balance to the starting size.`}
          </div>
          {err && <div className="dn note" style={{ marginTop: 6 }} data-testid="payout-error">{err}</div>}
          {Boolean(quote.error) && funded && <div className="dn note" style={{ marginTop: 6 }}>{errorText(quote.error)}</div>}
        </div>
        <div className="panel tre">
          <div className="lbl">Your payouts</div>
          <div className="v" data-testid="paid-total">{usd(totalPaid(all), 2)}</div>
          <div className="sl" style={{ marginBottom: 18 }}><span>Total paid to you</span><span>USDC (devnet)</span></div>
          <div className="kr"><span>Paid</span><b>{all.filter((p) => p.status === "paid").length}</b></div>
          <div className="kr"><span>In progress</span><b>{all.filter((p) => p.status !== "paid" && p.status !== "rejected").length}</b></div>
          <div className="kr"><span>Rejected</span><b>{all.filter((p) => p.status === "rejected").length}</b></div>
          <p className="dim note" style={{ marginTop: 10 }}>Sent from the Garuda treasury on Solana devnet. Click a transaction in the history to see it on the explorer.</p>
        </div>
      </div>
      <div className="panel">
        <div className="ph"><b>Payout history</b><span className="mute" style={{ fontSize: 13 }}>USDC</span></div>
        <div className="tbl-scroll">
          <table className="tbl" data-testid="payout-history">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Transaction</th><th className="r">Account</th></tr></thead>
            <tbody>
              {all.length === 0 && <tr><td colSpan={5} className="mute" style={{ textAlign: "center", padding: 28 }}>No payouts yet.</td></tr>}
              {all.map((p) => {
                const s = payoutStatusText(p);
                return (
                  <tr key={p.id} data-testid="payout-row">
                    <td className="mono">{when(p.createdAt)}</td>
                    <td className="mono">{usd(p.amountUsd, 2)}</td>
                    <td><span className={s.tone === "up" ? "up" : s.tone === "dn" ? "dn" : "dim"} title={p.rejectedReason ?? s.hint}>{s.label}</span></td>
                    <td className="mono">{p.signature ? <a href={explorerTxUrl(p.signature)} target="_blank" rel="noreferrer">{p.signature.slice(0, 8)}...</a> : "-"}</td>
                    <td className="r mono">#{p.challengeId.slice(-4).toUpperCase()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
