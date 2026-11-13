import type { CSSProperties } from "react";
import { ChartLoader } from "./ChartLoader";

/** One shimmering placeholder block. */
export const Sk = ({ w = "100%", h = 14, r, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) => (
  <span className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />
);

/** Rows of label / value placeholders, the shape of the key-value lists on the account panels. */
export const SkRows = ({ n = 4 }: { n?: number }) => (
  <div className="sk-rows">
    {Array.from({ length: n }, (_, i) => (
      <div key={i}>
        <Sk w={`${34 + ((i * 17) % 30)}%`} h={12} />
        <Sk w={`${18 + ((i * 11) % 16)}%`} h={12} />
      </div>
    ))}
  </div>
);

/**
 * A page-shaped placeholder while its data loads, so the layout is there at once and nothing jumps when it arrives.
 * `terminal`: market strip, chart (with the Garuda loader), ticket and positions. `cards`: a header and a card grid.
 */
export function PageSkeleton({ kind, note }: { kind: "terminal" | "cards"; note?: string }) {
  if (kind === "terminal") {
    return (
      <main className="pg-terminal sk-page" aria-busy="true" aria-label={note ?? "Loading"}>
        <div className="sk-term">
          <div className="sk-main">
            <div className="panel sk-strip">
              <Sk w={40} h={40} r={999} />
              <div className="sk-col"><Sk w={110} h={16} /><Sk w={44} h={12} /></div>
              <div className="sk-col"><Sk w={96} h={22} /><Sk w={52} h={12} /></div>
              <div className="sk-stats">
                {[0, 1, 2, 3].map((i) => <div className="sk-col" key={i}><Sk w={38} h={10} /><Sk w={64} h={14} /></div>)}
              </div>
            </div>
            <div className="panel sk-chart">
              <ChartLoader loading />
            </div>
          </div>
          <div className="panel sk-ticket">
            <Sk h={44} r={12} />
            <div className="sk-line"><Sk w={52} h={14} /><Sk w={60} h={14} /><Sk w={44} h={14} /></div>
            <SkRows n={2} />
            <Sk h={48} r={12} />
            <Sk h={48} r={12} />
            <Sk h={46} r={999} />
            <SkRows n={4} />
          </div>
        </div>
        <div className="panel sk-pos">
          <div className="sk-line"><Sk w={80} h={14} /><Sk w={90} h={14} /><Sk w={60} h={14} /></div>
          <Sk h={40} r={10} />
          <Sk h={40} r={10} />
        </div>
        {note && <p className="sk-note mute" data-testid="challenge-loading">{note}</p>}
      </main>
    );
  }
  return (
    <main className="sk-page" aria-busy="true" aria-label={note ?? "Loading"}>
      <div className="sk-head">
        <Sk w={70} h={12} />
        <Sk w={260} h={40} style={{ maxWidth: "80%" }} />
        <Sk w={380} h={14} style={{ maxWidth: "95%" }} />
      </div>
      <div className="sk-cards">
        {[0, 1, 2].map((i) => (
          <div className="panel sk-card" key={i}>
            <Sk w={120} h={120} r={999} style={{ alignSelf: "center" }} />
            <Sk w="60%" h={18} />
            <SkRows n={3} />
            <Sk h={42} r={999} />
          </div>
        ))}
      </div>
      {note && <p className="sk-note mute">{note}</p>}
    </main>
  );
}
