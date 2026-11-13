import { useState } from "react";
import type { MarketView } from "../lib/types";
import { px } from "../lib/format";

const KEY = "garuda.favorites";
const read = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : ["SOL"]; } catch { return ["SOL"]; }
};

/** PilotBot's favourites row: a star for the current market, then the pinned markets to switch between. */
export function MarketFavorites({ symbol, markets, onPick }: { symbol: string; markets: string[]; onPick: (s: string) => void }) {
  const [favs, setFavs] = useState(read);
  const on = favs.includes(symbol);
  const toggle = () => {
    const next = on ? favs.filter((f) => f !== symbol) : [...favs, symbol];
    setFavs(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const list = favs.filter((f) => markets.length === 0 || markets.includes(f));
  return (
    <div className="mkt-favs">
      <button type="button" className="mkt-fav-star" aria-pressed={on} aria-label={on ? "Remove from favorites" : "Add to favorites"} onClick={toggle}>{on ? "★" : "☆"}</button>
      <div className="mkt-fav-list">
        {list.map((f) => (
          <button type="button" key={f} aria-pressed={f === symbol} onClick={() => onPick(f)}>{f}<span>-PERP</span></button>
        ))}
        {!list.length && <span className="mkt-fav-hint">Star a market to pin it here</span>}
      </div>
    </div>
  );
}

/** Mark, book and funding next to the price, scrolling sideways on phones. */
export function MarketStats({ m }: { m: MarketView | undefined }) {
  const f = m?.fundingRateHourly;
  return (
    <dl className="mkt-stats">
      <div><dt>Mark</dt><dd>{m ? px(m.mark) : "—"}</dd></div>
      <div><dt>Bid</dt><dd>{m?.bestBid !== undefined ? px(m.bestBid) : "—"}</dd></div>
      <div><dt>Ask</dt><dd>{m?.bestAsk !== undefined ? px(m.bestAsk) : "—"}</dd></div>
      <div><dt>Funding 1h</dt><dd className={f === undefined ? "" : f >= 0 ? "up" : "dn"}>{f === undefined ? "—" : `${(f * 100).toFixed(4)}%`}</dd></div>
    </dl>
  );
}
