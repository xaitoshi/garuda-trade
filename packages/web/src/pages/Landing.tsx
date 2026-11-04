import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { LEVELS, type KnightLevel } from "../lib/knight";
import { pct, usd } from "../lib/format";
import { BossImg, KnightImg } from "../components/Art";

/** Used until /rules answers, so the landing page never depends on the API being up. */
const FALLBACK = {
  common: { profitTargetPct: 0.1, dailyLossPct: 0.03, maxDrawdownPct: 0.06, profitSplit: 0.8 },
  tiers: { squire: { fee: 119, accountSize: 10_000 }, knight: { fee: 275, accountSize: 25_000 }, paladin: { fee: 499, accountSize: 50_000 }, ascended: { fee: 899, accountSize: 100_000 } },
};
const kfmt = (n: number) => `$${Math.round(n / 1000)}k`;
const SUB = ["Mint any challenge", "Pass a challenge", "Level up again", "Funded and thriving"];

export function Landing() {
  const { rules } = useSession();
  const c = rules?.common ?? FALLBACK.common;
  const t = rules?.tiers ?? FALLBACK.tiers;
  const paid = LEVELS.map((l) => ({ ...l, ...t[l.tier] }));
  return (
    <main className="pg-landing" data-testid="landing">
      <header className="hero">
        <div className="hero-copy">
          <h1>
            Slay the<br />Phoenix.<br /><em>Get funded.</em>
          </h1>
          <p className="lead">The onchain prop firm where your trades fight a boss.</p>
          <div className="cta-row">
            <Link className="btn btn-fire" to="/challenges">Start a challenge</Link>
            <span className="cta-note"><i className="chain" />Phoenix perps on <b>Solana</b></span>
          </div>
        </div>
        <div className="hero-art">
          <div className="phoenix">
            <div className="glow" />
            <div className="mark glowmark" />
            <div className="mark" />
          </div>
          <div className="fchip c1"><span className="mono">PHOENIX HP</span><b>62%</b><div className="bar"><i style={{ width: "62%" }} /></div></div>
          <div className="fchip c2"><span className="mono">NEXT LEVEL</span><b>Knight, LV.2</b></div>
        </div>
      </header>

      <div className="strip rv">
        <div><b>{pct(c.profitSplit, 0)}</b><span>Profit split</span></div>
        <div><b>USDC</b><span>Fees</span></div>
        <div><b>{usd(t.squire.fee)}</b><span>Challenges from</span></div>
        <div><b>{kfmt(t.ascended.accountSize)}</b><span>Largest account</span></div>
      </div>

      <section className="s wrap" id="how">
        <div className="s-head rv">
          <div><div className="eyebrow">How it works</div><h2>Three steps.<br />One boss.</h2></div>
          <p className="lead">Pay once. Trade live Phoenix markets. Your PnL is the sword.</p>
        </div>
        <div className="steps">
          <article className="step rv">
            <div className="art"><KnightImg level={2} state="dormant" size={190} /></div>
            <div className="step-body"><span className="step-n">01</span><h3>Mint a knight</h3><p>Every challenge mints a chibi knight NFT.</p></div>
          </article>
          <article className="step rv">
            <div className="art"><KnightImg level={2} size={160} /><span className="vs">VS</span><BossImg state="hurt" size={170} /></div>
            <div className="step-body"><span className="step-n">02</span><h3>Battle the Phoenix</h3><p>Profit chips the boss. Losses hurt your knight.</p></div>
          </article>
          <article className="step rv">
            <div className="art"><KnightImg level={4} state="victory" size={190} /></div>
            <div className="step-body"><span className="step-n">03</span><h3>Ascend, get funded</h3><p>Hit {pct(c.profitTargetPct, 0)} inside the limits and claim a funded account.</p></div>
          </article>
        </div>
      </section>

      <section className="s wrap" id="trials">
        <div className="s-head rv">
          <div><div className="eyebrow">Challenges</div><h2>Pick your trial.</h2></div>
          <p className="lead">Same rules at every size. Pay the fee in USDC.</p>
        </div>
        <div className="tiers rv">
          {paid.map((p) => (
            <article className="tier" data-lv={p.level} key={p.tier}>
              <div className="tier-art"><KnightImg level={p.level as KnightLevel} size={110} /></div>
              <div className="tier-name">{p.name} Trial</div>
              <div className="tier-size">{kfmt(p.accountSize)}<span>account</span></div>
              <dl>
                <div><dt>Profit target</dt><dd>{pct(c.profitTargetPct, 0)}</dd></div>
                <div><dt>Daily loss</dt><dd>{pct(c.dailyLossPct, 0)}</dd></div>
                <div><dt>Max drawdown</dt><dd>{pct(c.maxDrawdownPct, 0)}</dd></div>
                <div><dt>Profit split</dt><dd className="hot">{pct(c.profitSplit, 0)}</dd></div>
              </dl>
              <div className="tier-foot">
                <div className="fee"><span>Fee</span><b>{usd(p.fee)}</b></div>
                <Link className="btn btn-ghost" to={`/challenges?tier=${p.tier}`}>Start</Link>
              </div>
            </article>
          ))}
        </div>
        <div className="fine rv"><span className="badge">SIMULATED ACCOUNT</span>Challenges run on simulated accounts against the live Phoenix orderbook. Try the free demo first.</div>
      </section>

      <section className="s wrap" id="knights">
        <div className="s-head rv">
          <div><div className="eyebrow">Knights</div><h2>Level up<br />your knight.</h2></div>
          <p className="lead">Win and it evolves. Lose and it is wounded, not burned.</p>
        </div>
        <div className="stairs rv">
          {LEVELS.map((l, i) => (
            <div className="lvl" style={{ ["--i" as string]: i }} key={l.tier}>
              <div className="lvl-art">
                <KnightImg level={l.level as KnightLevel} size={150} className="knight" />
                <div className="plinth" />
              </div>
              <div className="lvl-meta"><span className="mono">LV.{l.level}</span><h3>{l.name}</h3><p>{SUB[i]}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="s wrap" id="payouts">
        <div className="s-head rv">
          <div><div className="eyebrow">Payouts</div><h2>Win it.<br />Withdraw it.</h2></div>
          <p className="lead">Funded traders keep {pct(c.profitSplit, 0)} of profit, paid in USDC.</p>
        </div>
        <div className="pay rv">
          <div className="pay-big"><div className="num">{Math.round(c.profitSplit * 100)}<sup>%</sup></div><p>of every profit goes to you.</p></div>
          <div className="pay-right">
            <div className="feed">
              <div className="feed-row"><div className="ic"><KnightImg level={1} size={34} /></div><div><strong>Profit target</strong><small>To pass the evaluation</small></div><span className="amt">{pct(c.profitTargetPct, 0)}</span></div>
              <div className="feed-row"><div className="ic"><KnightImg level={2} size={34} /></div><div><strong>Daily loss limit</strong><small>Of the start-of-day balance, UTC</small></div><span className="amt">{pct(c.dailyLossPct, 0)}</span></div>
              <div className="feed-row"><div className="ic"><KnightImg level={3} size={34} /></div><div><strong>Max drawdown</strong><small>Static, from the starting balance</small></div><span className="amt">{pct(c.maxDrawdownPct, 0)}</span></div>
            </div>
            <div className="trust">
              <div><b>Plain numbers</b><span>Real PnL and limits, always visible.</span></div>
              <div><b>Live book fills</b><span>Orders walk the real Phoenix orderbook.</span></div>
              <div><b>Onchain knights</b><span>Level and status live on Solana.</span></div>
              <div><b>Auto risk limits</b><span>Breach a limit and positions close.</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="s wrap" id="faq">
        <div className="faq-grid">
          <div className="rv"><div className="eyebrow">FAQ</div><h2>Questions.</h2></div>
          <div className="faq rv">
            <details open><summary>What is Garuda?</summary><p>A gamified prop firm on Phoenix perps. Trade a challenge, fight the Phoenix, get funded.</p></details>
            <details><summary>What does the NFT do?</summary><p>Your knight tracks your progress. It levels up when you pass. Rarity is cosmetic only.</p></details>
            <details><summary>What if I fail?</summary><p>Your knight is wounded, not burned. Revive it at {pct(rules?.revive.discount ?? 0.2, 0)} off and retry.</p></details>
            <details><summary>How do payouts work?</summary><p>Funded accounts keep {pct(c.profitSplit, 0)} of profit, paid in USDC. Payouts are not switched on yet, so nothing can be withdrawn today.</p></details>
            <details><summary>Is this real money?</summary><p>Challenge accounts are simulated and fill against the live Phoenix orderbook. Challenge fees are paid in USDC.</p></details>
          </div>
        </div>
      </section>

      <section className="final">
        <h2 className="rv">Face the<br />Phoenix.</h2>
        <div className="cta-row rv">
          <Link className="btn btn-fire" to="/challenges">Start a challenge</Link>
          <span className="cta-note">From <b>{usd(t.squire.fee)}</b></span>
        </div>
      </section>
    </main>
  );
}
