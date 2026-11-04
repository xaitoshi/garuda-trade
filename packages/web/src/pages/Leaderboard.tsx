import { Link } from "react-router-dom";
import { KnightImg } from "../components/Art";
import type { KnightLevel } from "../lib/knight";
import { useState } from "react";

/** Sample rows only: the API has no leaderboard yet. The page says so on its face. */
const ROWS: [number, string, KnightLevel, string, number, number, number, string][] = [
  [1, "0xDragonSlayer", 4, "Ascended", 38.2, 9, 12, "$4,120"],
  [2, "sol_samurai", 3, "Paladin", 31.7, 7, 9, "$3,380"],
  [3, "PuddingKing", 3, "Paladin", 29.4, 6, 8, "$2,910"],
  [4, "ember.sol", 3, "Paladin", 24.0, 5, 6, "$2,244"],
  [5, "bramble", 2, "Knight", 21.8, 4, 5, "$1,602"],
  [6, "rookie_rook", 2, "Knight", 19.5, 4, 4, "$1,418"],
  [7, "tinyfish", 2, "Knight", 18.9, 3, 4, "-"],
  [8, "nightowl", 2, "Knight", 16.1, 3, 3, "$960"],
  [9, "lowdd_larry", 1, "Squire", 14.7, 2, 3, "-"],
  [10, "moonpaw", 1, "Squire", 13.3, 2, 2, "$411"],
  [11, "sir_lag", 1, "Squire", 12.8, 2, 2, "$388"],
  [12, "0xBeans", 1, "Squire", 11.6, 1, 2, "-"],
];
const TC = ["", "#d9d3d4", "#bbb4fb", "#8fd3ff", "#ffc24a"];
const TINT = ["", "217,211,212", "143,133,255", "90,190,255", "255,170,40"];
const TIERS = ["All", "Squire", "Knight", "Paladin", "Ascended"];

export function Leaderboard() {
  const [tier, setTier] = useState("All");
  const [season, setSeason] = useState("Season 1");
  const rows = ROWS.filter((r) => tier === "All" || r[3] === tier);
  const rank = rows.map((r, i) => ({ r, i }));
  const podium = tier === "All" ? [rank[1], rank[0], rank[2]] : [];
  return (
    <main className="pg-leaderboard" data-testid="leaderboard">
      <div className="sample-banner">
        <b>Sample data.</b> The live leaderboard is not built yet; every name and number on this page is a placeholder.{" "}
        <Link to="/barracks">See your own knights</Link>
      </div>
      <div className="hdr">
        <div>
          <div className="eyebrow">Season 1</div>
          <h1 className="pt" style={{ fontSize: 48 }}>Leaderboard</h1>
        </div>
        <div className="filters">
          <div className="seg2">
            {["Season 1", "All-time", "Guilds"].map((s) => (
              <button key={s} className={s === season ? "on" : ""} onClick={() => setSeason(s)}>{s}</button>
            ))}
          </div>
          <div className="seg2">
            {TIERS.map((t) => (
              <button key={t} className={t === tier ? "on" : ""} onClick={() => setTier(t)}>{t}</button>
            ))}
          </div>
        </div>
      </div>
      {podium.length > 0 && (
        <div className="pod">
          {podium.map((p) => {
            const [n, name, lv, tname, ret, bosses] = p!.r;
            return (
              <div key={n} className="pc" style={{ ["--t" as string]: TINT[lv], paddingTop: n === 1 ? 60 : 52, paddingBottom: n === 1 ? 26 : 22 }}>
                <div className="rk"><b>{n}</b></div>
                <div style={{ display: "flex", justifyContent: "center" }}><KnightImg level={lv} size={n === 1 ? 150 : 120} /></div>
                <div className="hn">{name}</div>
                <div className="rt up">+{ret.toFixed(1)}%</div>
                <div className="sub">{tname.toUpperCase()} · {bosses} BOSSES</div>
              </div>
            );
          })}
        </div>
      )}
      <div className="panel lb">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead><tr><th style={{ width: 70 }}>Rank</th><th>Knight</th><th>Tier</th><th className="r">Return</th><th className="r">Bosses slain</th><th className="r">Best streak</th><th className="r">Paid out</th></tr></thead>
            <tbody>
              {rows.slice(tier === "All" ? 3 : 0).map((r) => (
                <tr key={r[0]}>
                  <td className="n">{String(r[0]).padStart(2, "0")}</td>
                  <td><div className="av"><i><KnightImg level={r[2]} size={30} /></i>{r[1]}</div></td>
                  <td><span className="tg" style={{ color: TC[r[2]] }}>{r[3]}</span></td>
                  <td className="r up">+{r[4].toFixed(1)}%</td>
                  <td className="r">{r[5]}</td>
                  <td className="r">{r[6]}d</td>
                  <td className="r">{r[7]}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="mute" style={{ textAlign: "center", padding: 24 }}>No knights in this tier.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="dim note mono" style={{ marginTop: 14 }}>Sample data. Real rankings will come from simulated accounts only.</p>
    </main>
  );
}
