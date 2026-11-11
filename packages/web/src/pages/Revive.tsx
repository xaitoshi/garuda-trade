import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, errorText } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { usePurchase, STEP_TEXT } from "../lib/usePurchase";
import { bossState, knightView } from "../lib/knight";
import { RULE_CHIP, RULE_LABEL, buildBreachSeries } from "../lib/breach";
import { clock, usd } from "../lib/format";
import type { ReviveInfo } from "../lib/types";
import { Check } from "../components/Art";
import { BossImg, KnightImg } from "../components/Art";
import { BreachChart } from "../components/BreachChart";
import { Gate, Notice } from "../components/Gate";
import { useState } from "react";

export function Revive() {
  const { id = "" } = useParams();
  return (
    <Gate note="Sign in with the wallet that holds this knight.">
      <ReviveView id={id} />
    </Gate>
  );
}

const WHY: Record<NonNullable<ReviveInfo["reason"]>, string> = {
  demo_no_revive: "The demo has no revive. Start it again for free.",
  not_wounded: "This knight is not wounded.",
  already_revived: "This account was already revived.",
  revive_cap_reached: "This knight used all 3 revives.",
  revive_cooldown: "Revives have a 24 hour cooldown.",
};

function ReviveView({ id }: { id: string }) {
  const st = usePoll(() => api.challenge(id), 5000, id);
  const info = usePoll(() => api.reviveInfo(id), 15_000, id);
  const { rules, health } = useSession();
  const buy = usePurchase();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [free, setFree] = useState(false);

  const c = st.data;
  const series = useMemo(() => (c ? buildBreachSeries(c) : undefined), [c]);
  if (st.error && !c) {
    const gone = st.error instanceof ApiError && (st.error.status === 404 || st.error.status === 403);
    return (
      <Notice title={gone ? "Knight not found" : "Cannot load this knight"} note={gone ? "It does not exist, or it belongs to another wallet." : errorText(st.error)}>
        <Link className="btn btn-ghost" to="/barracks">Back to Barracks</Link>
      </Notice>
    );
  }
  if (!c) return <main><div className="panel gate"><p className="mute">Loading...</p></div></main>;

  const k = knightView(c);
  const spec = rules?.tiers[c.tier];
  const i = info.data;
  const fee = i?.fee ?? spec?.reviveFee ?? 0;
  const list = spec?.fee ?? 0;
  const chain = health?.chain;
  const paid = chain !== undefined && chain !== "off";
  const wounded = c.status === "wounded";
  const eligible = wounded && (i?.eligible ?? false);

  async function go() {
    setErr(null);
    try {
      if (paid) {
        const order = await buy.run(() => api.quoteRevive(id));
        if (order.challengeId) nav(`/terminal/${order.challengeId}`);
        else nav("/barracks");
      } else {
        setFree(true);
        const r = await api.revive(id);
        nav(`/terminal/${r.state.id}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : errorText(e));
      setFree(false);
    }
  }

  const busy = buy.busy || free;
  return (
    <main className="pg-wounded" data-testid="revive">
      <div className="lay">
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <div className="panel hero dots">
            <div className="eyebrow" style={{ color: "var(--red)" }}>Challenge ended</div>
            <h1 className="pt hero-title">Your knight<br />is wounded.</h1>
            <p className="mute" style={{ marginTop: 14, fontSize: 18 }}>Not burned. Revive and fight again.</p>
            <span className="slot-tag" style={{ right: 20, top: 20 }}>Wounded</span>
            <div className="art">
              <div className="ph2"><BossImg state={bossState(c)} size={190} /></div>
              <div className="k"><KnightImg level={k.level} state="wounded" fill alt="" /></div>
            </div>
          </div>
          <div className="panel">
            <div className="ph">
              <b>What broke</b>
              {series && <span className="st wounded">{RULE_CHIP[series.rule]}</span>}
            </div>
            {series ? (
              <>
                <div className="broke">
                  <div><span className="lbl">Rule</span><b>{RULE_LABEL[series.rule]}</b></div>
                  <div><span className="lbl">Time</span><b>{clock(series.breachTs)} UTC</b></div>
                  <div>
                    <span className="lbl">Equity vs floor</span>
                    <b><span className="dn">{usd(series.equity)}</span> <span className="dim" style={{ fontWeight: 400, fontSize: 15 }}>/ {usd(series.floor)}</span></b>
                  </div>
                </div>
                <div className="chart" style={{ paddingTop: 14 }}>
                  <BreachChart s={series} />
                  <div className="dim note mono" style={{ padding: "0 4px 6px" }}>Realised balance after each fill; the last point is equity at the breach.</div>
                </div>
              </>
            ) : (
              <p className="mute" style={{ padding: 20 }}>{wounded ? "Breach details are not available for this account." : "This knight is not wounded."}</p>
            )}
          </div>
        </div>
        <div className="panel rv">
          <div className="lbl">Revive</div>
          <h2 className="pt" style={{ marginTop: 6 }}>{k.name}, {spec?.name ?? k.levelName} Trial.</h2>
          <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>{c.knightId ? `#${c.knightId.slice(-6)} · ` : ""}{usd(c.risk.startingBalance)} account</div>
          <div className="price">
            {list > fee && <s>{usd(list)}</s>}
            <b data-testid="revive-price">{usd(fee, fee % 1 ? 2 : 0)}</b>
            <span>USDC</span>
          </div>
          <span className="off">{Math.round((rules?.revive.discount ?? 0.2) * 100)}% OFF · REVIVE</span>
          <div className="keep">
            <div><Check /><b>Keeps history and level</b></div>
            <div><Check /><b>Adds a scar to your knight</b></div>
            <div><Check /><span>Fresh <b>{usd(c.risk.startingBalance)}</b> simulated account</span></div>
            <div><Check /><span>Same rules: {Math.round((rules?.common.profitTargetPct ?? 0.1) * 100)}% target, {Math.round((rules?.common.dailyLossPct ?? 0.03) * 100)}% daily, {Math.round((rules?.common.maxDrawdownPct ?? 0.06) * 100)}% DD</span></div>
          </div>
          <button className="btn btn-fire" style={{ width: "100%", padding: 18 }} disabled={!eligible || busy} onClick={() => void go()} data-testid="revive-btn">
            {busy ? (STEP_TEXT[buy.step] || "Reviving...") : `Revive (${Math.round((rules?.revive.discount ?? 0.2) * 100)}% off)`}
          </button>
          <Link className="btn btn-ghost" style={{ width: "100%", marginTop: 10, padding: 16 }} to="/barracks">Return to Barracks</Link>
          {i && !i.eligible && i.reason && <div className="dn note" style={{ marginTop: 12 }}>{WHY[i.reason]}{i.availableAt ? ` Available ${new Date(i.availableAt).toUTCString()}.` : ""}</div>}
          {err && <div className="dn note" style={{ marginTop: 12 }} role="alert">{err}</div>}
          <div className="dim" style={{ fontSize: 12, marginTop: 16, fontFamily: "GM, monospace" }}>{paid ? "Paid in USDC from your wallet." : "No payment is taken on this server."}</div>
          <div className="hr2" />
          <div className="lbl" style={{ marginBottom: 6 }}>Knight record</div>
          <div className="kr"><span>Level</span><b>{k.level} · {k.levelName}</b></div>
          <div className="kr"><span>Revives used</span><b>{i ? `${i.revivesUsed} of ${i.revivesUsed + i.revivesLeft}` : "-"}</b></div>
          <div className="kr"><span>Equity at breach</span><b className="dn">{series ? usd(series.equity) : "-"}</b></div>
          <div className="kr"><span>Scars</span><b>{c.scars} → {c.scars + 1}</b></div>
        </div>
      </div>
    </main>
  );
}
