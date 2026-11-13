import { useState } from "react";
import { api, errorText } from "../lib/api";
import type { ChallengeState, Order } from "../lib/types";
import { TokenIcon } from "./MarketPicker";
import { ClosePosition } from "./ClosePosition";
import { ProtectPosition, protectionOf } from "./ProtectPosition";
import { useSession } from "../lib/session";
import { clock, num, pctSigned, px, usd, usdSigned } from "../lib/format";

type Tab = "positions" | "orders" | "history" | "balances";

export function PositionsPanel({ c, onState, reload }: { c: ChallengeState; onState: (s: ChallengeState) => void; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("positions");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = c.status === "active" && c.lifecycle === "active";
  const { rules } = useSession();
  const [closing, setClosing] = useState<{ symbol: string; type: "market" | "limit" } | null>(null);
  const closingPos = closing ? c.positions.find((x) => x.symbol === closing.symbol) : undefined;
  const [protecting, setProtecting] = useState<string | null>(null);
  const protectPos = protecting ? c.positions.find((x) => x.symbol === protecting) : undefined;

  async function cancel(o: Order) {
    setBusy(o.id);
    setErr(null);
    try {
      await api.cancelOrder(c.id, o.id);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const tag = (o: Order): string => {
    const p = c.positions.find((x) => x.symbol === o.symbol);
    if (o.type === "stop") return o.reduceOnly ? "SL" : "STOP";
    if (o.reduceOnly && p && o.limitPrice) {
      const closes = (p.side === "long") === (o.side === "sell");
      if (closes) return (p.side === "long" ? o.limitPrice > p.markPrice : o.limitPrice < p.markPrice) ? "TP" : "SL";
    }
    return o.reduceOnly ? "RO" : "LMT";
  };

  return (
    <div className="panel" data-testid="positions-panel">
      {closing && closingPos && (
        <ClosePosition
          key={closing.symbol + closing.type}
          c={c}
          p={closingPos}
          initial={closing.type}
          fees={{ maker: rules?.fees.makerFeeRate ?? 0.00005, taker: rules?.fees.takerFeeRate ?? 0.00035 }}
          onClose={() => setClosing(null)}
          onDone={(st) => (st ? onState(st) : void reload())}
        />
      )}
      {protectPos && <ProtectPosition key={protectPos.symbol} c={c} p={protectPos} onClose={() => setProtecting(null)} onDone={reload} />}
      <div className="tb">
        <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>
          Positions<em>{c.positions.length}</em>
        </button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>
          Open orders<em>{c.openOrders.length}</em>
        </button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          History
        </button>
        <button className={tab === "balances" ? "on" : ""} onClick={() => setTab("balances")}>
          Balances
        </button>
      </div>
      {err && <div className="dn note" style={{ padding: "8px 18px" }}>{err}</div>}
      <div className="tbl-scroll">
        {tab === "positions" && (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Breach</th>
                <th>uPnL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.positions.length === 0 && (
                <tr>
                  <td colSpan={8} className="mute">No open positions.</td>
                </tr>
              )}
              {c.positions.map((p) => {
                const breach = Math.max(0, p.markPrice - (p.side === "long" ? 1 : -1) * (c.risk.bufferRemaining / p.size));
                return (
                  <tr key={p.symbol}>
                    <td>
                      <span className="pos-mkt"><TokenIcon symbol={p.symbol} size={22} /><b>{p.symbol}-PERP</b>{p.leverageCap && <span className="tag">{p.leverageCap}x cap</span>}</span>
                    </td>
                    <td className={p.side === "long" ? "up" : "dn"}>{p.side === "long" ? "Long" : "Short"}</td>
                    <td>{num(p.size, 4)}</td>
                    <td>{px(p.entryPrice)}</td>
                    <td>{px(p.markPrice)}</td>
                    <td>{px(breach)}</td>
                    <td className={p.unrealizedPnl >= 0 ? "up" : "dn"}>
                      <b>{usdSigned(p.unrealizedPnl, 2)}</b>
                      {p.entryPrice * p.size > 0 && <small className="upnl-pct">{pctSigned(p.unrealizedPnl / (p.entryPrice * p.size), 2)}</small>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="pos-acts">
                        {(() => {
                          const pr = protectionOf(c, p);
                          return (
                            <button className={`chip prot-chip${pr.tp || pr.sl ? " set" : ""}`} disabled={!live} onClick={() => setProtecting(p.symbol)} data-testid={`tpsl-${p.symbol}`} title="Take profit / stop loss">
                              {pr.tp || pr.sl ? <>{pr.tp ? <span className="up">{px(pr.tp.limitPrice!)}</span> : "–"} / {pr.sl ? <span className="dn">{px(pr.sl.triggerPrice!)}</span> : "–"}</> : "TP/SL"}
                            </button>
                          );
                        })()}
                        <button className="chip" disabled={!live} onClick={() => setClosing({ symbol: p.symbol, type: "limit" })} data-testid={`limit-close-${p.symbol}`}>Limit</button>
                        <button className="chip" disabled={!live} onClick={() => setClosing({ symbol: p.symbol, type: "market" })} data-testid={`close-${p.symbol}`}>Market</button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {c.openOrders.map((o) => (
                <tr className="sub" key={o.id}>
                  <td>
                    <span className="pos-mkt"><TokenIcon symbol={o.symbol} size={20} />{o.symbol}-PERP <span className="tag">{tag(o)}</span></span>
                  </td>
                  <td>{o.side === "buy" ? "Buy" : "Sell"}</td>
                  <td>{num(o.remaining, 4)}</td>
                  <td>{o.limitPrice ? px(o.limitPrice) : o.triggerPrice ? `at ${px(o.triggerPrice)}` : "-"}</td>
                  <td colSpan={3}>{o.reduceOnly ? "Reduce-only" : "Limit"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="linkbtn" disabled={busy === o.id} onClick={() => void cancel(o)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "orders" && (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Type</th>
                <th>Size</th>
                <th>Price</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.openOrders.length === 0 && (
                <tr>
                  <td colSpan={7} className="mute">No resting orders.</td>
                </tr>
              )}
              {c.openOrders.map((o) => (
                <tr key={o.id}>
                  <td><span className="pos-mkt"><TokenIcon symbol={o.symbol} size={20} />{o.symbol}-PERP</span></td>
                  <td>{o.side === "buy" ? "Buy" : "Sell"}</td>
                  <td>{o.type}</td>
                  <td>{num(o.remaining, 4)}</td>
                  <td>{o.limitPrice ? px(o.limitPrice) : "market"}</td>
                  <td>
                    <span className="tag">{tag(o)}</span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="linkbtn" disabled={busy === o.id} onClick={() => void cancel(o)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "history" && (
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Market</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Fee</th>
                <th>Realised</th>
              </tr>
            </thead>
            <tbody>
              {c.recentFills.length === 0 && (
                <tr>
                  <td colSpan={7} className="mute">No fills yet.</td>
                </tr>
              )}
              {[...c.recentFills].reverse().map((f) => (
                <tr key={f.id}>
                  <td className="mono">{clock(f.ts)}</td>
                  <td><span className="pos-mkt"><TokenIcon symbol={f.symbol} size={20} />{f.symbol}-PERP {f.forced && <span className="tag dn">Forced</span>}</span></td>
                  <td className={f.side === "buy" ? "up" : "dn"}>{f.side === "buy" ? "Buy" : "Sell"}</td>
                  <td>{num(f.size, 4)}</td>
                  <td>{px(f.price)}</td>
                  <td>{usd(f.fee, 2)}</td>
                  <td className={f.realizedPnl >= 0 ? "up" : "dn"}>{f.realizedPnl === 0 ? "-" : usdSigned(f.realizedPnl, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "balances" && (
          <table>
            <tbody>
              {(
                [
                  ["Starting balance", usd(c.account.startingBalance, 2)],
                  ["Balance (realised)", usd(c.account.balance, 2)],
                  ["Equity", usd(c.account.equity, 2)],
                  ["Realised PnL", usdSigned(c.account.realizedPnl, 2)],
                  ["Unrealised PnL", usdSigned(c.account.unrealizedPnl, 2)],
                  ["Fees paid", usd(c.account.feesPaid, 2)],
                  ["Funding paid", usd(c.account.fundingPaid, 2)],
                  ["Margin in use", usd(c.account.requiredMargin, 2)],
                  ["Gross notional", usd(c.account.grossNotional, 2)],
                ] as const
              ).map(([k, v]) => (
                <tr key={k}>
                  <td className="mute">{k}</td>
                  <td style={{ textAlign: "right" }}>
                    <b>{v}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
