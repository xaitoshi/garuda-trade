# Garuda core

Core engine for **Garuda**, a gamified onchain prop firm on Phoenix Perps (Solana). Traders pass a one-step challenge on a **simulated** account that trades against the **live Phoenix L2 book**, then get funded and paid out in USDC. Phase 1 is simulation only: nothing is ever sent to Phoenix.

The rules implemented here are the settled "Garuda Trading Rules" (Notion page, copy at `garuda/rules.md`): Demo $5k free, Squire $10k, Knight $25k, Paladin $50k, Ascended $100k; 10% target, 6% **static** max drawdown, 3% daily loss on start-of-day balance, 80% split, no time limit, no minimum days.

## Quick start

```bash
pnpm install
pnpm test            # 81 tests + 1 opt-in live-network test (LIVE=1 pnpm test)
pnpm typecheck
pnpm demo            # $25k challenge against the LIVE Phoenix book (falls back to recorded books)
pnpm demo:mock       # force the recorded-book fallback
pnpm api             # Fastify service on :3000 (PORT to change)
```

Node 20+, pnpm 10. Copy `.env.example` to `.env`. `PHOENIX_BUILDER_CODE` is a placeholder: Phase 1 never routes orders, so it is not used (builder codes only matter for real routed orders in Phase 2). No keys are needed for Phase 1: the Phoenix REST API is public.

## Architecture

```
                        ┌───────────────────────────────┐
  Phoenix Perps REST ──▶│ @garuda/market-data           │  PhoenixSdkProvider (Rise SDK, read-only)
  (orderbook, stats,    │  MarketDataProvider interface │  ReplayProvider (recorded real books)
   markets, funding)    │                               │  OverlayProvider (scripted price moves)
                        └──────────────┬────────────────┘
                                       │ MarketSnapshot {book, mark, funding, tradable}
        ┌──────────────────────────────▼───────────────────────────────┐
        │ @garuda/api  ChallengeService (+ Fastify routes)             │
        │  create / state / orders / tick, per-challenge serialisation │
        │  pre-trade gates: whitelist, stale feed, closed market,      │
        │  circuit breaker, margin-style leverage cap                  │
        └───────┬──────────────────────────────┬───────────────────────┘
                │ orders, books, funding       │ (balance, equity, now)
   ┌────────────▼─────────────┐     ┌──────────▼───────────────────┐
   │ @garuda/sim-engine       │     │ @garuda/risk-engine          │
   │  SimAccount ledger       │     │  RULES (tiers, caps, markets)│
   │  SimEngine: market walks │     │  RiskMonitor: floors, UTC    │
   │  the L2 book, limit fills│     │   reset, warnings 50/80,     │
   │  on cross, fees, funding │     │   breach (Wounded), pass     │
   │  positions, PnL, equity  │     │  leverage check, payouts     │
   └──────────────────────────┘     │  combat-log text             │
                                    └──────────────────────────────┘
```

Packages are "just in time" TypeScript: each exports `src/index.ts` directly, run with `tsx` / Vitest. There is no build step yet.

### `@garuda/sim-engine`
Deterministic and network-free: callers pass in an `L2Book` and a timestamp.
- **Market orders** walk the book level by level (real slippage, partial fill if the book is thin, remainder dropped).
- **Limit orders**: the crossing part fills immediately as taker (never worse than the limit); the rest rests. Later book updates (`onBook`) fill resting orders **as maker at the limit price**, capped by the crossing size. Post-only and reduce-only supported.
- **Fees**: 0.035% taker, 0.005% maker (`PHOENIX_FEES`). Optional latency penalty in bps.
- **Funding**: hourly rate (fraction), accrued pro rata: `payment = size × mark × rate × hours`; longs pay when the rate is positive.
- **Accounting**: average-entry positions with flips, `balance` = realized cash, `equity` = balance + unrealized at the latest mark. `closeAll` flattens at the book (remainder the book cannot absorb closes at mark minus a 100 bps haircut, flagged `forced`).

### `@garuda/risk-engine`
- `RiskMonitor.evaluate({balance, equity, now})` returns events: `day_reset`, `warning` (50% / 80% of either buffer, with hysteresis so each fires once per cycle), `breach` (equity ≤ effective floor, no grace; reports the binding rule and whether both broke), `pass` (equity ≥ target). Breach is checked before pass; both are terminal.
- Floors: `daily = SOD balance × 0.97` (SOD snapshotted from the last evaluated **balance** at 00:00 UTC, measured on **equity**); `static DD = start × 0.94`, never trails; effective floor = the higher one.
- `snapshot()` gives the dashboard numbers: HP (daily buffer left), armor (DD buffer left), boss HP (distance to target), seconds to reset.
- Leverage (rulebook §12): required margin = Σ notional at mark ÷ class cap; an order that raises it above equity is rejected; reducing orders always allowed. Caps: BTC/ETH/SOL 10x, other crypto 2x, stocks 4x, SPY/QQQ 10x, TLT 5x, GOLD/SILVER/WTIOIL 8x, COPPER 5x. 46-market whitelist.
- `fillsToCombat` / `riskEventToCombat` produce the combat log (`Sir Pudding strikes for +$312 (SOL long closed)`), aggregated per order.
- `quotePayout`: (balance − start) × 80%, $20 minimum, flat book required, resets to starting balance.

