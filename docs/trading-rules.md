# Garuda Trading Rules

> **Version 1.1 (Path to Funded) · Drafted 2026-11-04 · Updated 2026-11-11 · Owner: xaitoshi**
> Format and defaults follow Propr's Official Rulebook ([propr.xyz/rules](https://www.propr.xyz/rules), v1.0.5, fetched 2026-11-04). Every rule line is tagged **(mirrors Propr)** or **(Garuda-specific)**. Where Propr is silent the tag says so.
> Tag key: **(mirrors Propr)** = same value and wording as Propr's Classic 1-Step. **(Garuda-specific)** = Garuda's own rule or a Phoenix-driven adaptation.

# Official Rulebook

Complete rules governing all Garuda Demo, Squire, Knight, Paladin and Ascended Evaluation accounts and Funded accounts. By purchasing a challenge, you agree to these rules in full.

## 1. Overview

Garuda is a gamified onchain prop firm built on Phoenix Perps (Solana). We fund skilled traders with simulated capital to trade crypto, equity and commodity perpetual futures, without requiring any personal deposit beyond the challenge fee. Every paid challenge is fought by a collectible knight NFT.

Pass a challenge. Get funded. Keep 80% of your profits. Rules, knight state and payouts are transparent and verifiable. **(mirrors Propr: 80% split, no deposit)**

Phase 1 accounts are **simulated**: orders fill against the live Phoenix order book in Garuda's matching simulator and do not reach Phoenix. See Section 22. **(Garuda-specific; Propr also runs simulated accounts but discloses A/B booking)**

### Your two equity limits

Every account has two limits that stay live at all times: a maximum daily loss and a maximum drawdown. Both are checked against your equity, which counts open positions and floating P&L. If your equity hits or drops below either limit, the account is breached: open positions are closed and the account is closed. Your knight falls Wounded and can be revived (Section 17). You never owe trading losses; a breach only ends the account. Your dashboard shows both limits live. **(mirrors Propr; the Wounded and revive wording is Garuda-specific)**

- Maximum daily loss: recalculated every day at 00:00 UTC from your balance, 3% below it. That figure is your equity limit for the next 24 hours. **(mirrors Propr, 1-Step)**
- Maximum drawdown: a floor 6% below your starting balance. It is fixed and never moves. **(mirrors Propr, Classic 1-Step static)**

## 2. Account Sizes & Challenge Fees

Garuda offers one challenge type (one-step) across five account sizes. **(Garuda-specific sizes and fees; structure mirrors Propr Classic 1-Step)**

### One-Step Challenge

| Tier | Account Size | Fee | Profit Target | Max Daily Loss | Max Drawdown | Split | Access |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Demo | $5,000 | Free | $500 (10%) | 3% | 6% (static) | None (no payouts) | Open to all |
| Squire | $5,000 | $39 | $500 (10%) | 3% | 6% (static) | 80% | Open to all |
| Knight | $10,000 | $79 | $1,000 (10%) | 3% | 6% (static) | 80% | Open to all |
| Paladin | $15,000 | $119 | $1,500 (10%) | 3% | 6% (static) | 80% | Open to all |
| Ascended | $25,000 | $200 | $2,500 (10%) | 3% | 6% (static) | 80% | Open to all |

- Demo is a free practice account with the same rules. It has no funding, no payout and no knight NFT. **(Garuda-specific; Propr has no demo)**
- All challenge fees are non-refundable once the account is activated, regardless of outcome. **(mirrors Propr)**
- Fees are paid in USDC on Solana. **(Garuda-specific)**
- The sizes above are challenge sizes and the Lv.1 funded size. Funded accounts then scale by level (Section 10A). **(Garuda-specific)**

## 3. How It Works

STEP 1 Purchase · STEP 2 Trade · STEP 3 Pass · STEP 4 Claim, verify, review · STEP 5 Get Funded

### Step 1: Purchase
Choose your tier and pay the challenge fee in USDC. A knight NFT of that tier is minted (Section 16). Every tier is open to buy. Demo needs no payment. **(Garuda-specific)**

### Step 2: Trade
Reach the profit target on closed trades over at least 3 trading days while staying within the drawdown limits. No time limit. **(Path to Funded, Section 9; in line with FTMO, OWNIT and HyroTrader)**

### Step 3: Pass
Meet all four pass requirements (Section 9) without breaching any equity limit: closed profit target, flat book, 3 trading days, best-day rule. The challenge passes. Nothing is closed for you, and the knight's tier and level do not change. **(Path to Funded)**

### Step 4: Claim, verify, review
Press Claim on the passed challenge. Verify your identity (government ID and live selfie), then Garuda runs a risk review that takes about one business day. **(Path to Funded; mirrors FTMO, Propr, Breakout and HyroTrader identity checks)**

### Step 5: Get Funded
On approval you receive a funded account at **Lv.1** of your tier, with the same starting balance and no profit target, bound to your knight. It then scales by level (Section 10A). Sign in with the wallet that holds the knight (Section 19), trade freely and request on-demand payouts. Challenge profit is never paid or carried over. **(mirrors Propr)**

