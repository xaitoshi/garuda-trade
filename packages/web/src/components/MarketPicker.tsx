import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import { px } from "../lib/format";
import { TOKEN_ICONS } from "../lib/tokens";
import type { MarketView } from "../lib/types";

/** Deterministic hue so a ticker without artwork keeps the same monogram colour everywhere (Pilot's fallback). */
const hue = (s: string) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 360;
};

export function TokenIcon({ symbol, size = 26 }: { symbol: string; size?: number }) {
  const file = TOKEN_ICONS[symbol];
  const [state, setState] = useState<"loading" | "loaded" | "failed">(file ? "loading" : "failed");
  const mono = state === "failed";
  return (
    <span className={`tok ${state === "loaded" ? "is-loaded" : ""}`} data-mono={mono || undefined} style={{ width: size, height: size, ...(mono ? ({ "--tok-hue": hue(symbol) } as CSSProperties) : {}) }} aria-hidden="true">
      {state !== "loaded" && <span className="tok-fb">{symbol.slice(0, 3)}</span>}
      {file && !mono && <img src={`/tokens/${file}`} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} onLoad={() => setState("loaded")} onError={() => setState("failed")} />}
    </span>
  );
}

type Row = { symbol: string; class: string; maxLeverage: number };
const GROUPS: { id: string; label: string; test: (c: string) => boolean }[] = [
  { id: "crypto", label: "Crypto", test: (c) => c.endsWith("crypto") },
  { id: "stocks", label: "Stocks", test: (c) => c === "equity" || c.startsWith("index") },
  { id: "commodities", label: "Commodities", test: (c) => c.startsWith("commodity") },
];

/** The market strip button: token, symbol, leverage badge and a chevron, opening the markets dialog. */
export function MarketButton({ symbol, maxLeverage, onOpen }: { symbol: string; maxLeverage?: number; onOpen: () => void }) {
  return (
    <button type="button" className="mkt-btn" onClick={onOpen} aria-haspopup="dialog" data-testid="market-picker">
      <TokenIcon symbol={symbol} size={30} />
      <span className="mkt-name">
        <b>{symbol}-PERP</b>
        {maxLeverage ? <small>{maxLeverage}×</small> : null}
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

export function MarketPicker({ markets, current, onPick, onClose }: { markets: Row[]; current: string; onPick: (s: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(() => GROUPS.find((g) => g.test(markets.find((m) => m.symbol === current)?.class ?? ""))?.id ?? "crypto");
  const [views, setViews] = useState<Record<string, MarketView>>({});

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (needle) return markets.filter((m) => m.symbol.includes(needle));
    const g = GROUPS.find((x) => x.id === group)!;
    return markets.filter((m) => g.test(m.class));
  }, [markets, q, group]);

  // Prices for the visible rows, fetched once per row while the dialog is open.
  useEffect(() => {
    let live = true;
    for (const r of rows) {
      if (views[r.symbol]) continue;
      api
        .market(r.symbol, 1)
        .then((v) => live && setViews((p) => ({ ...p, [r.symbol]: v })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const pick = (s: string) => {
    onPick(s);
    ref.current?.close();
  };

  return (
    <dialog ref={ref} className="mkt-modal" aria-label="Markets" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header className="mkt-head">
        <h2>Markets</h2>
        <button type="button" className="mkt-x" aria-label="Close markets" onClick={() => ref.current?.close()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div className="mkt-body">
        <div className="mkt-tools">
          <label className="mkt-search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.8" />
              <path d="m16 16 4.5 4.5" />
            </svg>
            <input autoFocus placeholder="Search markets" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg2 mkt-groups">
            {GROUPS.map((g) => (
              <button type="button" key={g.id} className={!q && group === g.id ? "on" : ""} onClick={() => (setQ(""), setGroup(g.id))}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mkt-table">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th className="r">Price</th>
                <th className="r">Spread</th>
                <th className="r">Funding 1h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = views[r.symbol];
                const spread = v?.bestBid && v?.bestAsk ? ((v.bestAsk - v.bestBid) / v.mid) * 10_000 : undefined;
                return (
                  <tr key={r.symbol} data-selected={r.symbol === current} onClick={() => pick(r.symbol)} data-testid={`mk-${r.symbol}`}>
                    <td>
                      <span className="mkt-row">
                        <TokenIcon symbol={r.symbol} />
                        <b>{r.symbol}-PERP</b>
                        <small>{r.maxLeverage}×</small>
                      </span>
                    </td>
                    <td className="r">{v ? px(v.mark) : "—"}</td>
                    <td className="r">{spread !== undefined ? `${spread.toFixed(2)} bps` : "—"}</td>
                    <td className={`r ${v ? (v.fundingRateHourly >= 0 ? "up" : "dn") : ""}`}>{v ? `${v.fundingRateHourly >= 0 ? "+" : ""}${(v.fundingRateHourly * 100).toFixed(4)}%` : "—"}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="mute" style={{ textAlign: "center", padding: 28 }}>
                    No markets match "{q}"
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}
