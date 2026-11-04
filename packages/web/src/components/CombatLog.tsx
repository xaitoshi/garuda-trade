import type { CombatEntry } from "../lib/types";
import { clock, dayLabel } from "../lib/format";

const ICON: Record<CombatEntry["kind"], string> = {
  scorch: "M8 1c1 3 4 4 4 8a4 4 0 01-8 0c0-2 1-3 2-4 0 2 1 2 1 2 1-2 1-4 1-6z",
  strike: "M13 2L5 10l-1 3 3-1 8-8zM3 13l1-3",
  advance: "M9 1L3 9h4l-1 6 7-9H9z",
  warning: "M8 1l7 13H1zM8 6v4M8 12v.5",
  breach: "M8 1c1 3 4 4 4 8a4 4 0 01-8 0c0-2 1-3 2-4 0 2 1 2 1 2 1-2 1-4 1-6z",
  pass: "M8 1l2 5 5 .5-4 3.5 1.2 5L8 12.3 3.8 15 5 10 1 6.5 6 6z",
  dawn: "M8 1l2 5 5 .5-4 3.5 1.2 5L8 12.3 3.8 15 5 10 1 6.5 6 6z",
  tribute: "M8 1l2 5 5 .5-4 3.5 1.2 5L8 12.3 3.8 15 5 10 1 6.5 6 6z",
};
const COLOR: Record<CombatEntry["kind"], string> = { scorch: "#ff5f6d", strike: "#3ddc97", advance: "#ffc24a", warning: "#ffc24a", breach: "#ff5f6d", pass: "#3ddc97", dawn: "#bbb4fb", tribute: "#bbb4fb" };
const STROKE = new Set<CombatEntry["kind"]>(["strike", "warning"]);

const AMOUNT = /[+-]?\$[\d,]+(?:\.\d+)?/;

function Body({ e }: { e: CombatEntry }) {
  // "Sir Pudding strikes for +$96 (SOL long closed)" -> headline + small detail line, amount coloured.
  const m = /^(.*?)(?: \((.*)\))?$/s.exec(e.text);
  const head = m?.[1] ?? e.text;
  const detail = m?.[2];
  const hit = (e.kind === "strike" || e.kind === "scorch") && AMOUNT.exec(head);
  return (
    <div>
      <div>
        {hit ? (
          <>
            {head.slice(0, hit.index)}
            <b className={e.kind === "strike" ? "up" : "dn"}>{hit[0]}</b>
            {head.slice(hit.index + hit[0].length)}
          </>
        ) : (
          head
        )}
      </div>
      {detail && <small>{detail}</small>}
    </div>
  );
}

/**
 * Newest first. Rows have a fixed height and the list scrolls in whole rows (scroll-snap), so a row is never cut in half
 * at the bottom edge (the mock clipped its last row).
 */
export function CombatLog({ entries, rows = 4 }: { entries: CombatEntry[]; rows?: number }) {
  const list = [...entries].reverse();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="panel logp" data-testid="combat-log">
      <div className="ph">
        <b>Combat log</b>
        <span className="chip">PnL feed</span>
      </div>
      <div className="lg-scroll" style={{ ["--rows" as string]: rows }}>
        {list.length === 0 && <div className="lg-empty mute">No fights yet. Place an order to start the battle.</div>}
        {list.map((e, i) => (
          <div className="lg" key={`${e.ts}-${i}`}>
            <span className="lt mono" title={dayLabel(e.ts)}>
              {new Date(e.ts).toISOString().slice(0, 10) === today ? clock(e.ts) : dayLabel(e.ts).slice(0, 6)}
            </span>
            <span className="li">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path d={ICON[e.kind]} fill={STROKE.has(e.kind) || e.kind === "strike" ? "none" : COLOR[e.kind]} stroke={STROKE.has(e.kind) ? COLOR[e.kind] : "none"} strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <Body e={e} />
          </div>
        ))}
      </div>
    </div>
  );
}