One-Step Challenge: Reach the 10% profit target on closed trades, end flat, trade on at least 3 UTC days and keep your best day at or under 50% of your profitable days, all while staying within the drawdown limits (3% daily loss, 6% max drawdown). There is no time limit. **(Path to Funded, Section 9)**

## 4. Definitions

**Balance** The total account value based on closed (realized) P&L only, after trading fees and funding. Does not include open positions. **(mirrors Propr)**

**Equity** The real-time account value including closed P&L and the floating (unrealized) P&L of all open positions. Equity = Balance + Unrealized P&L. **(mirrors Propr)**

**Mark Price** Unrealized P&L is valued at the Phoenix mark price for the market, not last trade or mid. **(Garuda-specific; Propr is silent)**

**Equity Limit** A predefined equity level. If your account equity reaches or falls to this level, a breach is triggered. **(mirrors Propr)**

**Breach** The automatic closure of all open positions and permanent termination of the account. A breached account cannot be recovered, reset or appealed. The knight becomes Wounded. **(mirrors Propr; Wounded is Garuda-specific)**

**Profit Target** The account growth required to pass the challenge, as a percentage of the starting balance, measured on the closed balance. **(Path to Funded)**

**Trading Day** A UTC day (00:00 to 24:00 UTC) on which at least one position was opened or closed. Adding to or trimming an open position alone does not count. **(Path to Funded)**

