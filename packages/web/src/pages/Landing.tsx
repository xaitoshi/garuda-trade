import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { LEVELS, fallbackScalingTable, type KnightLevel } from "../lib/knight";
import { pct, usd } from "../lib/format";
import { KnightImg } from "../components/Art";
import { XMarketsButton } from "../components/XMarkets";

/** Near-black sampled from the dotted hero artwork edges (~#08090a). */
const LANDING_INK = "#08090a";

/** Used until /rules answers, so the landing page never depends on the API being up. */
const FALLBACK = {
  common: { profitTargetPct: 0.1, dailyLossPct: 0.03, maxDrawdownPct: 0.06, profitSplit: 0.8 },
  tiers: { squire: { fee: 39, accountSize: 5_000 }, knight: { fee: 79, accountSize: 10_000 }, paladin: { fee: 119, accountSize: 15_000 }, ascended: { fee: 200, accountSize: 25_000 } },
};
const kfmt = (n: number) => `$${n % 1000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`;
const SUB = ["Lv.3 graduates to Knight", "Lv.3 graduates to Paladin", "Lv.3 graduates to Ascended", "Grows $5K a level"];

export function Landing() {
  const { rules } = useSession();
  const c = rules?.common ?? FALLBACK.common;
  const t = rules?.tiers ?? FALLBACK.tiers;
  const paid = LEVELS.map((l) => ({ ...l, ...t[l.tier] }));

  // Match document chrome to the hero artwork so the dotted knight has no visible page card edge.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("landing-skin");
    root.style.setProperty("--landing-ink", LANDING_INK);
    return () => {
      root.classList.remove("landing-skin");
      root.style.removeProperty("--landing-ink");
    };
  }, []);

  return (
    <main className="pg-landing" data-testid="landing">
      <header className="hero">
        <div className="hero-copy">
          <h1 className="hero-headline">
            The First Prop Firm on Solana,
            <span className="powered-by">
              powered by{" "}
              <img
                className="phoenix-mark"
                src="/brand/phoenix-mark.png"
                width={44}
                height={44}
                alt="Phoenix"
                decoding="async"
              />
            </span>
          </h1>
          <div className="cta-row">
            <Link className="btn btn-fire" to="/challenges">Start a challenge</Link>
            <XMarketsButton />
          </div>
        </div>
        <div className="hero-art">
          <img
            className="hero-knight"
            src="/art/landing/hero-knight-dotted.png"
            alt="Dotted Garuda knight"
            width={904}
            height={884}
            decoding="async"
          />
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
            <div className="art">
              <img className="knight knight-fill" src="/art/steps/1.png" alt="" draggable={false} />
            </div>
            <div className="step-body"><span className="step-n">01</span><h3>Mint a knight</h3><p>Every challenge mints a knight NFT.</p></div>
          </article>
          <article className="step rv">
            <div className="art">
              <img className="knight knight-fill" src="/art/steps/2.png" alt="" draggable={false} />
            </div>
            <div className="step-body"><span className="step-n">02</span><h3>Tame the Phoenix</h3><p>Profit chips the boss. Losses hurt your knight.</p></div>
          </article>
          <article className="step rv">
            <div className="art">
              <img className="knight knight-fill" src="/art/steps/4.png" alt="" draggable={false} />
            </div>
            <div className="step-body"><span className="step-n">03</span><h3>Ascend, get funded</h3><p>Bank {pct(c.profitTargetPct, 0)} in closed profit over at least 3 trading days inside the limits, then claim a funded account.</p></div>
          </article>
        </div>
      </section>

      <section className="s wrap" id="trials">
        <div className="s-head rv">
          <div><div className="eyebrow">Challenges</div><h2>Pick your trial.</h2></div>
          <p className="lead">Every tier is open. Same rules at every size. Pay the fee in USDC.</p>
        </div>
        <div className="tiers rv">
          {paid.map((p) => (
            <article className="tier" data-lv={p.level} key={p.tier}>
              <div className="tier-art"><KnightImg level={p.level as KnightLevel} variant="card" fill alt="" /></div>
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
        <div className="fine rv"><span className="badge">Simulated account</span>Challenges run on simulated accounts against the live Phoenix orderbook. Try the free demo first.</div>
      </section>

      <section className="s wrap" id="knights">
        <div className="s-head rv">
          <div><div className="eyebrow">Knights</div><h2>Scale your<br />funded account.</h2></div>
          <p className="lead">Make {pct(rules?.scaling?.levelUpProfitPct ?? 0.05, 0)} of your account size and take a payout to level up. Lose and your knight is wounded.</p>
        </div>
        <div className="stairs rv">
          {LEVELS.map((l, i) => {
            const row = (rules?.scaling?.table ?? fallbackScalingTable()).find((r) => r.tier === l.tier);
            const first = row?.levels[0]?.size ?? 0;
            const last = row?.levels[row.levels.length - 1]?.size ?? 0;
            return (
            <div className="lvl" style={{ ["--i" as string]: i }} key={l.tier}>
              <div className="lvl-art">
                <KnightImg level={l.level as KnightLevel} variant="card" fill alt="" />
              </div>
              <div className="lvl-meta"><span className="mono">Lv.1 to {row?.levels.length ?? 3} · {kfmt(first)} to {kfmt(last)}</span><h3>{l.name}</h3><p>{SUB[i]}</p></div>
            </div>
            );
          })}
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
              <div><b>Onchain knights</b><span>Tier, level and status live on Solana.</span></div>
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
            <details><summary>When do I get funded?</summary><p>Bank {pct(c.profitTargetPct, 0)} in closed profit, end flat, trade on at least 3 days, and keep your best day under half of your profit. Then claim, verify your identity, and pass a risk review of about one business day.</p></details>
            <details><summary>What does the NFT do?</summary><p>Every paid challenge mints a knight of that tier. It tracks your funded level and graduates to the next tier with new art. Rarity is cosmetic only.</p></details>
            <details><summary>How do I level up?</summary><p>On a funded account, make {pct(rules?.scaling?.levelUpProfitPct ?? 0.05, 0)} of the current size in closed profit and get one payout paid. The account grows to the next level and the limits follow. Squire Lv.3 graduates to Knight Lv.1, and Ascended goes up to $100K.</p></details>
            <details><summary>What if I fail?</summary><p>Your knight is wounded. Revive it at {pct(rules?.revive.discount ?? 0.2, 0)} off and retry.</p></details>
            <details><summary>How do payouts work?</summary><p>Funded accounts keep {pct(c.profitSplit, 0)} of profit, paid in USDC. Payouts are not switched on yet, so nothing can be withdrawn today.</p></details>
            <details><summary>Is this real money?</summary><p>Challenge accounts are simulated and fill against the live Phoenix orderbook. Challenge fees are paid in USDC.</p></details>
          </div>
        </div>
      </section>

      <section className="final">
        <h2 className="rv">Face the<br />Phoenix.</h2>
        <div className="cta-row rv">
          <Link className="btn btn-fire" to="/challenges">Start a challenge</Link>
          <XMarketsButton />
          <span className="cta-note">From <b>{usd(t.squire.fee)}</b></span>
        </div>
      </section>
    </main>
  );
}
