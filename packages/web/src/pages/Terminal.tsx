import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, errorText, isTransient } from "../lib/api";
import { POLL } from "../lib/config";
import { useMedia, usePoll } from "../lib/hooks";
import { useSession } from "../lib/session";
import { applyTick, breachPrice, changePct } from "../lib/trade";
import { num, px, pctSigned } from "../lib/format";
import { knightView } from "../lib/knight";
import { CANDLE_TF, TF_MS, TF_BARS } from "../lib/timeframes";
import type { ChallengeState } from "../lib/types";
import { Gate, Notice } from "../components/Gate";
import { HudTiles } from "../components/Hud";
import { BattleSlot } from "../components/Battle";
import { LevelUpCelebration } from "../components/LevelUp";
import { PriceChart, type ChartOrder, type PriceMark } from "../components/Chart";
import { OrderTicket } from "../components/OrderTicket";
import { MarketButton, MarketPicker } from "../components/MarketPicker";
import { MarketFavorites, MarketStats } from "../components/MarketFavorites";
import { BookPanel, type BookView } from "../components/BookPanel";
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
  const mobile = useMedia("(max-width:820px)");
  const [view, setView] = useState<"chart" | BookView>("chart");
  const [bookView, setBookView] = useState<BookView>("book");
  const [picking, setPicking] = useState(false);
  const [tf, setTf] = useState<(typeof CANDLE_TF)[number]>("1h");
  const [reviving, setReviving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const market = usePoll(() => api.market(symbol, 14), POLL.marketMs, symbol);
  // history grows as the user scrolls back: 200 bars first, then more, up to the API's cap
  const [depth, setDepth] = useState({ key: "", bars: 200, done: false });
  const histKey = `${symbol}:${tf}`;
  const bars = depth.key === histKey ? depth.bars : 200;
  // each answer remembers what it was asked for, so a stale answer is never mistaken for "no more history"
  const candles = usePoll(async () => ({ key: histKey, bars, r: await api.candles(symbol, tf, bars) }), POLL.chartMs, `${histKey}:${bars}`);
  const got = candles.data?.key === histKey ? candles.data : undefined;
  const shown = got?.r;
  useEffect(() => {
    if (got && got.bars === bars && depth.key === histKey && got.r.candles.length < bars - 5) setDepth((d) => ({ ...d, done: true }));
  }, [got, bars, depth.key, histKey]);
  const needMore = () => {
    if (!got || got.bars !== bars) return; // the last request is still on its way
    setDepth((d) => {
      const cur = d.key === histKey ? d : { key: histKey, bars: 200, done: false };
      if (cur.done || cur.bars >= 1000) return cur;
      return { key: histKey, bars: Math.min(1000, cur.bars + 300), done: false };
    });
  };
  const m = market.data;
  const live = useMemo(() => (shown && m ? applyTick(shown.candles, TF_MS[tf], m.mark, m.fetchedAt) : (shown?.candles ?? [])), [shown, m, tf]);

  const pos = c.positions.find((p) => p.symbol === symbol);
  const marks = useMemo<PriceMark[]>(() => {
    const out: PriceMark[] = [];
    if (pos) {
      out.push({ price: pos.entryPrice, color: "#eeeef3", title: `${pos.side.toUpperCase()} ${pos.size.toFixed(2)} ${symbol}` });
      out.push({ price: breachPrice(pos, c.risk), color: "#ff5f6d", title: "BREACH" });
    }
    return out;
  }, [pos, c.risk, symbol]);

  // resting orders as draggable tags on the chart (PilotBot style): drag to re-price, x to cancel
  const chartOrders = useMemo<ChartOrder[]>(
    () =>
      c.openOrders
        .filter((o) => o.symbol === symbol && o.limitPrice)
        .map((o) => {
          const tp = Boolean(pos && o.reduceOnly && (pos.side === "long" ? o.limitPrice! > pos.markPrice : o.limitPrice! < pos.markPrice));
          return { id: o.id, price: o.limitPrice!, kind: tp ? "tp" : o.side, label: `${tp ? "TP" : o.side === "buy" ? "Buy" : "Sell"} ${num(o.remaining, 4)}` };
        }),
    [c.openOrders, pos, symbol],
  );
  const [orderErr, setOrderErr] = useState<string | null>(null);
  const cancelOrder = async (id: string) => {
    setOrderErr(null);
    try {
      await api.cancelOrder(c.id, id);
      await reload();
    } catch (e) {
      setOrderErr(errorText(e));
    }
  };
  // re-price = place the same order at the new price, then cancel the old one (so a rejected move keeps the order)
  const moveOrder = async (id: string, price: number) => {
    const o = c.openOrders.find((x) => x.id === id);
    if (!o) return;
    setOrderErr(null);
    try {
      const res = await api.placeOrder(c.id, { symbol: o.symbol, side: o.side, size: o.remaining, type: "limit", limitPrice: price, reduceOnly: o.reduceOnly || undefined, takeProfit: o.takeProfit });
      if (!res.accepted) {
        setOrderErr(`Could not move the order: ${(res.reason ?? "rejected").replace(/[_:]/g, " ")}`);
        return;
      }
      await api.cancelOrder(c.id, id);
      await reload();
    } catch (e) {
      setOrderErr(errorText(e));
    }
  };
  const [preset, setPreset] = useState<{ price: number; n: number } | undefined>(undefined);
  const pickPrice = (p: number) => {
    // the price as the book shows it (the feed can carry more decimals than the market trades in)
    const shownPx = Number(px(p).replace(/,/g, ""));
    setPreset((x) => ({ price: shownPx, n: (x?.n ?? 0) + 1 }));
    if (mobile) setSheet(true);
  };

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
      <div className="t-grid">
        <div className="panel cc" data-view={view}>
          <div className="cc-strip">
            <MarketFavorites symbol={symbol} markets={(rules?.markets ?? []).map((x) => x.symbol)} onPick={setSymbol} />
            <div className="ph">
              <div className="ph-l">
                <MarketButton symbol={symbol} maxLeverage={m?.maxLeverage ?? rules?.markets.find((x) => x.symbol === symbol)?.maxLeverage} onOpen={() => setPicking(true)} />
                {picking && <MarketPicker markets={rules?.markets ?? []} current={symbol} onPick={setSymbol} onClose={() => setPicking(false)} />}
                <div className="px">
                  <b data-testid="mark">{m ? px(m.mark) : "..."}</b>
                  {chg !== undefined && <span className={`${chg >= 0 ? "up" : "dn"} mono`} style={{ fontSize: 12 }}>{pctSigned(chg, 2)}</span>}
                </div>
                <MarketStats m={m} />
              </div>
              <div className="tf tf-d">
                {CANDLE_TF.map((t) => (
                  <button key={t} className={`chip ${t === tf ? "on" : ""}`} onClick={() => setTf(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="cc-body">
            {mobile && (
              <div className="tabs2 cc-tabs">
                {([["chart", "Chart"], ["book", "Order Book"], ["trades", "Recent Trades"]] as const).map(([v, label]) => (
                  <button key={v} className={view === v ? "on" : ""} onClick={() => { setView(v); if (v !== "chart") setBookView(v); }}>{label}</button>
                ))}
              </div>
            )}
            {mobile && view !== "chart" ? (
              <BookPanel m={m} symbol={symbol} view={bookView} onView={setBookView} onPrice={pickPrice} />
            ) : (
              <>
                <div className="tf tf-m">
                {CANDLE_TF.map((t) => (
                  <button key={t} className={`chip ${t === tf ? "on" : ""}`} onClick={() => setTf(t)}>
                    {t}
                  </button>
                ))}
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
                </div>
                {orderErr && <div className="chart-err" role="alert">{orderErr}</div>}
                <div className="chart">
                  <PriceChart candles={live} marks={marks} resetKey={histKey} onNeedMore={needMore} orders={chartOrders} onCancelOrder={(id) => void cancelOrder(id)} onMoveOrder={(id, p) => void moveOrder(id, p)} fmt={px} />
                </div>
              </>
            )}
          </div>
          {m && !m.tradable && <div className="banner" style={{ margin: 12 }}>{m.tradableReason ?? "Market closed"}</div>}
        </div>
        {!mobile && <BookPanel m={m} symbol={symbol} view={bookView} onView={setBookView} onPrice={pickPrice} />}
        <div className={`tk-wrap${sheet ? " open" : ""}`}>
          <div className="tk-backdrop" onClick={() => setSheet(false)} />
          <div className="tk-sheet">
            <div className="tk-sheet-hd">
              <b>Trade {symbol}</b>
              <button type="button" aria-label="Close" onClick={() => setSheet(false)}><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
            </div>
            <OrderTicket c={c} m={m} symbol={symbol} rules={rules} preset={preset} onState={(s) => { onState(s); setSheet(false); }} />
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
      {/* the pass checklist sits below the trading area: it is reference, not something to watch while trading */}
      <PathToFundedPanel c={c} />
    </main>
  );
}