### `@garuda/api`
In-memory store behind a `ChallengeStore` interface (swap for SQLite/Postgres). Every operation on a challenge is serialised. On breach or pass the service flattens the book and locks the challenge.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/challenges` | `{tier, knight?, wallet?, stage?, nftLevels?}` create (201). Paladin/Ascended need the previous NFT level in `nftLevels` (403 `tier_locked`) |
| GET | `/challenges/:id` | state (refreshes marks, funding, resting orders and risk first; `?refresh=false` to skip) |
| POST | `/challenges/:id/orders` | `{symbol, side, size, type, limitPrice?, reduceOnly?, postOnly?}`; 201 accepted, 422 rejected with `reason`, 409 if the challenge is no longer active |
| DELETE | `/challenges/:id/orders/:orderId` | cancel a resting order |
| POST | `/challenges/:id/tick` | force a refresh (a worker would call this on a timer / stream) |
| GET | `/challenges/:id/combat-log` | combat log |
| GET | `/rules`, `/health`, `/challenges` | rules as code, health (reports whether a builder code is configured, never the value), list |

Pre-trade gates (opening orders only; reduce-only always passes): market whitelisted, feed fresh (2 s), market open (Phoenix tradfi closed periods are reduce-only), circuit breaker (spread > 100 bps or ±0.5% side depth < $10k), margin-style leverage cap.

### `@garuda/market-data`
`PhoenixSdkProvider` uses `@ellipsis-labs/rise` (`client.api.orderbook().getOrderbook`, `markets().getLatestMarketStats`, `markets().getMarkets`). Verified live: 100-level books, mark, funding, market status and tradfi session flags. `current_funding_rate` from the live API is in **percent per hour**; the provider divides by 100 (the docs example shows a fraction, the live values match `annualized_funding_rate` only as percent). `fixtures/phoenix-books.json` holds recorded real books (`pnpm fixtures:record`) used by tests and as the offline fallback.

## Tests

`pnpm test`: sim-engine (book walks, fees, limits, reduce-only, flips, funding, closeAll), risk-engine (daily reset and rebasing, static drawdown, warnings, breach, pass, leverage, combat log, payouts), api (create, gating, orders, breach/pass through HTTP, rollover + funding, circuit breaker, closed markets), market-data (replay, status mapping, optional live smoke).

## Decisions and assumptions to review

- Floors and targets are rounded to cents.
- The SOD snapshot uses the last **evaluated** balance, so the service must evaluate regularly (the API evaluates on every tick, order and state read). A worker should tick active challenges at least once around 00:00 UTC.
- Pass or breach closes the book at the live L2 book; the pass is locked in even if close-out costs push equity slightly under target.
- A resting limit order is only leverage-checked at placement (not again when it fills).
- Maker fills assume the whole crossing size is available to us (`makerFillRatio` = 1, optimistic). Tune toward queue-position modelling before real money depends on it.
- Open items still needing owner confirmation are in the rulebook's Appendix B (level gating semantics, revive cap, whitelist thresholds, 2x other-crypto cap, dormancy, restricted countries).

## Known gaps

- No persistence (in-memory), no auth, no rate limiting. `nftLevels` on create is trusted input until NFT ownership is verified on chain.
- Price feed is request/response REST on each tick; a streaming feed (Rise `streams` / `orderbooks`) is needed for live dashboards and tight breach detection. Between ticks a breach is not detected.
- No revive flow, KYC, inactivity/dormancy, account caps ($200k/$300k), or payout execution yet (the payout quote function exists).
- No isolated-margin / commodity-specific simulation: Phoenix has isolated-only markets, here everything is cross for rule purposes.
- Funding is accrued pro rata at each tick using the current rate, not by replaying historical hourly settlements.
- Demo script moves prices with a scenario overlay on the real book; real prices do not move on demo timescales.

## Next steps

1. **Metaplex Core knight NFTs**: mint a Squire-level knight on every paid Squire/Knight challenge; store level, scars, revive count, challenge history as plugin attributes; verify ownership for Paladin/Ascended gating (replace trusted `nftLevels`); wounded/revive state transitions (rulebook §16-17).
2. **Persistence + worker**: SQLite/Postgres `ChallengeStore`, append-only fills/events, a worker that streams Phoenix books and evaluates risk continuously and at 00:00 UTC.
3. **Frontend**: dashboard (HP / armor / boss bars, positions, combat log feed), trade ticket, Fallen screen, leaderboard.
4. **Payments and payouts**: USDC fee collection on Solana, KYC gate before funded activation, payout requests via treasury multisig (Phase 1 manual review), revive pricing.
5. **Phase 2**: route selected funded trades to a firm Phoenix account using `PHOENIX_BUILDER_CODE` (builder-code fees are firm revenue, never charged to traders), with the A-book/B-book disclosures from the rulebook.
