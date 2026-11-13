import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../lib/api";
import { px, usd } from "../lib/format";
import { roundSize } from "../lib/trade";
import type { ChallengeState, Position } from "../lib/types";
import { TokenIcon } from "./MarketPicker";

/** Price step for the +/- buttons, matching how prices are shown: BTC 1, SOL 0.01, small coins 0.0001. */
const tick = (p: number) => (p >= 1000 ? 1 : p >= 1 ? 0.01 : 0.0001);
const roundTick = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(Math.max(0, -Math.floor(Math.log10(step)))));

/**
 * Close a position, PilotBot style: market or limit, any part of it (25/50/75/100% or a typed size), always
 * reduce-only. A limit close rests on the book and shows on the chart like any other order.
 */
export function ClosePosition({ c, p, initial, fees, onClose, onDone }: {
  c: ChallengeState;
  p: Position;
  initial: "market" | "limit";
  fees: { maker: number; taker: number };
  onClose: () => void;
  onDone: (s?: ChallengeState) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState(initial);
  const step = tick(p.markPrice);
  const [price, setPrice] = useState(String(roundTick(p.markPrice, step)));
  const [pct, setPct] = useState<number | null>(100);
  const [sizeStr, setSizeStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void ref.current?.showModal(), []);

  const buy = p.side === "short"; // closing a short buys it back
  const limit = Number(price) || 0;
  const size = pct !== null ? roundSize((p.size * pct) / 100, p.markPrice) || (pct === 100 ? p.size : 0) : Number(sizeStr) || 0;
  const qty = pct === 100 ? p.size : Math.min(size, p.size);
  const ref$ = type === "limit" ? limit : p.markPrice;
  const value = qty * ref$;
  const pnl = (buy ? p.entryPrice - ref$ : ref$ - p.entryPrice) * qty;
  const wrongSide = type === "limit" && limit > 0 && (buy ? limit > p.markPrice * 1.5 : limit < p.markPrice * 0.5);
  const valid = qty > 0 && qty <= p.size + 1e-12 && (type === "market" || limit > 0) && !wrongSide;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.placeOrder(c.id, { symbol: p.symbol, side: buy ? "buy" : "sell", size: qty, type, limitPrice: type === "limit" ? limit : undefined, reduceOnly: true });
      if (!res.accepted) {
        setErr((res.reason ?? "rejected").replace(/[_:]/g, " "));
        onDone(res.state);
        return;
      }
      onDone(res.state);
      ref.current?.close();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className={`mkt-modal close-modal ${buy ? "close-buy" : "close-sell"}`} aria-label={`Close ${p.symbol} position`} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header className="mkt-head">
        <h2><TokenIcon symbol={p.symbol} size={22} /> Close {p.symbol} position</h2>
        <button type="button" className="mkt-x" aria-label="Close" onClick={() => ref.current?.close()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </header>
      <fieldset className="close-body" disabled={busy}>
        <div className="seg2 close-tabs">
          {(["market", "limit"] as const).map((t) => (
            <button key={t} type="button" className={type === t ? "on" : ""} onClick={() => setType(t)}>{t === "market" ? "Market" : "Limit"}</button>
          ))}
        </div>
        <dl className="close-sum">
          <div><dt>Side</dt><dd className="close-side">{buy ? "Buy" : "Sell"}</dd></div>
          <div><dt>Current position</dt><dd>{p.size} {p.symbol}</dd></div>
        </dl>
        {type === "limit" && (
          <div className="close-in">
            <input aria-label="Close limit price" inputMode="decimal" placeholder="Limit price" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
            <button type="button" aria-label="Lower price" onClick={() => setPrice(String(roundTick(limit - step, step)))}>−</button>
            <button type="button" onClick={() => setPrice(String(roundTick(p.markPrice, step)))}>Mid</button>
            <button type="button" aria-label="Raise price" onClick={() => setPrice(String(roundTick(limit + step, step)))}>+</button>
          </div>
        )}
        <div className="close-in">
          <input aria-label="Size to close" inputMode="decimal" value={pct !== null ? String(qty) : sizeStr} onChange={(e) => { setPct(null); setSizeStr(e.target.value.replace(/[^0-9.]/g, "")); }} />
          <span className="close-unit">{p.symbol}</span>
        </div>
        <div className="close-pcts">
          {[25, 50, 75, 100].map((v) => (
            <button key={v} type="button" className={pct === v ? "on" : ""} onClick={() => setPct(v)}>{v}%</button>
          ))}
        </div>
        <div className="close-opts"><label><input type="checkbox" checked disabled /> Reduce only</label>{type === "limit" && <span>TIF <b>GTC</b></span>}</div>
        <dl className="close-sum close-tot">
          <div><dt>{type === "limit" ? "Limit price" : "Est. price"}</dt><dd className="close-side">{ref$ > 0 ? px(ref$) : "—"}</dd></div>
          <div><dt>Order value</dt><dd>{value > 0 ? usd(value, 2) : "—"}</dd></div>
          <div><dt>PnL at this price ≈</dt><dd className={pnl >= 0 ? "up" : "dn"}>{qty > 0 && ref$ > 0 ? `${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl), 2)}` : "—"}</dd></div>
          <div><dt>Fees <small>maker / taker</small></dt><dd>{(fees.maker * 100).toFixed(3)}% / {(fees.taker * 100).toFixed(3)}%</dd></div>
        </dl>
        {qty > p.size + 1e-12 && <p className="close-note">More than the open position.</p>}
        {err && <p className="close-note dn" role="alert">{err}</p>}
      </fieldset>
      <footer className="close-foot">
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-fire" onClick={() => void submit()} disabled={!valid || busy} data-testid="close-confirm">{busy ? "Submitting..." : type === "limit" ? "Place limit close" : "Close now"}</button>
      </footer>
    </dialog>
  );
}
