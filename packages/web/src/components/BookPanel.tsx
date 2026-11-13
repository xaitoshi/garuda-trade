import { api } from "../lib/api";
import { POLL } from "../lib/config";
import { usePoll } from "../lib/hooks";
import { px } from "../lib/format";
import type { MarketView } from "../lib/types";

export type BookView = "book" | "trades";
const ROWS = 9;
const qty = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n >= 10 ? n.toFixed(2) : n.toFixed(3));
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

/**
 * PilotBot's book panel: the order book (asks above the spread, bids below, cumulative depth bars) and the recent
 * trades tape.
 */
export function BookPanel({ m, symbol, view, onView}: { m: MarketView | undefined; symbol: string; view: BookView; onView: (v: BookView) => void }) {
  const tape = usePoll(() => api.trades(symbol, 40), POLL.marketMs, symbol, view === "trades");
  const asks = (m?.book.asks ?? []).slice(0, ROWS);
  const bids = (m?.book.bids ?? []).slice(0, ROWS);
  const cum = (xs: [number, number][]) => { let t = 0; return xs.map(([p, q]) => [p, q, (t += q)] as const); };
  const a = cum(asks), b = cum(bids);
  const max = Math.max(a[a.length - 1]?.[2] ?? 0, b[b.length - 1]?.[2] ?? 0) || 1;
  const spread = m?.bestAsk !== undefined && m?.bestBid !== undefined ? m.bestAsk - m.bestBid : undefined;
  const row = (side: "ask" | "bid") => ([p, q, t]: readonly [number, number, number]) => (
    <div key={`${side}${p}`} className={`bk-row ${side}`} style={{ ["--d" as string]: `${(t / max) * 100}%` }}>
      <span>{px(p)}</span><span>{qty(q)}</span><span>{qty(t)}</span>
    </div>
  );
  return (
    <div className="panel bookp" data-testid="book-panel">
      <div className="tabs2 bk-tabs">
        <button className={view === "book" ? "on" : ""} onClick={() => onView("book")}>Order Book</button>
        <button className={view === "trades" ? "on" : ""} onClick={() => onView("trades")}>Recent Trades</button>
      </div>
      {view === "book" ? (
        <div className="bk">
          <div className="bk-hd"><span>Price</span><span>Size</span><span>Total</span></div>
          <div className="bk-side asks">{[...a].reverse().map(row("ask"))}</div>
          <div className="bk-mid">
            <b>{m ? px(m.mid) : "—"}</b>
            <span>Spread {spread !== undefined ? `${spread < 1 ? spread.toFixed(4) : px(spread)} · ${((spread / m!.mid) * 100).toFixed(3)}%` : "—"}</span>
          </div>
          <div className="bk-side bids">{b.map(row("bid"))}</div>
        </div>
      ) : (
        <div className="bk">
          <div className="bk-hd"><span>Price</span><span>Size</span><span>Time</span></div>
          <div className="bk-tape">
            {(tape.data?.trades ?? []).map((t, i) => (
              <div key={`${t.time}-${i}`} className={`bk-tr ${t.side}`}><span>{px(t.price)}</span><span>{qty(t.size)}</span><span>{clock(t.time)}</span></div>
            ))}
            {tape.data && !tape.data.trades.length && <div className="bk-empty">No recent trades</div>}
            {!tape.data && <div className="bk-empty">Loading trades...</div>}
          </div>
          {tape.data?.source === "synthetic" && <div className="bk-src">synthetic tape · offline replay</div>}
        </div>
      )}
    </div>
  );
}