**Best-Day Rule** Your best single UTC day's realized profit may be at most 50% of the sum of all your profitable days' realized profit. Losing days are ignored. **(Path to Funded; mirrors OWNIT's 50% consistency rule)**

**Start-of-Day Balance (SOD)** Your balance snapshot at 00:00 UTC. **(mirrors Propr)**

**Wounded** Knight status after a breach. The knight keeps its tier, art and history and can be revived. **(Garuda-specific)**

**Combat Log** A public text feed of risk events and closed trades derived from your P&L, for example "Sir Pudding strikes for +$312". It is cosmetic and never changes results. **(Garuda-specific)**

## 5. Equity Limits

Every Garuda account has two equity limits active at all times, in both the challenge and funded stages: **(mirrors Propr)**

1. Maximum Daily Loss: the most equity you can lose in a single UTC day, as a percentage of your start-of-day balance, recalculated each day.
2. Maximum Drawdown: an overall equity limit, static for all Garuda accounts.

> **Important** If your equity reaches or falls below either equity limit at any point, the account is immediately and permanently breached. Both limits are equity-based, so they account for open and floating positions, not just closed trades. The effective floor at any moment is the higher of the two limits. **(mirrors Propr)**

## 6. Maximum Daily Loss

| Rule | Value | Source |
| --- | --- | --- |
| Daily loss % | 3% of start-of-day balance, all tiers and stages | mirrors Propr (1-Step) |
| Basis | Start-of-day **balance** (realized), not equity | mirrors Propr v1.0.5 |
| Reset time | 00:00 UTC daily | mirrors Propr |
| Measured on | Equity, including floating P&L | mirrors Propr |
| Grace period | None. A momentary touch breaches. | mirrors Propr |

Daily Loss Limit = 3% × Start-of-day Balance

Equity Floor = Start-of-day Balance − Daily Loss Limit

Example: you open the day with a $25,000 balance. The limit is $750 and the floor is $24,250. Lose down to a $23,800 balance and the next day's limit is $714 (floor $23,086). Bank profit to a $26,000 balance and it rises to $780 (floor $25,220). Because the max drawdown floor ($23,500 on a $25,000 account) is also live, the higher of the two is the one that bites. **(mirrors Propr's calculation; example is Garuda's own)**

- The dollar limit scales with your start-of-day balance: it shrinks as you draw down and grows as you bank realized profit. **(mirrors Propr)**
- The snapshot uses the latest balance at 00:00 UTC. Floating P&L open at midnight is not in the snapshot but is in equity. **(mirrors Propr)**
- Knight HP bar = remaining daily loss buffer; it refills each UTC day. **(Garuda-specific)**

## 7. Maximum Drawdown

The maximum drawdown sets an absolute floor for the account: the lowest your equity can ever go. **(mirrors Propr)**

### Static drawdown (all tiers, evaluation and funded)

Max Drawdown Equity Limit = Starting Balance × (1 − 0.06)

This limit is set once at account creation and never changes, regardless of how high the account grows. **(mirrors Propr Classic 1-Step; trailing is not used anywhere in Garuda)**

| Tier | Account Size | Max Drawdown Equity Limit |
| --- | --- | --- |
| Demo | $5,000 | $4,700 |
| Squire | $5,000 | $4,700 |
| Knight | $10,000 | $9,400 |
| Paladin | $15,000 | $14,100 |
| Ascended | $25,000 | $23,500 |

Example: you have a $15,000 account. The limit is $14,100. You grow the account to $18,000. The limit is still $14,100. If your equity drops to $14,100 at any point, even intraday on an open position, the account is breached. **(mirrors Propr)**

- Static drawdown is permanent. It never moves, and payouts do not change it. **(mirrors Propr)**
- Armor bar = remaining max drawdown buffer; it does not reset. **(Garuda-specific)**
- Warnings: the risk monitor emits warnings when 50% and 80% of either buffer is used. Warnings never change results. **(Garuda-specific)**

## 8. Breach Rules

A breach occurs when the Garuda risk engine detects that an account's equity has reached or fallen below either equity limit. **(mirrors Propr)**

### What Happens on Breach
1. All open positions are immediately closed at the current book. **(mirrors Propr)**
2. The account is permanently disabled. **(mirrors Propr)**
3. No further trading is possible on that account. **(mirrors Propr)**
4. No payouts are available from a breached account. **(mirrors Propr)**
5. The knight becomes Wounded and the Fallen screen shows which rule broke, when, and the equity chart. **(Garuda-specific)**

> **Important**
> - Breaches are permanent for the account. There are no resets, appeals or exceptions. **(mirrors Propr)**
> - There is no distinction between "soft" and "hard" breaches. **(mirrors Propr)**
> - You do not need to close a trade for a breach to occur. **(mirrors Propr)**
> - You are never liable for losses beyond your challenge fee. **(mirrors Propr)**
> - To try again, revive your Wounded knight at a discount (Section 17) or buy a new challenge. **(Garuda-specific)**

## 9. Profit Target and Path to Funded

To pass the challenge you must grow the **closed** balance by the profit target amount and meet the other Path to Funded requirements below. The target applies only to the challenge stage. Funded accounts have no profit target. **(Path to Funded, owner decision 2026-11-11: in line with FTMO, OWNIT, HyroTrader and Bitfunded)**

| Tier | Profit Target | Grow Closed Balance To |
| --- | --- | --- |
| Demo | $500 | $5,500 |
| Squire | $500 | $5,500 |
| Knight | $1,000 | $11,000 |
| Paladin | $1,500 | $16,500 |
| Ascended | $2,500 | $27,500 |

### Path to Funded (8 rules)

1. **Profit target counts closed profit only.** Your balance (realized P&L after fees and funding) must reach the target. Open profit does not pass, so a floating spike never passes. The equity limits (Sections 6 and 7) are still measured on equity. **(mirrors FTMO, OWNIT and Bitfunded)**
2. **Be flat to pass.** You must have no open positions. Garuda never closes positions for you on a pass, and the funded account never opens on its own. **(in line with peers)**
3. **At least 3 trading days.** A UTC day counts when at least one position is opened or closed. Days do not need to be consecutive. Hitting +10% on day one is not enough. **(mirrors HyroTrader's 3 days)**
4. **Best-day rule.** Your best single UTC day's realized profit may be at most **50%** of the sum of all your profitable days' realized profit; losing days are ignored. It is a soft gate, never a breach: if one day is too big you simply keep trading until the profit is spread out. It applies to the pass and to payout requests. **(mirrors OWNIT)**
5. **Claim the funded account.** When rules 1 to 4 are met the challenge passes and the dashboard shows "Eligible: claim funded account". You press Claim; nothing opens automatically. **(Garuda-specific flow)**
6. **Identity check (KYC) before funded trading starts.** A government ID and a live selfie are verified. **(mirrors FTMO, Propr, Breakout and HyroTrader)** *Implementation note: no KYC vendor is integrated yet; Garuda ops approve the check manually. Vendor integration (for example Sumsub) is a TODO.*
7. **Risk review, target about 1 business day.** The claim goes under review. Checks: hedging across Garuda accounts or with external venues, collusion or third-party coordination, feed or latency exploits, account sharing, and all-in lottery-style account cycling (Section 15). Approval opens the funded account. **(in line with FTMO and HyroTrader reviews)**
8. **First payout on demand.** Once funded and in profit, with all positions closed, at least $20 due to you and the best-day rule met for the payout cycle, you can request a payout immediately. There is no waiting period. Challenge profit is never paid out or carried over. **(in line with crypto peers; tighter option of a 14-day first payout like FTMO was not adopted)**

- There is no time limit to meet these requirements. **(mirrors Propr)**
- The dashboard shows progress on each requirement: closed target, flat, days x/3, best-day share. **(Garuda-specific)**
- Boss HP bar = remaining distance of the closed balance to the profit target. **(Garuda-specific)**

## 10. Funded Account Rules

After passing the challenge, claiming it, verifying your identity and clearing the risk review (Section 9), you receive a funded account at Lv.1 of your tier, with the same starting balance. **(mirrors Propr; claim, KYC and review per Path to Funded)**

### Rules That Carry Over
- ✓ Maximum daily loss (3% of start-of-day balance) **(mirrors Propr)**
- ✓ Maximum drawdown (6% static) **(mirrors Propr)**
- ✓ Equity-based enforcement on both limits **(mirrors Propr)**
- ✓ Breach rules (permanent for the account) **(mirrors Propr)**
- ✓ Leverage caps, market whitelist and prohibited conduct **(mirrors Propr)**

### What Changes
- No profit target. You trade freely and withdraw profits when you choose. **(mirrors Propr)**
- Payouts become available as soon as the account is funded and in profit, subject to Section 11 (including the best-day rule). No waiting period. **(Path to Funded rule 8)**
- A funded breach makes the knight Wounded. Reviving it returns you to a **challenge** at the same tier, not straight to a funded account. **(Garuda-specific)**
- A funded account is bound to its knight NFT. **(Garuda-specific)**
- The account grows by level: 5% profit of the current size plus 1 paid payout since the last level up (Section 10A). **(Garuda-specific)**

## 10A. Funded Scaling

All of this section is **Garuda-specific** (owner decision 2026-11-11). Every funded account has a **tier** and a **level**, shown together, for example **Squire Lv.2**.

### The level up rule (the same at every level and tier)

A funded account levels up when **both** are true since its last level up (or since it opened):

1. **Profit:** closed profit of at least **5% of the current account size**. Realized PnL net of fees and funding counts; open profit does not. Profit that was later paid out still counts, because each payout sweeps the balance back to the account size.
2. **Payout:** at least **1 payout** requested on or after the last level up has been **paid**.

The level up is **applied automatically**, normally the moment the qualifying payout is paid. If a position is open at that time, it is applied as soon as the account is **flat**. It is never applied to a breached, dormant or archived account.

### Sizes

| Tier | Lv.1 | Lv.2 | Lv.3 | Level up from Lv.3 |
| --- | --- | --- | --- | --- |
| Squire | $5,000 | $6,666.67 | $8,333.33 | Graduates to Knight Lv.1 ($10,000) |
| Knight | $10,000 | $11,666.67 | $13,333.33 | Graduates to Paladin Lv.1 ($15,000) |
| Paladin | $15,000 | $18,333.33 | $21,666.67 | Graduates to Ascended Lv.1 ($25,000) |
| Ascended | $25,000 | +$5,000 per level | | Up to $100,000 at Lv.16 (cap) |

Ascended levels: Lv.1 $25,000, Lv.4 $40,000, Lv.7 $55,000, Lv.10 $70,000, Lv.13 $85,000, Lv.16 $100,000.

### What a level up changes

- **Account size** moves to the next size in the table. The account keeps its ID, its history and any profit above the old size.
- **Max drawdown** resets to 6% static of the new size (floor = new size × 0.94).
- **Daily loss** resets to 3% of the new size, measured from the balance at the moment of the level up, then resets at 00:00 UTC as usual.
- **Graduation** (a level up from Lv.3) moves the account to Lv.1 of the next tier. The knight NFT's tier, and its art, change with it.
- **Unchanged:** the 80% split, the $20 minimum payout, the best day rule per payout cycle, leverage caps and markets.
- Every level up is kept in the account history and the combat log.

### Caps and breaches

- A level up that would take the trader over the **$300,000 funded aggregate** (Section 20) is **held** until there is room. The largest single account is $100,000.
- A breach ends the funded account (Section 8) and the knight becomes Wounded. A revive (Section 17) starts a **challenge at the knight's current tier**. The next funded account starts at **Lv.1** of that tier.
- Accounts that were funded before scaling started are treated as **Lv.1** of their tier.

## 11. Payouts

### Profit Split
You keep 80% of all profits generated on your funded account. Garuda retains 20%. **(mirrors Propr)**

### Payout Requests

| Rule | Value | Source |
| --- | --- | --- |
| Timing | On demand, any time, no minimum waiting period | mirrors Propr |
| Cadence | Unlimited requests; one request in flight per account | mirrors Propr (the in-flight limit is Garuda-specific) |
| Minimum payout | $20 | mirrors Propr |
| Method | USDC (SPL) on Solana mainnet | mirrors Propr (USDC); chain is Garuda-specific |
| Destination | The wallet you are signed in with when you request the payout (for email sign-in, your embedded Solana wallet). It must be the wallet that owns the account. | Garuda-specific |
| Processing | Within 24 hours. Phase 1 is manually reviewed from a treasury multisig; Phase 2 targets automated payouts under 1 hour with manual review above $10,000 | mirrors Propr's 24h; review thresholds are Garuda-specific |
| Fees | No withdrawal fee. Network fees are paid by Garuda. | mirrors Propr (no withdrawal fee) |
| Identity checks | Completed once, before the funded account opens (Section 9, rule 6). A payout is sent to the authenticated wallet only. | Path to Funded |
| Best-day rule | Best UTC day's realized profit at most 50% of the profitable days' total, counted over the current payout cycle (since the funded account opened or since the last payout) | Path to Funded (mirrors OWNIT) |

Payout = (Current Balance − Account Size) × 0.80

Each payout sweeps all available profit. After a payout, your account balance resets to the current account size. Drawdown limits are static, so a payout does not change them; a level up (Section 10A) resets them to the new size. No partial withdrawals. **(mirrors Propr)**

### Payout Restrictions
- All positions must be closed before requesting a payout. **(mirrors Propr)**
- The best-day rule must be met for the current payout cycle. It never breaches the account; keep trading until it holds. **(Path to Funded, mirrors OWNIT)**
- Full profit sweep only; no partial withdrawals. **(mirrors Propr)**
- Not available on challenge, Demo or breached accounts. **(mirrors Propr)**
- Payouts are not available to accounts under investigation. **(mirrors Propr's right to suspend)**

Payout Receipt example: starting balance $25,000, current balance $28,000, gross profit +$3,000, your 80% = $2,400 USDC, Garuda 20% = $600, new balance $25,000 (reset), drawdown limit $23,500 (unchanged). **(Garuda's numbers; mechanics mirror Propr)**

## 12. Leverage

Leverage is applied automatically and cannot be changed by the trader. Using maximum leverage is not required. You may use any leverage up to the cap. Caps are Propr's, mapped onto Phoenix markets. Phoenix's own protocol limits are higher; the lower of the two applies. **(mirrors Propr; mapping to Phoenix markets is Garuda-specific)**

| Asset Class | Phoenix markets (whitelist) | Max Leverage |
| --- | --- | --- |
| BTC, ETH, SOL perpetuals | BTC, ETH, SOL | 10x |
| Other crypto perpetuals | Any other whitelisted crypto | 2x |
| Equities perpetuals (single stocks) | AAPL, NVDA, TSLA, etc. | 4x |
| SP500 index | SPY | 10x |
| Nasdaq index | QQQ | 10x |
| Other index / ETF perpetuals | TLT | 5x |
| Gold, Silver, WTI crude (CL) | GOLD, SILVER, WTIOIL | 8x |
| Other commodities perpetuals | COPPER | 5x |
| FX perpetuals | Not listed on Phoenix; 25x reserved if added | 25x |

The Brent row in Propr has no Phoenix equivalent. **(Garuda-specific mapping)**

How the cap is enforced: **(Garuda-specific method)**
- Required margin = Σ over open positions of (notional at mark ÷ that market's cap).
- An order that would make required margin exceed account equity is rejected. Price moves that push you over after the fact are not a breach and do not liquidate; you simply cannot add exposure until back under.
- Reduce-only orders are always allowed.

## 13. Tradeable Markets

Garuda operates on Phoenix Perps. Only Phoenix markets that pass the liquidity filter are tradeable. **(Garuda-specific; Propr allows all Hyperliquid markets)**

### Liquidity threshold
A market is whitelisted when, in the Phoenix L2 book, **all** of these hold at review time:
- Resting depth within ±0.5% of mid of at least **$50,000 on each side**
- Top-of-book spread of at most **40 bps**
- Market status active, and not pre-IPO

The whitelist is reviewed weekly from live Phoenix book data and is published with a changelog entry. Delisted markets become reduce-only; open positions are not force-closed. **(Garuda-specific)**

Live circuit breaker: new orders in a market pause when the live spread exceeds 100 bps, or when ±0.5% depth on the side you need falls below $10,000. Reduce-only orders and risk checks continue. A stale feed (no update for 2 seconds) pauses new orders but never risk checks. **(Garuda-specific)**

### Whitelist at 2026-11-04 (46 of 104 Phoenix markets)
- **Crypto (14):** BTC, ETH, SOL, HYPE, ZEC, NEAR, JUP, UNI, SUI, DOGE, TRX, BNB, LTC, LINK
- **Equities and ETFs (28):** AAPL, AMD, AMAT, AMZN, ASML, BABA, COIN, DELL, GOOGL, HOOD, INTC, META, MSFT, MSTR, MU, NBIS, NFLX, NVDA, ORCL, PLTR, QQQ, SKHY, SNDK, SPCX, SPY, TLT, TSLA, TSM
- **Commodities (4):** GOLD, SILVER, WTIOIL, COPPER
- Excluded: pre-IPO (ANTHROPIC), anything below the depth or spread thresholds (for example XRP, ADA, AVAX, AAVE, IBM at 41 bps).

### Market hours (equities, ETFs, commodities)
Phoenix tradfi perps have closed periods with price bounds. During a closed or after-hours period you may **hold** positions and may **reduce** them, but you may not open or increase them. **(Garuda-specific)**

The exact list of markets is determined by Phoenix's listings and the weekly review, and the current list is always on the Garuda dashboard. **(mirrors Propr's dashboard list)**

## 14. What Is NOT Restricted

| Rule | Status | Source |
| --- | --- | --- |
| Consistency rule | Only the best-day rule: best day at most 50% of profitable days. A soft gate on the pass and on payouts, never a breach (Section 9). | Path to Funded (mirrors OWNIT) |
| Minimum trading days | 3 UTC trading days to pass (Section 9). None on funded accounts. | Path to Funded (mirrors HyroTrader) |
| Time limit | None on challenges. | mirrors Propr |
| Profit cap | None. | mirrors Propr |
| News trading restriction | None. Trade during any market event. | mirrors Propr |
| Weekend holding restriction | None. Hold over weekends (tradfi markets: hold and reduce only while closed, Section 13). | mirrors Propr; closed-period limit is Garuda-specific |
| Risk-per-trade rule | None beyond leverage caps and book depth (large orders walk the book and pay real slippage). | mirrors Propr |
| Mandatory stop-loss | None (recommended). | mirrors Propr |
| Anti-gambling rule | None. The two equity limits are the only risk guardrails. | mirrors Propr |
| Strategy restrictions | None. Scalping, swing, grid etc. are permitted. | mirrors Propr |
| EA / Bot restrictions | None. Automated trading permitted through the Garuda API. | mirrors Propr |
| Copy trading restriction | None between your own accounts, subject to Section 15. | mirrors Propr |

Our philosophy: the two equity limits are the only rules that can end an account. The Path to Funded requirements (Section 9) only decide when you pass and when a payout can be requested; they never breach. How you trade within those limits is up to you. **(mirrors Propr; Path to Funded added in v1.1)**

## 15. Prohibited Conduct & Anti-Farming

While trading strategies are unrestricted, the following conduct is prohibited and results in termination of the account, forfeiture of unpaid profit, and a possible ban. **(mirrors Propr)**

### General Prohibitions
- **Exploiting platform bugs or glitches:** exploiting technical errors, latency, price-feed anomalies, or Phoenix or Solana infrastructure issues for profit. **(mirrors Propr)**
- **Account sharing or selling:** each account is tied to one individual. Transferring, selling or sharing access is prohibited. Knight NFTs are locked while Active or Funded (Section 16). **(mirrors Propr; NFT lock is Garuda-specific)**
- **Multiple identities:** operating several sign-ins or wallets to get around account caps, the revive cap or any other limit. **(Garuda-specific)**

### Anti-Farming & Anti-Gaming
1. **Opposite hedging across accounts:** opposing positions on the same or correlated instruments across two or more Garuda accounts so that one passes while the other breaches. **(mirrors Propr)**
2. **Hedging across external venues:** opposing positions on Phoenix itself, other DEX/CEX venues or other prop firms to cancel the market risk of a Garuda position. **(mirrors Propr; Phoenix named explicitly)**
3. **Third-party coordination:** coordinating offsetting positions or signals timed to exploit drawdown mechanics. **(mirrors Propr)**
4. **Account cycling:** repeatedly buying challenges or reviving knights to take maximum-risk binary bets, treating fees as lottery tickets. Revive caps in Section 17 apply. **(mirrors Propr; revive link is Garuda-specific)**
5. **Latency arbitrage and tick sniping:** exploiting the delay between Phoenix's feed and Garuda's simulated fill to capture risk-free profit. **(mirrors Propr)**
6. **Book manipulation:** placing, moving or cancelling real orders on Phoenix to move the book that Garuda fills against, or trading illiquid markets to move the mark. **(Garuda-specific; our fills depend on the live book)**
7. **Simulated or wash trading:** trades with yourself or a coordinated party with no genuine risk. **(mirrors Propr)**
8. **Multi-account use from the same location:** sharing access, or trading multiple accounts from the same device or IP in a way that evades these rules. Multiple accounts remain allowed within Section 20 caps. **(mirrors Propr)**
9. **Non-replicable or high-risk strategies:** strategies that cannot be replicated live or that carry outsized risk (for example trades that would trigger auto-deleveraging or produce exceedingly large swings in unrealized P&L). **(mirrors Propr)**
10. **Exploiting the payout interaction:** structuring payouts to manipulate balance and limits. Not applicable while drawdown is static; reserved if that changes. **(mirrors Propr; dormant)**

### Detection & Enforcement
Garuda uses automated monitoring: cross-account correlation, wallet-graph clustering, IP and device fingerprinting, trade-pattern and payout-pattern analysis, and Phoenix onchain analysis. On suspicion Garuda may request information, suspend trading or payouts pending investigation, terminate the account with no payout, and ban the individual from future challenges. Decisions are final. **(mirrors Propr)**

## 16. Knights, Tiers & Transfers

All of this section is **Garuda-specific**.

- **All tiers open:** Squire, Knight, Paladin and Ascended can all be bought directly. There is no gating and no knight is needed to buy a challenge.
- **Mint:** every paid challenge mints a new knight NFT (Metaplex Core) of the purchased tier: a Paladin challenge mints a Paladin knight. Rarity is cosmetic only and never changes rules, size or payout.
- **Passing does not change the knight.** Meeting the Path to Funded requirements (Section 9) earns the right to claim a funded account at **Lv.1 of the same tier**. The claim, identity check and review do not change the tier or level.
- **Onchain attributes:** **tier** (Squire, Knight, Paladin, Ascended), **level** (the funded level, 1 when there is no funded account) and **status** (Active, Funded, Wounded, Idle), plus wins and revives. The art follows the tier.
- **Scaling:** when the funded account levels up (Section 10A), the knight's level follows. When it graduates, the knight's tier and art change to the next tier.
- **Transfers:** locked while Active or Funded. Allowed only while Wounded or when the knight has no live or funded account. Funded accounts belong to the knight; because the knight is locked, the funded account stays with the wallet that earned it.
- **Demo:** no NFT.

## 17. Revive

All of this section is **Garuda-specific**; Propr has no resets.

- A Wounded knight can be **revived** for **20% off** the challenge fee of the tier it fell in. Revive prices: Squire $31.20, Knight $63.20, Paladin $95.20, Ascended $160.00.
- Revive starts a **new challenge** with a fresh balance, new limits and a new challenge ID. The breached account is not restored.
- The knight **revives at its current tier**, that is the tier it fell at, including any graduation earned on a funded account. It keeps its history and gains a scar. A funded breach revives into a challenge at that tier, then re-earns funded status through the full Path to Funded (Section 9). The new funded account starts at **Lv.1** (Section 10A).
- Cap: **3 revives per knight**. After that the knight is retired as a collectible and a new challenge must be bought.
- Cooldown: revive is available **24 hours** after the breach.
- The discount does not stack with other promotions. Revive needs the same payment conditions as a new challenge.
- Demo has no revive; a breached Demo can be restarted free after 1 hour.

## 18. Inactivity

| Rule | Value | Source |
| --- | --- | --- |
| Challenge accounts | No inactivity breach or expiry. Never time out. | mirrors Propr (no time limit, no inactivity fees) |
| Inactivity fees | None | mirrors Propr |
| Funded accounts | After **90 days** with no order and no payout request the account becomes **Dormant**: no fees, no breach, payouts still available, free reactivation | Garuda-specific |
| Archive | After **365 days** Dormant the account is archived (no trading). Any balance profit stays claimable by payout. | Garuda-specific |
| Demo | Resets after 30 days idle | Garuda-specific |

## 19. Sign-in and Wallets

Signing in needs no identity verification. You sign in with a wallet, or with an email that is linked to a wallet, through Privy. A one-time identity check is required before a funded account opens (Section 9, rule 6).

| Rule | Value | Source |
| --- | --- | --- |
| Sign-in methods | Connect a Solana wallet (Phantom, Solflare, Backpack), or sign in with an email. Email sign-in creates an embedded Solana wallet for you on first login. Signing a message with a browser wallet remains available as a fallback. | Garuda-specific |
| Provider | Privy. Garuda verifies the Privy login on the server and maps it to your Solana wallet address. | Garuda-specific |
| Before purchase and trading | Sign in, nothing else. Trade immediately after purchase. | Garuda-specific |
| Before funded activation | Pass the challenge (Section 9 rules 1 to 4), claim it, complete the identity check (government ID and live selfie) and clear the risk review (about 1 business day) | Path to Funded |
| Before payout | Being signed in with the account's wallet; the identity check was already done at funded activation | Garuda-specific |
| Payout destination | The wallet you are signed in with. A payout is never sent to a different wallet than the one that requested it. | Garuda-specific |
| Paying | USDC from either kind of wallet. The embedded wallet signs the same USDC transfer as an external wallet; it needs USDC (and a little SOL for network fees) deposited to it. | Garuda-specific |
| Identity documents | Collected once for the funded-account identity check (Section 9, rule 6), not for sign-in or challenges | Path to Funded |

Your account follows your wallet address. If you sign in with email, keep access to that email: losing it means losing access to the embedded wallet, and Garuda cannot recover it for you.

## 20. Account Limits

A trader may hold multiple active accounts, aggregated per wallet (and across wallets Garuda can tie together, for example by shared funding):

- Evaluation accounts: up to **$200,000** aggregate account size **(mirrors Propr)**
- Funded accounts: up to **$300,000** aggregate balance **(mirrors Propr)**. A funded level up that would exceed it is held until there is room (Section 10A). **(Garuda-specific)**
- Duplicate sizes: allowed, within the caps **(mirrors Propr v1.0.1)**
- Demo: one active Demo per wallet **(Garuda-specific)**

Example: eight $25,000 evaluations at once, or twelve $25,000 funded accounts. **(mirrors Propr)**

## 21. Transparency

- Phase 1: every order, fill and risk event is written to an append-only log, and the combat log is public per knight. Tier, level and status are onchain in the knight's Attributes. **(Garuda-specific)**
- Phase 2: periodic Merkle-root commitment of challenge results onchain; payout transactions published; aggregate transparency stats (challenges sold, pass rate, payouts, treasury). **(mirrors Propr's transparency goals)**
- Rules changelog is public and never retroactive (Section 27). **(mirrors Propr)**

## 22. Trade Execution & Capital Allocation

**Phase 1: simulation only.** Orders are filled by Garuda's matching simulator against the live Phoenix L2 book. Nothing is sent to Phoenix. Every account shows a "SIMULATED ACCOUNT" badge. **(Garuda-specific)**

- **Market orders** walk the live book level by level, paying real slippage. Unfilled remainder is cancelled.
- **Limit orders** fill when the book crosses the limit, at the limit price, as maker.
- Fees are Phoenix's: 0.035% taker, 0.005% maker.
- Funding follows Phoenix's hourly funding.
- Phase 1 has no builder-code fee on traders.

**Phase 2: A-book / B-book.** Garuda may route selected funded trades to a firm-owned Phoenix account using a trade-only delegate key on isolated subaccounts, labelled per trade as in Propr. Builder-code fees on routed orders are firm revenue and never charged to the trader. **(mirrors Propr's hybrid model, with conflict-of-interest disclosures to be adopted in full)**

Funded traders do not own any account, position or capital on the firm's books; the funded account is a performance-tracking mechanism for payout eligibility. **(mirrors Propr)**

## 23. Fees & Costs

- **Challenge fee:** one-time, non-refundable (Section 2). **(mirrors Propr)**
- **Trading fees:** Phoenix maker/taker passed through at cost, no markup: 0.035% taker, 0.005% maker. Deducted from balance and counted in P&L and equity limits. **(mirrors Propr's pass-through; Phoenix rates are Garuda's reference)**
- **Funding:** Phoenix hourly funding is accrued to balance and included in equity. **(mirrors Propr)**
- **No hidden fees:** no monthly, inactivity, data, platform or withdrawal fees. **(mirrors Propr)**

## 24. Risk Acknowledgment

By purchasing a Garuda challenge, you acknowledge and accept:

1. Most traders do not pass. There is no guarantee of success. **(mirrors Propr)**
2. Challenge fees are non-refundable. **(mirrors Propr)**
3. Funded accounts can be lost under the same drawdown rules. **(mirrors Propr)**
4. Past performance is not indicative of future results. **(mirrors Propr)**
5. Crypto and perpetual markets are volatile and losses can be sudden. **(mirrors Propr)**
6. Leverage amplifies risk. **(mirrors Propr)**
7. You are not trading your own capital. Accounts are simulated; you are eligible for performance-based payouts only. **(mirrors Propr)**
8. A knight NFT is a collectible. Its rarity gives no trading advantage and no value is promised. **(Garuda-specific)**
9. Rules may be updated with reasonable notice, are never changed retroactively, and active funded accounts keep the rules in effect at activation. **(mirrors Propr)**

## 25. Quick Reference Card

| Parameter | Challenge | Funded |
| --- | --- | --- |
| Profit target | 10% of starting balance, closed profit only, flat to pass | None |
| Max daily loss | 3% of start-of-day balance, resets 00:00 UTC | Same |
| Max drawdown | 6% static from starting balance | Same |
| Drawdown type | Equity-based, static | Same |
| Leverage (BTC/ETH/SOL) | 10x | 10x |
| Leverage (other crypto) | 2x | 2x |
| Leverage (single stocks) | 4x | 4x |
| Leverage (SPY, QQQ) | 10x | 10x |
| Leverage (TLT) | 5x | 5x |
| Leverage (Gold, Silver, WTI) | 8x | 8x |
| Leverage (Copper) | 5x | 5x |
| Markets | 46 whitelisted Phoenix markets, weekly review | Same |
| Profit split | N/A | 80% to trader |
| Payouts | Not available | On demand, USDC, within 24h, $20 min |
| Identity checks | None to buy or trade | Once, before the funded account opens; payouts go to the signed-in wallet |
| Time limit | None | None |
| Minimum trading days | 3 UTC days with a position opened or closed | None |
| Best-day rule | Best day at most 50% of profitable days (soft gate on pass) | Same, per payout cycle (soft gate on payouts) |
| Funded activation | Claim, identity check, risk review (about 1 business day) | |
| Inactivity | None | Dormant at 90 days, free reactivation |
| Breach | Permanent for the account; knight Wounded | Same |
| Scaling | N/A | Lv.1 at the challenge size; +1 level at 5% profit and 1 paid payout; Lv.3 graduates to the next tier; Ascended to $100k |
| Revive | 20% off, current tier, 3 per knight, 24h cooldown | Revives into a challenge; re-funded at Lv.1 |
| Caps | $200k evaluation / $300k funded aggregate | |

## 26. Support & Contact

Support channel: Discord (to be set up). **(mirrors Propr; handle TBD)**

## 27. Changelog

Every rule change is documented here with the date it took effect. We never change rules retroactively. **(mirrors Propr)**

**2026-11-11 · v1.2 Funded scaling**
- ✓ All four tiers open to buy; no knight gating. Every paid challenge mints a knight of the purchased tier
- ✓ Passing no longer promotes the knight; the funded account opens at Lv.1 of the tier
- ✓ Funded level up: 5% profit of the current size and 1 paid payout since the last level up, applied automatically when flat
- ✓ Sizes: Squire $5k / $6,666.67 / $8,333.33, Knight $10k / $11,666.67 / $13,333.33, Paladin $15k / $18,333.33 / $21,666.67, then the next tier's Lv.1; Ascended +$5k per level to $100k at Lv.16
- ✓ Drawdown floor and daily limit reset to the new size on each level up; split stays 80%, $20 minimum payout
- ✓ Knight NFT attributes are tier, funded level and status; graduation changes the tier and art
- ✓ Breach revives into a challenge at the current tier; re-funding starts at Lv.1
- ✓ Existing funded accounts start at Lv.1

**2026-11-11 · v1.1 Path to Funded**
- ✓ Profit target counts closed (realized) balance only; open profit does not pass
- ✓ Must be flat to pass; no auto close on pass, no automatic funded account
- ✓ Minimum 3 UTC trading days (a position opened or closed; non-consecutive)
- ✓ Best-day rule: best day at most 50% of profitable days (soft gate on pass and payouts)
- ✓ Trader claims the funded account; identity check (KYC) and a risk review of about 1 business day before it opens
- ✓ First payout on demand once funded, in profit, flat, $20 minimum and best-day rule met; no waiting period
- ✓ Tier table corrected to the live pricing: Squire $5k/$39, Knight $10k/$79, Paladin $15k/$119, Ascended $25k/$200

**2026-11-04 · v1.0 draft**
- ✓ One-Step challenge: 10% target, 3% daily loss (start-of-day balance, 00:00 UTC), 6% static max drawdown, 80% split, no time limit, no minimum trading days
- ✓ Tiers: Demo $5k free, Squire $10k/$119, Knight $25k/$275, Paladin $50k/$499, Ascended $100k/$899
- ✓ Leverage caps per Propr's table, mapped to Phoenix markets
- ✓ Liquidity-filtered market whitelist (46 markets)
- ✓ Revive: 20% off, same level, 3 per knight
- ✓ USDC payouts, $20 minimum, sent to the signed-in wallet (Privy sign-in, no identity checks)
