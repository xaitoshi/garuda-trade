import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { pct, usd } from "../lib/format";
import type { Rules, TierSpec } from "../lib/types";

const ORDER = ["demo", "squire", "knight", "paladin", "ascended"] as const;
const CLASS_LABEL: Record<string, string> = {
  major_crypto: "BTC, ETH and SOL",
  other_crypto: "Other crypto",
  equity: "Equities",
  index_sp500_nasdaq: "SPY and QQQ",
  index_other: "Other index and ETF",
  commodity_major: "Gold, silver and WTI oil",
  commodity_other: "Other commodities",
};

const FALLBACK_TIERS: Record<string, Pick<TierSpec, "name" | "accountSize" | "fee" | "reviveFee" | "requires" | "payouts">> = {
  demo: { name: "Demo", accountSize: 5_000, fee: 0, reviveFee: 0, payouts: false },
  squire: { name: "Squire", accountSize: 5_000, fee: 39, reviveFee: 31.2, payouts: true },
  knight: { name: "Knight", accountSize: 10_000, fee: 79, reviveFee: 63.2, payouts: true },
  paladin: { name: "Paladin", accountSize: 15_000, fee: 119, reviveFee: 95.2, requires: "knight", payouts: true },
  ascended: { name: "Ascended", accountSize: 25_000, fee: 200, reviveFee: 160, requires: "paladin", payouts: true },
};

function useGuide() {
  const { rules } = useSession();
  const common = rules?.common ?? { profitTargetPct: 0.1, dailyLossPct: 0.03, maxDrawdownPct: 0.06, profitSplit: 0.8, minPayoutUsd: 20 };
  const tiers = rules?.tiers ?? (FALLBACK_TIERS as Rules["tiers"]);
  return { rules, common, tiers };
}

function Shell({ title, kicker, lead, children }: { title: string; kicker: string; lead: string; children: ReactNode }) {
  return (
    <main className="pg-info" data-testid={`page-${kicker.toLowerCase()}`}>
      <div className="info-hd">
        <div className="eyebrow">{kicker}</div>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
      </div>
      {children}
    </main>
  );
}

