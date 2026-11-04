import { useMemo, useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  const label = long ? "Long" : "Short";
  return (
    <div className="panel tk" data-testid="order-ticket">
      <div className="ph">
        <b>Order ticket</b>
        <span className="tag">{symbol}-PERP</span>
      </div>
      <div className="tk-b">
        <div className="seg">
          <button type="button" className={`long ${long ? "on" : ""}`} onClick={() => setSide("buy")} data-testid="side-long">
            Long
          </button>
          <button type="button" className={`short ${!long ? "on" : ""}`} onClick={() => setSide("sell")} data-testid="side-short">
            Short
          </button>
        </div>
        <div className="tabs2">
          {(["market", "limit", "stop"] as const).map((k) => (
            <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        {tab === "stop" ? (
          <p className="mute note">Stop orders are not in the simulator yet. Close a position by hand, or rely on the risk engine: it force-closes everything at the daily loss and drawdown limits.</p>
        ) : (
          <>
            {tab === "limit" && (
              <div className="fld">
                <div className="lbl">Limit price</div>
                <label className="inp">
                  <input inputMode="decimal" value={limitStr} placeholder={px(mark)} onChange={(e) => setLimitStr(e.target.value)} data-testid="limit-price" />
                  <span>$</span>
                </label>
              </div>
            )}
            <div className="fld">
              <div className="lbl">Size</div>
              <label className="inp">
                <input
                  inputMode="decimal"
                  value={sizeStr}
                  placeholder="0.00"
                  onChange={(e) => {
                    setSizeStr(e.target.value.replace(/[^0-9.]/g, ""));
                    setPct(null);
                  }}
                  data-testid="size"
                />
                <span>{symbol}</span>
              </label>
              <div className="sub">= {usd(notional, 2)} notional</div>
            </div>
            <div className="pcts">
              {[0.25, 0.5, 0.75, 1].map((p) => (
                <button type="button" key={p} className={pct === p ? "on" : ""} onClick={() => setSizeByPct(p)} data-testid={`pct-${p * 100}`}>
                  {p * 100}%
                </button>
              ))}
            </div>
            <div className="fld">
              <div className="lbl" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Leverage</span>
                <b className="mono" style={{ color: "var(--bone)" }}>
                  {leverage}x
                </b>
              </div>
              <input className="range" type="range" min={1} max={cap} step={1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} style={{ ["--p" as string]: `${cap > 1 ? ((leverage - 1) / (cap - 1)) * 100 : 0}%` }} aria-label="Leverage" />
              <div className="ticks mono">
                <span>1x</span>
                <span>{Math.round(cap / 2)}x</span>
                <span>{cap}x</span>
              </div>
            </div>
            <div className="two">
              <div className="fld">
                <div className="lbl">Take profit</div>
                <label className="inp">
                  <input inputMode="decimal" value={tpStr} placeholder="none" onChange={(e) => setTpStr(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="tp" />
                  <span>$</span>
                </label>
              </div>
              <div className="fld" title="Stop-loss orders are not supported by the simulator yet">
                <div className="lbl">Stop loss</div>
                <label className="inp off">
                  <input disabled placeholder="soon" />
                  <span>$</span>
                </label>
              </div>
            </div>
            {tpBad && <div className="dn note">Take profit must be {long ? "above" : "below"} your entry.</div>}
            <label className="tog">
              <span>Reduce-only</span>
              <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
              <u />
            </label>
            <div className="est">
              <div>
                <span>Margin</span>
                <b>{usd(leverage > 0 ? notional / leverage : notional, 2)}</b>
              </div>
              <div>
                <span>Est. fee ({tab === "limit" ? "maker" : "taker"})</span>
                <b>{usd(fee, 2)}</b>
              </div>
              <div>
                <span>Est. slippage</span>
                <b>{num(slip, 2)}%</b>
              </div>
              <div title="Mark price where this position alone would end the challenge (equity reaches the breach floor)">
                <span>Breach price</span>
                <b>{breach ? px(breach) : "-"}</b>
              </div>
            </div>
          </>
        )}
        <button type="button" className={`btn btn-fire ${long ? "" : "btn-short"}`} style={{ width: "100%", marginTop: 6 }} disabled={!canSubmit} onClick={() => void submit()} data-testid="submit-order">
          {busy ? "Placing..." : dead ? "Challenge is not live" : untradable ? "Market closed" : `${label} ${symbol}-PERP`}
        </button>
        {untradable && m?.tradableReason && <div className="mute note">{m.tradableReason}</div>}
        {msg && (
          <div className={`note ${msg.ok ? "up" : "dn"}`} role="status" data-testid="order-msg">
            {msg.text}
          </div>
        )}
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
