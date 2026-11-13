import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, errorText, isTransient } from "../lib/api";
import { POLL } from "../lib/config";
import { usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { applyTick, breachPrice, changePct } from "../lib/trade";
import { px, pctSigned } from "../lib/format";
import { knightView } from "../lib/knight";
import { CANDLE_TF, TF_MS, TF_BARS } from "../lib/timeframes";
import type { ChallengeState } from "../lib/types";
import { Gate, Notice } from "../components/Gate";
import { BattleSlot, HudTiles } from "../components/Hud";
import { LevelUpCelebration } from "../components/LevelUp";
import { PriceChart, type PriceMark } from "../components/Chart";
import { OrderTicket } from "../components/OrderTicket";
import { MarketButton, MarketPicker } from "../components/MarketPicker";
import { PositionsPanel } from "../components/Positions";
import { CombatLog } from "../components/CombatLog";
import { PathToFundedPanel } from "../components/PathToFunded";
import { Ascension } from "./Ascension";


export function Terminal() {
  const { id } = useParams();
  return <Gate note="Your wallet opens your challenge accounts. Sign in to trade.">{id ? <TerminalView id={id} /> : <Pick />}</Gate>;
}

/** /terminal with no id: jump to the latest live challenge, or offer to start one. */
function Pick() {
  const list = usePoll(() => api.challenges(), 15_000, "pick");
  const { wallet } = useSession();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (list.loading) return <main><div className="panel gate"><p className="mute">Loading your accounts...</p></div></main>;
  const all = list.data ?? [];
  const live = all.filter((c) => c.status === "active" && c.lifecycle === "active").sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const target = live[0] ?? [...all].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (target) return <Navigate replace to={`/terminal/${target.id}`} />;

  const demo = async () => {
    setBusy(true);
    setErr(null);
    try {
      const c = await api.createDemo(undefined, wallet ?? undefined);
      nav(`/terminal/${c.id}`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Notice title="No challenge yet" note="Start the free $5,000 demo to learn the rules, or pick a paid trial and mint a knight.">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button className="btn btn-fire" onClick={() => void demo()} disabled={busy} data-testid="start-demo">
          {busy ? "Starting..." : "Start free demo"}
        </button>
        <Link className="btn btn-ghost" to="/challenges">
          See challenges
        </Link>
      </div>
      {err && <p className="dn" style={{ fontSize: 13 }}>{err}</p>}
    </Notice>
  );
}

/** No challenge state after this long: say the data is slow (polling keeps retrying) instead of a bare loader. */
const SLOW_MS = 10_000;

function TerminalView({ id }: { id: string }) {
  const st = usePoll(() => api.challenge(id), POLL.stateMs, id);
  const c = st.data;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [id]);
  if (st.error instanceof ApiError && !c && !isTransient(st.error)) {
    const gone = st.error.status === 404 || st.error.status === 403;
    return <Notice title={gone ? "Challenge not found" : "Cannot load this challenge"} note={gone ? "It does not exist, or it belongs to another wallet." : st.error.message}>
      <Link className="btn btn-ghost" to="/barracks">Back to Barracks</Link>
    </Notice>;
  }
  if (!c) {
    const waiting = slow || (st.error !== undefined && isTransient(st.error));
    return <main><div className="panel gate"><p className="mute" data-testid="challenge-loading">{waiting ? "Market data is slow, retrying..." : "Loading challenge..."}</p></div></main>;
  }
  if (c.status === "wounded") return <Navigate replace to={`/revive/${c.id}`} />;
  if (c.status === "passed") return <Ascension c={c} onState={st.set} />;
  return <Battle c={c} onState={st.set} reload={st.reload} />;
}

function Battle({ c, onState, reload }: { c: ChallengeState; onState: (s: ChallengeState) => void; reload: () => Promise<void> }) {
  const { rules } = useSession();
  const [symbol, setSymbol] = useState("SOL");
  // phones: the order ticket is a bottom sheet opened from the Trade bar
  const [sheet, setSheet] = useState(false);
  const [picking, setPicking] = useState(false);
  const [tf, setTf] = useState<(typeof CANDLE_TF)[number]>("1h");
  const [reviving, setReviving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const market = usePoll(() => api.market(symbol, 14), POLL.marketMs, symbol);
  const candles = usePoll(() => api.candles(symbol, tf, 120), POLL.chartMs, `${symbol}:${tf}`);
  const m = market.data;
  const live = useMemo(() => (candles.data && m ? applyTick(candles.data.candles, TF_MS[tf], m.mark, m.fetchedAt) : (candles.data?.candles ?? [])), [candles.data, m, tf]);

  const pos = c.positions.find((p) => p.symbol === symbol);
  const marks = useMemo<PriceMark[]>(() => {
    const out: PriceMark[] = [];
    if (pos) {
      out.push({ price: pos.entryPrice, color: "#eeeef3", title: `${pos.side.toUpperCase()} ${pos.size.toFixed(2)} ${symbol}` });
      out.push({ price: breachPrice(pos, c.risk), color: "#ff5f6d", title: "BREACH" });
    }
    for (const o of c.openOrders) {
      if (o.symbol !== symbol || !o.limitPrice) continue;
      const tp = pos && o.reduceOnly && (pos.side === "long" ? o.limitPrice > pos.markPrice : o.limitPrice < pos.markPrice);
      out.push({ price: o.limitPrice, color: tp ? "#3ddc97" : "#948f90", title: tp ? "TP" : "LMT" });
    }
    return out;
  }, [pos, c.openOrders, c.risk, symbol]);

  const last = live[live.length - 1];
  const chg = m && live.length ? changePct(live, m.mark, TF_BARS[tf]) : undefined;
  const k = knightView(c);

  async function wake() {
    setReviving(true);
    setErr(null);
    try {
      onState(await api.reactivate(c.id));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setReviving(false);
    }
  }
  useEffect(() => {
    document.title = `${k.name} · Garuda terminal`;
  }, [k.name]);

  return (
    <main className="pg-terminal" data-testid="terminal">
      {c.lifecycle !== "active" && (
        <div className="banner" data-testid="dormant-banner">
          <span>
            {c.lifecycle === "dormant" ? "This funded account went dormant after 90 days without trading." : "This account is archived."}
          </span>
          {c.lifecycle === "dormant" && (
            <button className="btn btn-fire btn-sm" onClick={() => void wake()} disabled={reviving}>
              {reviving ? "Waking..." : "Reactivate"}
            </button>
          )}
          {err && <span className="dn">{err}</span>}
        </div>
      )}
      <LevelUpCelebration c={c} />
      <div className="t-top">
        <BattleSlot c={c} symbol={symbol} />
        <HudTiles c={c} />
      </div>
      <PathToFundedPanel c={c} />
      <div className="t-grid">
        <div className="panel cc">
          <div className="ph">
            <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
              <MarketButton symbol={symbol} maxLeverage={m?.maxLeverage ?? rules?.markets.find((x) => x.symbol === symbol)?.maxLeverage} onOpen={() => setPicking(true)} />
              {picking && <MarketPicker markets={rules?.markets ?? []} current={symbol} onPick={setSymbol} onClose={() => setPicking(false)} />}
              <div className="px">
                <b data-testid="mark">{m ? px(m.mark) : "..."}</b>
                {chg !== undefined && <span className={`${chg >= 0 ? "up" : "dn"} mono`} style={{ fontSize: 12 }}>{pctSigned(chg, 2)}</span>}
              </div>
            </div>
            <div className="tf">
              {CANDLE_TF.map((t) => (
                <button key={t} className={`chip ${t === tf ? "on" : ""}`} onClick={() => setTf(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="ohlc">
            {last && (
              <>
                <span>O {px(last.open)}</span>
                <span>H {px(last.high)}</span>
                <span>L {px(last.low)}</span>
                <span>C {px(last.close)}</span>
              </>
            )}
            <span className="src" title={m ? `Book source: ${m.source}` : ""}>
              {candles.data ? (candles.data.source === "synthetic" ? "synthetic candles" : "live candles") : ""}
              {m && ` · book ${m.source}`}
            </span>
          </div>
          <div className="chart">
            <PriceChart candles={live} marks={marks} resetKey={`${symbol}:${tf}`} />
          </div>
          {m && !m.tradable && <div className="banner" style={{ margin: 12 }}>{m.tradableReason ?? "Market closed"}</div>}
        </div>
        <div className={`tk-wrap${sheet ? " open" : ""}`}>
          <div className="tk-backdrop" onClick={() => setSheet(false)} />
          <div className="tk-sheet">
            <div className="tk-sheet-hd">
              <b>Trade {symbol}</b>
              <button type="button" aria-label="Close" onClick={() => setSheet(false)}>×</button>
            </div>
            <OrderTicket c={c} m={m} symbol={symbol} rules={rules} onState={(s) => { onState(s); setSheet(false); }} />
          </div>
        </div>
      </div>
      <div className="t-tradebar">
        <button type="button" className="btn btn-fire" onClick={() => setSheet(true)} data-testid="mobile-trade">Trade {symbol}</button>
      </div>
      <div className="btm">
        <PositionsPanel c={c} onState={onState} reload={reload} />
        <CombatLog entries={c.combatLog} />
      </div>
    </main>
  );
}
