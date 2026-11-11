import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { pct, usd } from "../lib/format";
import type { ChallengeState, PathToFunded } from "../lib/types";

type Req = { id: string; label: string; value: string; ok: boolean; hint: string };

/** The four pass requirements, in the order the rulebook lists them. */
export function requirements(p: PathToFunded): Req[] {
  const share = p.bestDay.share;
  return [
    {
      id: "target",
      label: "Profit target, closed trades",
      value: `${usd(Math.max(0, p.closedProfit))} / ${usd(p.targetProfit)}`,
      ok: p.targetMet,
      hint: "Only closed profit counts. Open profit does not pass.",
    },
    {
      id: "flat",
      label: "No open positions",
      value: p.flat ? "Flat" : `${p.openPositions} open`,
      ok: p.flat,
      hint: "Close everything to pass. Nothing is closed for you.",
    },
    {
      id: "days",
      label: "Trading days",
      value: `${Math.min(p.tradingDays, p.minTradingDays)} / ${p.minTradingDays}`,
      ok: p.daysMet,
      hint: "A UTC day counts when you open or close a position. Days do not need to be in a row.",
    },
    {
      id: "bestday",
      label: "Best day rule",
      value: share === null ? "No profit yet" : `${pct(share, 0)} of ${pct(p.bestDay.maxShare, 0)} max`,
      ok: p.bestDay.ok,
      hint: `Your best day can be at most ${pct(p.bestDay.maxShare, 0)} of all profitable days. Losing days are ignored.`,
    },
  ];
}

/** Path to Funded progress on the terminal (evaluation accounts). */
export function PathToFundedPanel({ c }: { c: ChallengeState }) {
  const p = c.pathToFunded;
  if (!p || c.stage !== "evaluation") return null;
  const reqs = requirements(p);
  const met = reqs.filter((r) => r.ok).length;
  return (
    <div className="panel ptf" data-testid="path-to-funded">
      <div className="ph">
        <b>Path to funded</b>
        <span className={`st ${p.eligible ? "funded" : "active"}`} data-testid="ptf-status">
          {p.eligible ? (c.demo ? "Demo cleared" : "Eligible: claim funded account") : `${met} of 4 met`}
        </span>
      </div>
      <div className="ptf-grid">
        {reqs.map((r) => (
          <div key={r.id} className={`ptf-req ${r.ok ? "ok" : ""}`} data-testid={`ptf-${r.id}`} title={r.hint}>
            <i aria-hidden>{r.ok ? "✓" : ""}</i>
            <div>
              <span>{r.label}</span>
              <b>{r.value}</b>
              <small>{r.hint}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  { id: "claim", label: "Claim" },
  { id: "verify_identity", label: "Verify identity" },
  { id: "under_review", label: "Risk review" },
  { id: "funded", label: "Funded" },
] as const;

/** Claim flow on a passed challenge: claim, identity check, risk review (about one business day), funded. */
export function ClaimFunded({ c, onState }: { c: ChallengeState; onState?: (s: ChallengeState) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = c.pathToFunded;
  if (!p) return null;
  const at = Math.max(0, STEPS.findIndex((s) => s.id === p.next));
  const rejected = p.next === "rejected";

  async function claim() {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.claimFunded(c.id);
      onState?.(s);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel claim" data-testid="claim-flow">
      <div className="ph">
        <b>Funded account</b>
        <span className={`st ${p.next === "funded" ? "funded" : rejected ? "wounded" : "active"}`}>{rejected ? "Not approved" : STEPS[at]!.label}</span>
      </div>
      <ol className="claim-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={rejected ? "" : i < at || p.next === "funded" ? "done" : i === at ? "on" : ""}>
            <i>{i + 1}</i>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
      {p.next === "claim" && (
        <>
          <p className="mute note">You met every requirement. Claim the funded account, verify your identity, and Garuda reviews the challenge, usually within one business day.</p>
          <button className="btn btn-fire" style={{ width: "100%", padding: 18 }} onClick={() => void claim()} disabled={busy} data-testid="claim-funded">
            {busy ? "Claiming..." : "Eligible: claim funded account"}
          </button>
        </>
      )}
      {p.next === "verify_identity" && (
        <div data-testid="kyc-pending">
          <b>Verify identity</b>
          <p className="mute note">Identity check pending. A government ID and a live selfie are needed before the funded account opens. This step updates here once it is approved.</p>
          <button className="btn btn-ghost" style={{ width: "100%" }} disabled>Verification pending</button>
        </div>
      )}
      {p.next === "under_review" && (
        <div data-testid="under-review">
          <b>Under review</b>
          <p className="mute note">Your identity is verified. The risk review usually takes about one business day. It checks for hedging across accounts, collusion, feed or latency exploits, account sharing, and all in gambling.</p>
        </div>
      )}
      {p.next === "funded" && p.claim?.fundedId && (
        <Link className="btn btn-fire" style={{ width: "100%", padding: 18 }} to={`/terminal/${p.claim.fundedId}`} data-testid="open-funded">
          Open funded account
        </Link>
      )}
      {rejected && <p className="dn note">This claim was not approved{p.claim?.reason ? `: ${p.claim.reason}` : ""}. Contact support if you think this is a mistake.</p>}
      {err && <div className="dn note">{err}</div>}
    </div>
  );
}
