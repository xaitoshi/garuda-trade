import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { pct, usd } from "../lib/format";
import { fallbackScalingTable } from "../lib/knight";
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

const FALLBACK_TIERS: Record<string, Pick<TierSpec, "name" | "accountSize" | "fee" | "reviveFee" | "payouts">> = {
  demo: { name: "Demo", accountSize: 5_000, fee: 0, reviveFee: 0, payouts: false },
  squire: { name: "Squire", accountSize: 5_000, fee: 39, reviveFee: 31.2, payouts: true },
  knight: { name: "Knight", accountSize: 10_000, fee: 79, reviveFee: 63.2, payouts: true },
  paladin: { name: "Paladin", accountSize: 15_000, fee: 119, reviveFee: 95.2, payouts: true },
  ascended: { name: "Ascended", accountSize: 25_000, fee: 200, reviveFee: 160, payouts: true },
};

function useGuide() {
  const { rules } = useSession();
  const common = rules?.common ?? { profitTargetPct: 0.1, dailyLossPct: 0.03, maxDrawdownPct: 0.06, profitSplit: 0.8, minPayoutUsd: 20 };
  const tiers = rules?.tiers ?? (FALLBACK_TIERS as unknown as Rules["tiers"]);
  const scaling = rules?.scaling ?? { levelUpProfitPct: 0.05, levelUpPayouts: 1, ascendedStepUsd: 5_000, ascendedMaxUsd: 100_000, table: fallbackScalingTable() };
  return { rules, common, tiers, scaling };
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

/** Funded scaling ladder: every level size per tier, Lv.3 graduating into the next tier, Ascended up to Lv.16. */
function ScalingTable({ table }: { table: NonNullable<Rules["scaling"]>["table"] }) {
  const squad = table.filter((r) => r.graduatesTo);
  const asc = table.find((r) => r.tier === "ascended");
  return (
    <>
      <table className="rule-table scaling-table" data-testid="scaling-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Lv.1</th>
            <th>Lv.2</th>
            <th>Lv.3</th>
            <th>Next level up</th>
          </tr>
        </thead>
        <tbody>
          {squad.map((r) => {
            const up = table.find((x) => x.tier === r.graduatesTo);
            return (
              <tr key={r.tier}>
                <td>{r.name}</td>
                {r.levels.map((l) => <td key={l.level}>{usd(l.size, l.size % 1 ? 2 : 0)}</td>)}
                <td>{up ? `${up.name} Lv.1 at ${usd(up.levels[0]!.size)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {asc && (
        <table className="rule-table scaling-table" data-testid="scaling-table-ascended">
          <thead>
            <tr>
              <th>Ascended</th>
              {asc.levels.filter((_, i) => i % 3 === 0 || i === asc.levels.length - 1).map((l) => <th key={l.level}>Lv.{l.level}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Account</td>
              {asc.levels.filter((_, i) => i % 3 === 0 || i === asc.levels.length - 1).map((l) => <td key={l.level}>{usd(l.size)}</td>)}
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}

export function ChallengeRules() {
  const { common, tiers, scaling } = useGuide();
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
      lead="One step evaluation. Every tier is open to buy and the same percentages apply at every size. Meet the four Path to Funded requirements without breaking either equity limit, claim your funded account, then level it up."
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
            <th>Access</th>
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
                <td>Open to all</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2>How a challenge works</h2>
      <ul>
        <li>Pay the fee in USDC, or start the free demo. Every paid challenge mints a knight NFT of that tier: a Paladin challenge mints a Paladin knight.</li>
        <li>There is no time limit. Trade until you meet every requirement below, or until a limit ends the account.</li>
      </ul>
      <h2 id="path-to-funded">Path to funded</h2>
      <p>You pass when all four requirements are met at the same time. Passing does not change your knight's tier or level. It earns the right to claim a funded account at Lv.1 of the same tier.</p>
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
        <li>The funded account opens at Lv.1 of its tier, at the same starting balance, with no profit target, and stays bound to your knight. Challenge profit is never paid out or carried over.</li>
      </ul>
      <h2 id="funded-scaling">Funded scaling</h2>
      <p data-testid="scaling-rule">
        One rule, the same at every level and every tier. Your funded account levels up when you have made <b>{pct(scaling.levelUpProfitPct, 0)} of its current size</b> in closed profit since your last level up (profit you were paid counts), <b>and</b> at least {scaling.levelUpPayouts === 1 ? "one payout" : `${scaling.levelUpPayouts} payouts`} you requested since then has been paid.
      </p>
      <ul>
        <li>The level up is applied automatically, usually the moment that payout is paid. If you hold an open position at that time, it applies as soon as you are flat.</li>
        <li>Each level moves the account to the next size below. The {dd} max drawdown floor and the {daily} daily loss limit reset to the new size. The split stays {split}.</li>
        <li>Squire, Knight and Paladin have three levels. Levelling up from Lv.3 graduates your account into Lv.1 of the next tier, and your knight NFT becomes that tier, with its art.</li>
        <li>Ascended grows {usd(scaling.ascendedStepUsd)} per level, up to {usd(scaling.ascendedMaxUsd)} at Lv.16.</li>
        <li>A breach ends the funded account as usual. A revive restarts a challenge at your knight's current tier, and the next funded account starts at Lv.1.</li>
      </ul>
      <ScalingTable table={scaling.table} />
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
        <li>Demo has the same risk rules, no NFT and no payouts.</li>
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
  const { common, tiers, rules, scaling } = useGuide();
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
      `You pass when four things are true at once: your closed balance is up ${pct(common.profitTargetPct, 0)} (open profit does not count), you have no open positions, you traded on at least ${common.minTradingDays ?? 3} UTC days, and your best day is no more than ${pct(common.bestDayMaxShare ?? 0.5, 0)} of your profitable days. Then you claim the funded account, verify your identity, and Garuda runs a risk review that takes about one business day. Approval opens the funded account at Lv.1 of your tier, at the same starting balance.`,
    ],
    [
      "Does passing pay me anything?",
      `No. The challenge is the test, so challenge profit is never paid out or carried over. The ${pct(common.profitSplit, 0)} split applies to profit you make on the funded account, and you can request your first payout as soon as you are funded and in profit, with positions closed and the best day rule met. There is no waiting period.`,
    ],
    [
      "What is the difference between demo and paid?",
      `The demo is a free ${usd(tiers.demo.accountSize)} practice account with the same risk rules. It does not mint a knight NFT and has no payouts. Paid tiers start at ${usd(squire.fee)} for a ${usd(squire.accountSize)} Squire account and go up to ${usd(ascended.fee)} for a ${usd(ascended.accountSize)} Ascended account. Every tier is open to buy.`,
    ],
    [
      "How do payouts work?",
      `Funded accounts keep ${split} of profit, paid in USDC. The minimum payout is ${usd(min)}. Requests up to ${usd(auto)} are approved automatically; larger ones wait for review. All positions must be closed, the best day rule must hold since your last payout, and each payout sweeps the full profit and resets the balance to the account size.`,
    ],
    [
      "How does my funded account grow?",
      `Each funded account has a level, shown as tier and level, for example Squire Lv.2. It levels up when you have made ${pct(scaling.levelUpProfitPct, 0)} of its current size in closed profit since the last level up, and a payout you requested since then has been paid. Squire, Knight and Paladin have three levels each, and levelling up from Lv.3 moves you into Lv.1 of the next tier. Ascended grows ${usd(scaling.ascendedStepUsd)} a level up to ${usd(scaling.ascendedMaxUsd)}. The limits move to the new size and the split stays ${split}.`,
    ],
    [
      "Is this live mainnet trading?",
      "Challenge accounts are simulated and fill against the live Phoenix order book. Fees and payouts use USDC on Solana devnet in the current deployment. Every screen shows a simulated account badge.",
    ],
    [
      "What do knight NFTs do?",
      "Every paid challenge mints a knight NFT of the tier you bought. Its tier, funded level and status live onchain. Passing does not change it; when your funded account levels up the knight's level follows, and when it graduates the knight becomes the next tier with new art. Rarity is cosmetic and never changes rules, size, or payouts.",
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
