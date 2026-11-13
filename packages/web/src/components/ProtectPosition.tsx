import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../lib/api";
import { px, usd } from "../lib/format";
import type { ChallengeState, Order, Position } from "../lib/types";
import { TokenIcon } from "./MarketPicker";

/** The position's current take-profit (reduce-only limit beyond the mark) and stop-loss (reduce-only stop). */
export function protectionOf(c: ChallengeState, p: Position): { tp?: Order; sl?: Order } {
  const exit = p.side === "long" ? "sell" : "buy";
  const mine = c.openOrders.filter((o) => o.symbol === p.symbol && o.reduceOnly && o.side === exit);
  return {
    tp: mine.find((o) => o.type === "limit" && o.limitPrice !== undefined && (p.side === "long" ? o.limitPrice > p.markPrice : o.limitPrice < p.markPrice)),
    sl: mine.find((o) => o.type === "stop"),
  };
}

/**
 * Set or change a position's TP and SL, PilotBot style: a price or a % move from entry for each, with the PnL it
 * locks in. Saving places the new orders first and only then cancels the ones they replace. TP and SL act as a pair:
 * whichever closes the position takes the other with it.
 */
export function ProtectPosition({ c, p, onClose, onDone }: { c: ChallengeState; p: Position; onClose: () => void; onDone: () => Promise<void> | void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cur = protectionOf(c, p);
  const [tpStr, setTpStr] = useState(cur.tp?.limitPrice ? String(cur.tp.limitPrice) : "");
  const [slStr, setSlStr] = useState(cur.sl?.triggerPrice ? String(cur.sl.triggerPrice) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void ref.current?.showModal(), []);

  const long = p.side === "long";
  const tp = Number(tpStr) || 0;
  const sl = Number(slStr) || 0;
  const tpBad = tp > 0 && (long ? tp <= p.markPrice : tp >= p.markPrice);
  const slBad = sl > 0 && (long ? sl >= p.markPrice : sl <= p.markPrice);
  const pnlAt = (x: number) => (long ? x - p.entryPrice : p.entryPrice - x) * p.size;
  const pctAt = (x: number) => ((long ? x - p.entryPrice : p.entryPrice - x) / p.entryPrice) * 100;
  const setByPct = (which: "tp" | "sl", pct: number) => {
    const move = ((which === "tp" ? 1 : -1) * pct) / 100;
    const price = p.entryPrice * (1 + (long ? move : -move));
    (which === "tp" ? setTpStr : setSlStr)(px(price).replace(/,/g, ""));
  };
  const changed = (tp || 0) !== (cur.tp?.limitPrice ?? 0) || (sl || 0) !== (cur.sl?.triggerPrice ?? 0);

  async function save() {
    if (busy || tpBad || slBad) return;
    setBusy(true);
    setErr(null);
    const exit = long ? "sell" : "buy";
    try {
      if (tp !== (cur.tp?.limitPrice ?? 0)) {
        if (tp > 0) {
          const r = await api.placeOrder(c.id, { symbol: p.symbol, side: exit, size: p.size, type: "limit", limitPrice: tp, reduceOnly: true });
          if (!r.accepted) throw new Error(`Take-profit: ${(r.reason ?? "rejected").replace(/[_:]/g, " ")}`);
        }
        if (cur.tp) await api.cancelOrder(c.id, cur.tp.id);
      }
      if (sl !== (cur.sl?.triggerPrice ?? 0)) {
        if (sl > 0) {
          const r = await api.placeOrder(c.id, { symbol: p.symbol, side: exit, size: p.size, type: "stop", triggerPrice: sl, reduceOnly: true });
          if (!r.accepted) throw new Error(`Stop-loss: ${(r.reason ?? "rejected").replace(/[_:]/g, " ")}`);
        }
        if (cur.sl) await api.cancelOrder(c.id, cur.sl.id);
      }
      await onDone();
      ref.current?.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : errorText(e));
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  const row = (which: "tp" | "sl") => {
    const v = which === "tp" ? tp : sl;
    const bad = which === "tp" ? tpBad : slBad;
    return (
      <div className="prot-row">
        <div className="prot-hd">
          <span>{which === "tp" ? "Take profit" : "Stop loss"}</span>
          {v > 0 && !bad && <b className={pnlAt(v) >= 0 ? "up" : "dn"}>{pnlAt(v) >= 0 ? "+" : "-"}{usd(Math.abs(pnlAt(v)), 2)} · {pctAt(v) >= 0 ? "+" : ""}{pctAt(v).toFixed(2)}%</b>}
        </div>
        <div className="close-in">
          <input inputMode="decimal" placeholder={which === "tp" ? (long ? "Price above mark" : "Price below mark") : long ? "Trigger below mark" : "Trigger above mark"} value={which === "tp" ? tpStr : slStr}
            onChange={(e) => (which === "tp" ? setTpStr : setSlStr)(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={which === "tp" ? "Take profit price" : "Stop loss trigger"} data-testid={`prot-${which}`} />
          {v > 0 && <button type="button" onClick={() => (which === "tp" ? setTpStr : setSlStr)("")}>Clear</button>}
        </div>
        <div className="close-pcts">
          {[1, 2, 5, 10].map((n) => (
            <button key={n} type="button" onClick={() => setByPct(which, n)}>{which === "tp" ? "+" : "-"}{n}%</button>
          ))}
        </div>
        {bad && <p className="close-note dn">{which === "tp" ? `Take profit must be ${long ? "above" : "below"} the mark.` : `Stop loss must be ${long ? "below" : "above"} the mark.`}</p>}
      </div>
    );
  };

  return (
    <dialog ref={ref} className="mkt-modal close-modal prot-modal" aria-label={`${p.symbol} take profit and stop loss`} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header className="mkt-head">
        <h2><TokenIcon symbol={p.symbol} size={22} /> TP / SL · {p.symbol}</h2>
        <button type="button" className="mkt-x" aria-label="Close" onClick={() => ref.current?.close()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </header>
      <fieldset className="close-body" disabled={busy}>
        <dl className="close-sum">
          <div><dt>Position</dt><dd className={long ? "up" : "dn"}>{long ? "Long" : "Short"} {p.size} {p.symbol}</dd></div>
          <div><dt>Entry / mark</dt><dd>{px(p.entryPrice)} / {px(p.markPrice)}</dd></div>
        </dl>
        {row("tp")}
        {row("sl")}
        <p className="close-note">Both close the whole position. When one fills, the other is cancelled. The stop fills as a market order once the mark reaches it.</p>
        {err && <p className="close-note dn" role="alert">{err}</p>}
      </fieldset>
      <footer className="close-foot">
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-fire" onClick={() => void save()} disabled={busy || tpBad || slBad || !changed} data-testid="prot-save">{busy ? "Saving..." : "Save"}</button>
      </footer>
    </dialog>
  );
}