export function ChallengeRules() {
  const { common, tiers } = useGuide();
  const target = pct(common.profitTargetPct, 0);
  const daily = pct(common.dailyLossPct, 0);
  const dd = pct(common.maxDrawdownPct, 0);
  const split = pct(common.profitSplit, 0);
  const minDays = common.minTradingDays ?? 3;
  const best = pct(common.bestDayMaxShare ?? 0.5, 0);
  return (
    <Shell
      kicker="Rules"
      title="Challenge rules."
      lead="One step evaluation. The same percentages apply at every size. Meet the four Path to Funded requirements without breaking either equity limit, then claim your funded account."
    >
      <h2>Tiers</h2>
      <table className="rule-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Account</th>
            <th>Fee</th>
            <th>Target ({target}, closed)</th>
            <th>Daily loss</th>
            <th>Max drawdown</th>
            <th>Split</th>
            <th>Unlock</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.map((id) => {
            const t = tiers[id];
            const size = t.accountSize;
            return (
              <tr key={id}>
                <td>{t.name}</td>
                <td>{usd(size)}</td>
                <td>{t.fee === 0 ? "Free" : usd(t.fee)}</td>
                <td>{usd(Math.round(size * common.profitTargetPct))}</td>
                <td>{daily}</td>
                <td>{dd} static</td>
                <td>{t.payouts ? split : "None"}</td>
                <td>{t.requires ? `Needs a ${tiers[t.requires].name} knight` : "Open to all"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2>How a challenge works</h2>
      <ul>
        <li>Pay the fee in USDC, or start the free demo. A paid Squire or Knight challenge mints a knight NFT.</li>
        <li>There is no time limit. Trade until you meet every requirement below, or until a limit ends the account.</li>
      </ul>
      <h2 id="path-to-funded">Path to funded</h2>
      <p>You pass when all four requirements are met at the same time. Your knight levels up the moment you pass.</p>
      <ol className="ptf-rules" data-testid="path-to-funded-rules">
        <li><b>Profit target on closed trades.</b> Your closed balance must reach {target} above the starting balance. Open profit does not count, so a floating spike never passes.</li>
        <li><b>Be flat to pass.</b> Close every position. Garuda never closes positions for you on a pass.</li>
        <li><b>At least {minDays} trading days.</b> A UTC day counts when you open or close at least one position. The days do not need to be in a row, so hitting {target} on day one is not enough.</li>
        <li><b>Best day rule.</b> Your best single UTC day can be at most {best} of the total profit from all your profitable days. Losing days are ignored. This never ends the account: if one day is too big, keep trading until the profit is spread out.</li>
        <li><b>Claim your funded account.</b> Once 1 to 4 are met, press Claim. Nothing opens on its own.</li>
        <li><b>Verify your identity.</b> A government ID and a live selfie are checked before funded trading starts.</li>
        <li><b>Risk review, about one business day.</b> Garuda checks for hedging across accounts or outside Garuda, collusion, feed or latency exploits, account sharing, and all in lottery style cycling. Approval opens the funded account.</li>
        <li><b>First payout on demand.</b> Once funded and in profit, with every position closed, at least {usd(common.minPayoutUsd)} due to you, and the best day rule met for the payout cycle, request a payout. There is no waiting period.</li>
      </ol>
      <ul>
        <li>The funded account opens at the same starting balance with no profit target, and stays bound to your knight. Challenge profit is never paid out or carried over.</li>
      </ul>
      <h2>The two limits</h2>
      <ul>
        <li>Daily loss is {daily} of your start of day balance, reset at 00:00 UTC, and checked against equity.</li>
        <li>Max drawdown is {dd} of the starting balance. It is static and never trails.</li>
        <li>If equity touches either floor, even for a moment, positions close and the account ends. The knight becomes Wounded.</li>
        <li>You never owe trading losses. A breach only ends that account.</li>
      </ul>
      <h2>Payouts and revive</h2>
      <ul>
        <li>Funded accounts keep {split} of profit, paid in USDC. The minimum payout is {usd(common.minPayoutUsd)}.</li>
        <li>Requests up to $500 are approved automatically. Larger ones wait for review. All positions must be closed, the best day rule must hold since your last payout, and each payout sweeps the full profit.</li>
        <li>A Wounded knight can be revived at 20% off the same tier fee, up to 3 times, 24 hours after the breach. Revive starts a new challenge, not the old account.</li>
        <li>Demo has the same risk rules, no NFT, no payouts, and no credit toward unlocks.</li>
      </ul>
      <p>
        <Link to="/challenges">See challenge tiers</Link>
        {" · "}
        <Link to="/challenges/markets">Markets</Link>
        {" · "}
        <Link to="/challenges/faq">FAQ</Link>
      </p>
    </Shell>
  );
}

export function ChallengeMarkets() {
  const { rules } = useGuide();
  const markets = rules?.markets ?? [];
  const groups = new Map<string, { symbol: string; maxLeverage: number }[]>();
  for (const m of markets) {
    const list = groups.get(m.class) ?? [];
    list.push({ symbol: m.symbol, maxLeverage: m.maxLeverage });
    groups.set(m.class, list);
  }
  const classes = [...groups.keys()];
  return (
    <Shell
      kicker="Markets"
      title="Tradeable markets."
      lead="Garuda only lists Phoenix markets that pass the liquidity filter in the rulebook. This list is the whitelist the app enforces, not a guess."
    >
      {!rules && <p>Loading the live market list.</p>}
      {rules && markets.length === 0 && <p>No markets were returned by the rules endpoint.</p>}
      <div className="mkt-groups">
        {classes.map((cls) => {
          const rows = groups.get(cls)!;
          const cap = rows[0]?.maxLeverage;
          return (
            <div className="mkt-group" key={cls}>
              <h3>
                {CLASS_LABEL[cls] ?? cls}
                {cap ? ` · up to ${cap}x` : ""}
              </h3>
              <div className="mkt-syms">
                {rows.map((r) => (
                  <span key={r.symbol}>{r.symbol}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <h2>How listing works</h2>
      <ul>
        <li>Only whitelisted Phoenix markets can be opened. Reduce only stays available if you already hold a position.</li>
        <li>Equity and commodity markets may be hold and reduce only while Phoenix marks them closed or after hours.</li>
        <li>A live circuit breaker can pause new orders when the spread or book depth is too thin. Risk checks continue.</li>
      </ul>
    </Shell>
  );
}

export function ChallengeFaq() {
  const { common, tiers, rules } = useGuide();
  const auto = rules?.payouts?.autoApproveUpToUsd ?? 500;
  const min = rules?.payouts?.minUsd ?? common.minPayoutUsd ?? 20;
  const split = pct(rules?.payouts?.split ?? common.profitSplit, 0);
  const squire = tiers.squire;
  const ascended = tiers.ascended;
  const items: [string, string][] = [
    [
      "How do challenges work?",
      `You pick a tier, pay the fee in USDC, and trade a simulated account against the live Phoenix book. There is no time limit. Stay inside the ${pct(common.dailyLossPct, 0)} daily loss and ${pct(common.maxDrawdownPct, 0)} static drawdown, and pass by meeting the Path to Funded rules.`,
    ],
    [
      "When do I get a funded account?",
      `You pass when four things are true at once: your closed balance is up ${pct(common.profitTargetPct, 0)} (open profit does not count), you have no open positions, you traded on at least ${common.minTradingDays ?? 3} UTC days, and your best day is no more than ${pct(common.bestDayMaxShare ?? 0.5, 0)} of your profitable days. Then you claim the funded account, verify your identity, and Garuda runs a risk review that takes about one business day. Approval opens the funded account at the same starting balance.`,
    ],
    [
      "Does passing pay me anything?",
      `No. The challenge is the test, so challenge profit is never paid out or carried over. The ${pct(common.profitSplit, 0)} split applies to profit you make on the funded account, and you can request your first payout as soon as you are funded and in profit, with positions closed and the best day rule met. There is no waiting period.`,
    ],
    [
      "What is the difference between demo and paid?",
      `The demo is a free ${usd(tiers.demo.accountSize)} practice account with the same risk rules. It does not mint a knight NFT, has no payouts, and does not count toward unlocks. Paid tiers start at ${usd(squire.fee)} for a ${usd(squire.accountSize)} Squire account and go up to ${usd(ascended.fee)} for a ${usd(ascended.accountSize)} Ascended account.`,
    ],
    [
      "How do payouts work?",
      `Funded accounts keep ${split} of profit, paid in USDC. The minimum payout is ${usd(min)}. Requests up to ${usd(auto)} are approved automatically; larger ones wait for review. All positions must be closed, the best day rule must hold since your last payout, and each payout sweeps the full profit and resets the balance to the starting size.`,
    ],
    [
      "Is this live mainnet trading?",
      "Challenge accounts are simulated and fill against the live Phoenix order book. Fees and payouts use USDC on Solana devnet in the current deployment. Every screen shows a simulated account badge.",
    ],
    [
      "What do knight NFTs do?",
      "A paid Squire or Knight challenge mints a knight NFT that tracks your progress and levels up when you pass. Paladin and Ascended trials use a knight you already hold. Rarity is cosmetic and never changes rules, size, or payouts.",
    ],
    [
      "How do I sign in?",
      "Sign in with a Solana wallet, or with email through Privy. Email creates an embedded Solana wallet for you. Signing in needs no identity check; claiming a funded account does. Payouts go to the wallet you are signed in with.",
    ],
  ];
  return (
    <Shell kicker="FAQ" title="Questions." lead="Short answers from how the product actually works today.">
      <div className="faq-list">
        {items.map(([q, a]) => (
          <details key={q} open>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </Shell>
  );
}
