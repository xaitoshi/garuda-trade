import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { LEVELS, knightView, tierOfLevel, type KnightLevel } from "../lib/knight";
import { pct, usd, usdSigned } from "../lib/format";
import type { ChallengeState } from "../lib/types";
import { BossImg, KnightImg, Spark } from "../components/Art";

const LEVEL_COLOR: Record<number, string> = { 1: "#d9d3d4", 2: "#bbb4fb", 3: "#8fd3ff", 4: "#ffc24a" };

/** Shown instead of the terminal when a challenge is passed: "The Phoenix falls." (mock 04) */
export function Ascension({ c }: { c: ChallengeState }) {
  const { rules, wallet } = useSession();
  const nav = useNavigate();
  const k = knightView(c);
  const after = (k.demo ? 1 : Math.min(4, k.level + 1)) as KnightLevel;
  const unlocked = !k.demo && k.level < 4 ? rules?.tiers[tierOfLevel(k.level + 1)] : undefined;
  const spec = rules?.tiers[c.tier];
  const list = usePoll(() => api.challenges(), 10_000, "asc-list");
  const funded = (list.data ?? []).find((x) => x.stage === "funded" && x.knightId && x.knightId === c.knightId && x.lifecycle !== "archived");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const start = c.risk.startingBalance;
  const ddLimit = start - c.risk.drawdownFloor;

  async function claim() {
    setBusy(true);
    setErr(null);
    try {
      const f = await api.createFunded(c.tier, c.knightId, wallet ?? undefined);
      nav(`/terminal/${f.id}`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }
  async function share() {
    const text = `${k.name} slew the Phoenix on Garuda: ${k.levelName} trial, ${usdSigned(c.risk.profitLoss)} (${pct(c.risk.profitLoss / start)}). Simulated account.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Could not copy to the clipboard");
    }
  }

  return (
    <main className="pg-ascension" data-testid="ascension">
      <div className="lay">
        <div className="panel stage dots">
          <svg className="rays" viewBox="-700 -700 1400 1400" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => {
              const a = i * 15;
              const p = (d: number) => `${(700 * Math.cos(((a + d) * Math.PI) / 180)).toFixed(0)} ${(700 * Math.sin(((a + d) * Math.PI) / 180)).toFixed(0)}`;
              return <path key={i} d={`M0 0 L${p(-3)} L${p(3)}Z`} fill={`rgba(255,95,1,${i % 2 ? 0.07 : 0.035})`} />;
            })}
          </svg>
          <div className="hd">
            <div className="eyebrow">Challenge passed</div>
            <h1 className="pt big-title">The Phoenix falls.</h1>
          </div>
          <span className="slot-tag" style={{ right: 34, top: 34, zIndex: 3 }}>VICTORY</span>
          <div className="art">
            <div className="fall">
              <BossImg state="defeated" size={210} />
            </div>
            <span className="fallx">BOSS HP 0%</span>
            {!k.demo && (
              <>
                <div className="before">
                  <KnightImg level={k.level} size={150} />
                  <div className="cap">BEFORE<b>LV.{k.level} {k.levelName}</b></div>
                </div>
                <div className="arrow">›››</div>
              </>
            )}
            <div className="after">
              <div className="halo" style={{ background: `radial-gradient(circle, ${LEVEL_COLOR[after]}55, transparent 68%)` }} />
              <KnightImg level={after} state="victory" size={270} />
              <div className="cap">
                {k.demo ? "DEMO CLEARED" : "AFTER"}
                <b style={{ color: LEVEL_COLOR[after] }}>{k.demo ? k.name : `LV.${after} ${LEVELS[after - 1]!.name}`}</b>
              </div>
            </div>
            <Spark color="#8fd3ff" size={26} style={{ position: "absolute", left: 480, top: 40 }} />
            <Spark color="#ffc24a" size={18} style={{ position: "absolute", right: 50, top: 70 }} />
          </div>
          <div className="fstats">
            <div>
              <b className="up">{usdSigned(c.risk.profitLoss)}</b>
              <span>PROFIT · {pct(c.risk.profitLoss / start)}</span>
            </div>
            <div>
              <b>{usd(c.account.equity)}</b>
              <span>FINAL EQUITY</span>
            </div>
            <div>
              <b>{usd(c.account.feesPaid, 2)}</b>
              <span>FEES PAID</span>
            </div>
            <div>
              <b>{usd(Math.max(0, c.risk.drawdownUsedPct) * ddLimit)}</b>
              <span>MAX DD USED / {usd(ddLimit)}</span>
            </div>
          </div>
        </div>
        <div className="rc">
          {unlocked && (
            <div className="panel un">
              <div className="un-ic">
                <KnightImg level={(k.level + 1) as KnightLevel} size={50} />
              </div>
              <div>
                <span className="lbl">Newly unlocked</span>
                <b style={{ marginTop: 4 }}>{unlocked.name} Trial</b>
                <span>{usd(unlocked.accountSize)} account</span>
              </div>
            </div>
          )}
          <div className="panel">
            <div className="ph">
              <b>{k.demo ? "Demo account" : "Funded account"}</b>
              <span className={`st ${k.demo ? "active" : "funded"}`}>{k.demo ? "Demo" : "Funded"}</span>
            </div>
            <div className="acc">
              <div className="rw"><span>Account size</span><b>{usd(start)}</b></div>
              <div className="rw"><span>Profit split</span><b className="fire">{k.demo ? "none" : pct(rules?.common.profitSplit ?? 0.8, 0)}</b></div>
              <div className="rw"><span>Daily loss</span><b>{pct(rules?.common.dailyLossPct ?? 0.03, 0)}</b></div>
              <div className="rw"><span>Max drawdown</span><b>{pct(rules?.common.maxDrawdownPct ?? 0.06, 0)} static</b></div>
              <div className="rw"><span>Payouts</span><b>{k.demo ? "Not on demo" : "USDC"}</b></div>
            </div>
          </div>
          <div className="panel share">
            <div className="sc">
              <small>GARUDA</small>
              <KnightImg level={after} state="victory" size={92} />
            </div>
            <div>
              <div className="lbl">Share card</div>
              <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.03em", margin: "6px 0 4px" }}>{k.name} {k.demo ? "cleared the demo" : "ascended"}</div>
              <div className="mute" style={{ fontSize: 13.5 }}>{k.levelName} · {pct(c.risk.profitLoss / start)} · Boss slain</div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => void share()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          {k.demo ? (
            <Link className="btn btn-fire" style={{ width: "100%", padding: 18 }} to="/challenges">
              Mint a knight and go for real
            </Link>
          ) : funded ? (
            <Link className="btn btn-fire" style={{ width: "100%", padding: 18 }} to={`/terminal/${funded.id}`} data-testid="open-funded">
              Open funded account
            </Link>
          ) : (
            <button className="btn btn-fire" style={{ width: "100%", padding: 18 }} onClick={() => void claim()} disabled={busy} data-testid="claim-funded">
              {busy ? "Claiming..." : "Claim funded account"}
            </button>
          )}
          {spec && !k.demo && <div className="dim note mono">Funded accounts are simulated too. Payouts open with KYC (coming in a later release).</div>}
          {err && <div className="dn note">{err}</div>}
        </div>
      </div>
    </main>
  );
}
