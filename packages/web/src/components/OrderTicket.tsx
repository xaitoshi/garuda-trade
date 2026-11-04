import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../lib/api";
import { breachPrice, estSlippagePct, roundSize, sizeForPct } from "../lib/trade";
import { num, px, usd } from "../lib/format";
import type { ChallengeState, MarketView, Rules } from "../lib/types";

type Tab = "market" | "limit" | "stop";

export function OrderTicket({ c, m, symbol, rules, onState }: { c: ChallengeState; m: MarketView | undefined; symbol: string; rules: Rules | undefined; onState: (s: ChallengeState) => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [tab, setTab] = useState<Tab>("market");
  const [sizeStr, setSizeStr] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [lev, setLev] = useState(5);
  const [limitStr, setLimitStr] = useState("");
  const [tpStr, setTpStr] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpOn, setTpOn] = useState(false);
  const [levOpen, setLevOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!levOpen) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".lev-wrap") && setLevOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [levOpen]);

  const cap = m?.maxLeverage ?? 10;
  const leverage = Math.min(lev, cap);
  const mark = m?.mark ?? 0;
  const size = Number(sizeStr) || 0;
  const limit = Number(limitStr) || 0;
  const entry = tab === "limit" && limit > 0 ? limit : mark;
  const notional = size * entry;
  const taker = rules?.fees.takerFeeRate ?? 0.00035;
  const maker = rules?.fees.makerFeeRate ?? 0.00005;
  const fee = notional * (tab === "limit" ? maker : taker);
  const slip = m && size > 0 && tab === "market" ? estSlippagePct(m, side, size) : 0;
  const long = side === "buy";
  const live = c.status === "active" && c.lifecycle === "active";
  const dead = !live;
  const untradable = m ? !m.tradable : false;

  const breach = useMemo(() => {
    if (!(size > 0) || !(entry > 0)) return undefined;
    const buffer = c.risk.bufferRemaining - fee;
    return breachPrice({ symbol, side: long ? "long" : "short", size, entryPrice: entry, markPrice: entry, notional, unrealizedPnl: 0 }, { bufferRemaining: buffer });
  }, [size, entry, c.risk.bufferRemaining, fee, long, notional, symbol]);

  const setSizeByPct = (p: number) => {
    setPct(p);
    setSizeStr(String(sizeForPct(p, c.account.equity, leverage, mark)));
  };
  const setLeverage = (l: number) => {
    setLev(l);
    if (pct !== null) setSizeStr(String(sizeForPct(pct, c.account.equity, Math.min(l, cap), mark)));
  };

  const tp = Number(tpStr) || 0;
  const tpBad = tp > 0 && (long ? tp <= entry : tp >= entry);
  const limitBad = tab === "limit" && !(limit > 0);
  const sizeBad = !(size > 0);
  const canSubmit = !busy && !dead && !untradable && !sizeBad && !limitBad && !tpBad && tab !== "stop" && Boolean(m);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.placeOrder(c.id, { symbol, side, size: roundSize(size, mark), type: tab === "limit" ? "limit" : "market", limitPrice: tab === "limit" ? limit : undefined, reduceOnly: reduceOnly || undefined });
      let state = res.state;
      if (!res.accepted) {
        setMsg({ ok: false, text: reasonText(res.reason) });
      } else {
        let text = res.fills.length ? `Filled ${num(res.fills.reduce((a, f) => a + f.size, 0), 4)} ${symbol} @ ${px(res.avgPrice ?? mark)}` : "Limit order resting on the book";
        if (tp > 0 && !tpBad && (res.fills.length > 0 || res.order)) {
          // Take-profit = a reduce-only limit on the other side. (Stop-loss orders are not in the engine yet.)
          const filled = res.fills.reduce((a, f) => a + f.size, 0) || size;
          const t = await api.placeOrder(c.id, { symbol, side: long ? "sell" : "buy", size: roundSize(filled, mark), type: "limit", limitPrice: tp, reduceOnly: true });
          state = t.state;
          text += t.accepted ? ` · TP set at ${px(tp)}` : ` · TP rejected: ${reasonText(t.reason)}`;
        }
        setMsg({ ok: true, text });
        setTpStr("");
      }
      onState(state);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const label = long ? "Buy / Long" : "Sell / Short";
  const pos = c.positions.find((p) => p.symbol === symbol);
  const pctNow = pct ?? 0;
  const margin = leverage > 0 ? notional / leverage : notional;
  return (
    <div className="panel tk" data-testid="order-ticket">
      <div className="tk-b">
        <div className="seg">
          <button type="button" className={`long ${long ? "on" : ""}`} onClick={() => setSide("buy")} data-testid="side-long">
            Buy / Long
          </button>
          <button type="button" className={`short ${!long ? "on" : ""}`} onClick={() => setSide("sell")} data-testid="side-short">
            Sell / Short
          </button>
        </div>
        <div className="tabs2">
          {(["limit", "market", "stop"] as const).map((k) => (
            <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className="tk-head">
          <div className="tk-row">
            <span>
              Cross margin
              <i className="tk-info" title="One margin pool per challenge account: every position shares the account's buffers.">i</i>
            </span>
            <span className="lev-wrap">
              <button type="button" className="lev-btn" aria-expanded={levOpen} onClick={() => setLevOpen((o) => !o)} data-testid="leverage">
                {leverage}×
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
              {levOpen && (
                <div className="lev-pop" role="dialog" aria-label="Leverage">
                  <div className="tk-row">
                    <span>Leverage</span>
                    <b className="rail-val">
                      {leverage}
                      <small>×</small>
                    </b>
                  </div>
                  <div className="rail" style={{ ["--p" as string]: `${cap > 1 ? ((leverage - 1) / (cap - 1)) * 100 : 0}%` }}>
                    <div className="rail-dots" aria-hidden="true">
                      <span />
                    </div>
                    <input className="range" type="range" min={1} max={cap} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} aria-label="Leverage" />
                  </div>
                  <div className="ticks">
                    <span>1×</span>
                    <span>{cap}×</span>
                  </div>
                </div>
              )}
            </span>
          </div>
          <div className="tk-row">
            <span>Available balance</span>
            <b>{usd(c.risk.bufferRemaining, 2)}</b>
          </div>
          <div className="tk-row">
            <span>Current position</span>
            <b className={pos ? (pos.side === "long" ? "up" : "dn") : ""}>
              {pos ? `${pos.side === "long" ? "" : "-"}${num(pos.size, 4)}` : "—"} {symbol}
            </b>
          </div>
        </div>
        {tab === "stop" ? (
          <p className="mute note">Stop orders are not in the simulator yet. Close a position by hand, or rely on the risk engine: it force-closes everything at the daily loss and drawdown limits.</p>
        ) : (
          <>
            {tab === "limit" && (
              <label className="inp">
                <input inputMode="decimal" value={limitStr} placeholder="Price" onChange={(e) => setLimitStr(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="limit-price" aria-label="Limit price" />
                <button type="button" className="inp-btn" onClick={() => m && setLimitStr(String(m.mid))}>
                  Mid
                </button>
              </label>
            )}
            <label className="inp">
              <input
                inputMode="decimal"
                value={sizeStr}
                placeholder="Size"
                aria-label="Size"
                onChange={(e) => {
                  setSizeStr(e.target.value.replace(/[^0-9.]/g, ""));
                  setPct(null);
                }}
                data-testid="size"
              />
              <span>{symbol}</span>
            </label>
            <div className="rail-row">
              <div className="rail" style={{ ["--p" as string]: `${pctNow * 100}%` }}>
                <div className="rail-dots" aria-hidden="true">
                  <span />
                </div>
                <input className="range" type="range" min={0} max={100} step={1} value={Math.round(pctNow * 100)} onChange={(e) => setSizeByPct(Number(e.target.value) / 100)} aria-label="Size as a share of buying power" data-testid="size-pct" />
              </div>
              <b className="rail-val">
                {Math.round(pctNow * 100)}
                <small>%</small>
              </b>
            </div>
            <label className="check">
              <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
              <span>Reduce only</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={tpOn}
                onChange={(e) => {
                  setTpOn(e.target.checked);
                  if (!e.target.checked) setTpStr("");
                }}
                data-testid="tp-toggle"
              />
              <span>Take profit / Stop loss</span>
            </label>
            {tpOn && (
              <div className="two">
                <label className="inp">
                  <input inputMode="decimal" value={tpStr} placeholder="TP price" onChange={(e) => setTpStr(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="tp" aria-label="Take profit price" />
                  <span>$</span>
                </label>
                <label className="inp off" title="Stop-loss orders are not supported by the simulator yet">
                  <input disabled placeholder="SL soon" aria-label="Stop loss price" />
                  <span>$</span>
                </label>
              </div>
            )}
            {tpBad && <div className="dn note">Take profit must be {long ? "above" : "below"} your entry.</div>}
          </>
        )}
        <button type="button" className="btn btn-fire tk-submit" disabled={!canSubmit} onClick={() => void submit()} data-testid="submit-order">
          {busy ? "Placing..." : dead ? "Challenge is not live" : untradable ? "Market closed" : `${label} ${symbol}`}
        </button>
        {untradable && m?.tradableReason && <div className="mute note">{m.tradableReason}</div>}
        {msg && (
          <div className={`note ${msg.ok ? "up" : "dn"}`} role="status" data-testid="order-msg">
            {msg.text}
          </div>
        )}
        <div className="est">
          <div title="Mark price where this position alone would end the challenge (equity reaches the breach floor)">
            <span>Breach price ≈</span>
            <b>{breach ? px(breach) : "—"}</b>
          </div>
          <div>
            <span>Order value</span>
            <b>{size > 0 ? usd(notional, 2) : "—"}</b>
          </div>
          <div>
            <span>Margin required ≈</span>
            <b>{size > 0 ? usd(margin, 2) : "—"}</b>
          </div>
          {tab === "market" && (
            <div>
              <span>Est. slippage</span>
              <b>{size > 0 ? `${num(slip, 2)}%` : "—"}</b>
            </div>
          )}
          <div>
            <span>
              Fees <small>maker / taker</small>
            </span>
            <b>
              {num(maker * 100, 3)}% / {num(taker * 100, 3)}%
            </b>
          </div>
        </div>
      </div>
    </div>
  );
}

const REASONS: Record<string, string> = {
  market_not_whitelisted: "That market is not tradable on Garuda.",
  feed_halted: "Trading in this market is halted: the price feed looks unhealthy.",
  stale_feed: "Market data is stale. Try again in a moment.",
  no_liquidity: "The book has no liquidity on that side right now.",
  "circuit_breaker:spread": "Paused: the spread is unusually wide.",
  "circuit_breaker:depth": "Paused: the book is too thin right now.",
  leverage_cap_exceeded: "That would exceed the leverage cap.",
  reduce_only_no_position: "Reduce-only needs an open position to reduce.",
  post_only_would_cross: "Post-only limit would cross the book.",
  invalid_size: "Enter a size above zero.",
};
const reasonText = (r?: string): string => {
  if (!r) return "Order rejected";
  if (r.startsWith("market_closed")) return "This market is closed right now.";
  return REASONS[r] ?? r.replace(/[_:]/g, " ");
};
