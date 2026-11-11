import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { FILTERS, groupKnights, matches, summary, type Filter, type KnightCard } from "../lib/barracks";
import { LEVELS, artState, knightView, type KnightLevel } from "../lib/knight";
import { dayLabel, pctSigned, usd } from "../lib/format";
import { Gate } from "../components/Gate";
import { KnightImg } from "../components/Art";

export function Barracks() {
  return (
    <Gate note="Your knights live in your wallet. Sign in to see them.">
      <BarracksView />
    </Gate>
  );
}

function BarracksView() {
  const { id } = useParams();
  const nav = useNavigate();
  const list = usePoll(() => api.challenges(), 8000, "barracks");
  const [filter, setFilter] = useState<Filter>("all");
  const cards = groupKnights(list.data ?? []);
  const sum = summary(cards);
  const shown = cards.filter((k) => matches(k, filter));
  const sel = cards.find((k) => k.c.id === id || k.key === id) ?? shown[0] ?? cards[0];

  if (list.loading) return <main className="pg-barracks"><div className="panel gate"><p className="mute">Loading your knights...</p></div></main>;
  if (cards.length === 0) {
    return (
      <main className="pg-barracks">
        <div className="panel gate dots">
          <KnightImg level={1} size={140} />
          <h2 className="pt">No knights yet.</h2>
          <p className="mute">Every paid challenge mints a knight. Try the free demo first, no knight needed.</p>
          <Link className="btn btn-fire" to="/challenges">See challenges</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="pg-barracks" data-testid="barracks">
      <div className="hd">
        <div>
          <div className="eyebrow">Barracks</div>
          <h1 className="pt">Your knights.</h1>
        </div>
        <div className="sum">
          <div><b>{sum.knights}</b><span>Knights</span></div>
          <div><b>{sum.active}</b><span>Active</span></div>
          <div><b>{sum.wounded}</b><span>Wounded</span></div>
          <div><b>{sum.funded}</b><span>Funded / Ascended</span></div>
        </div>
      </div>
      <div className="flt">
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${f === filter ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f[0]!.toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div className="lay">
        <div className="grid">
          {shown.length === 0 && <p className="mute">No knights match this filter.</p>}
          {shown.map((k) => (
            <Card key={k.key} k={k} selected={k.key === sel?.key} onPick={() => nav(`/barracks/${k.c.id}`, { replace: true })} />
          ))}
        </div>
        {sel && <Detail k={sel} />}
      </div>
    </main>
  );
}

const CLS: Record<string, string> = { wounded: "wd", ascended: "as", funded: "fd" };

function Card({ k, selected, onPick }: { k: KnightCard; selected: boolean; onPick: () => void }) {
  const v = knightView(k.c);
  return (
    <button className={`kc ${CLS[k.status] ?? ""} ${selected ? "sel" : ""}`} onClick={onPick} data-testid="knight-card">
      <div className="stage">
        <KnightImg level={v.level} state={artState(k.c)} fill alt="" />
      </div>
      <div className="top2">
        <span className={`st ${stClass(k.status)}`}>{k.status}</span>
        <span className="mono dim" style={{ fontSize: 11 }}>{k.idLabel}</span>
      </div>
      <div className="kc-foot">
        <div className="nm">{v.name}</div>
        <div className="mt">
          <span>{v.label}</span>
          <span>{v.demo ? "Demo" : k.c.stage === "funded" ? "Funded" : "Challenge"} · {usd(k.c.risk.startingBalance / 1000, k.c.risk.startingBalance % 1000 ? 1 : 0)}k</span>
        </div>
      </div>
    </button>
  );
}

const stClass = (s: string) => (s === "dormant" || s === "archived" || s === "passed" ? "active" : s);

function Detail({ k }: { k: KnightCard }) {
  const v = knightView(k.c);
  const wounded = k.status === "wounded";
  const notable = k.c.combatLog.filter((e) => ["advance", "warning", "breach", "pass"].includes(e.kind)).slice(-3).reverse();
  return (
    <div className="panel det" data-testid="knight-detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="mono dim" style={{ fontSize: 11 }}>{k.idLabel} · {v.label}</div>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-.04em" }}>{v.name}</div>
        </div>
        <span className={`st ${stClass(k.status)}`}>{k.status}</span>
      </div>
      <div className="dstage" style={{ marginTop: 14 }}>
        <KnightImg level={v.level} state={artState(k.c)} fill alt="" />
        <span className="slot-tag" style={{ left: 12, top: 12, zIndex: 2 }}>{artState(k.c)[0]!.toUpperCase() + artState(k.c).slice(1)}</span>
      </div>
      <div className="stats">
        <div><b>{k.battles}</b><span>Battles</span></div>
        <div><b>{k.bosses}</b><span>Bosses</span></div>
        <div><b className={(k.bestReturn ?? 0) >= 0 ? "up" : "dn"}>{k.bestReturn === undefined ? "-" : pctSigned(k.bestReturn)}</b><span>Best return</span></div>
        <div><b>$0</b><span>Payouts</span></div>
      </div>
      <div className="evo">
        {LEVELS.map((l, i) => (
          <span key={l.level} style={{ display: "contents" }}>
            <div className={l.level <= v.level ? "on" : ""}>
              <KnightImg level={l.level as KnightLevel} size={50} />
              <small>{l.name}</small>
            </div>
            {i < 3 && <i>›</i>}
          </span>
        ))}
      </div>
      <div className="bh">
        {notable.length === 0 && <div><span className="mute">No milestones yet.</span></div>}
        {notable.map((e, i) => (
          <div key={i}><span>{e.text.length > 64 ? `${e.text.slice(0, 62)}...` : e.text}</span><small>{dayLabel(e.ts).slice(0, 6)}</small></div>
        ))}
      </div>
      <div className="sc">
        <span className="tag">Scars · {k.c.scars}</span>
        {k.c.reviveOf && <span className="tag">Revived</span>}
        <span className="tag">{k.c.stage}</span>
        <span className="tag">{k.c.tier}</span>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <span className="btn btn-ghost btn-sm" aria-disabled style={{ opacity: 0.6 }}>Marketplace · soon</span>
        {wounded ? (
          <Link className="btn btn-fire btn-sm" style={{ flex: 1 }} to={`/revive/${k.c.id}`} data-testid="detail-revive">Revive</Link>
        ) : (
          <Link className="btn btn-fire btn-sm" style={{ flex: 1 }} to={`/terminal/${k.c.id}`} data-testid="detail-enter">Enter battle</Link>
        )}
      </div>
    </div>
  );
}
