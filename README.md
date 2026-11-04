# Garuda core

Core engine for **Garuda**, a gamified onchain prop firm on Phoenix Perps (Solana). Traders pass a one-step challenge on a **simulated** account that trades against the **live Phoenix L2 book**, then get funded and paid out in USDC. Phase 1 is simulation only: nothing is ever sent to Phoenix.

The rules implemented here are the settled "Garuda Trading Rules" (Notion page, copy at `garuda/rules.md`): Demo $5k free, Squire $10k, Knight $25k, Paladin $50k, Ascended $100k; 10% target, 6% **static** max drawdown, 3% daily loss on start-of-day balance, 80% split, no time limit, no minimum days.

## Quick start

```bash
pnpm install
pnpm test            # 196 tests pass + 2 skipped (see Tests); Postgres tests run on pg-mem
pnpm test:pg         # same suite with the Postgres tests on REAL Postgres (embedded, no docker needed)
pnpm typecheck
pnpm demo            # $25k challenge against the LIVE Phoenix book (falls back to recorded books)
pnpm demo:mock       # force the recorded-book fallback
docker compose up -d db && cp .env.example .env
pnpm api             # API + streaming risk worker on :3000 (PORT to change)
```

Node 20+, pnpm 10. `PHOENIX_BUILDER_CODE` is a placeholder: Phase 1 never routes orders, so it is not used (builder codes only matter for real routed orders in Phase 2). No keys are needed for Phase 1: the Phoenix REST API is public. Without `DATABASE_URL` the server uses an in-memory store and loses everything on restart.

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

```
  browser / wallet ──HTTP──▶ Fastify (@garuda/api)  ── sign-in, ownership, rate limits ──┐
                                      │                                                    │
                                      ▼                                                    ▼
                              ChallengeService  ◀── onMarketUpdate(snapshot) ── RiskWorker (@garuda/worker)
                                      │                                             ▲   │ stale-feed halt,
                                      ▼                                             │   │ dormancy sweep
                         ChallengeStore (memory | Postgres)                  MarketFeed (PollingFeed today,
                         append-only fills / funding / events                Rise websocket later)
```

API and worker run in one process (`pnpm api`) because they share the in-process challenge cache. Packages are "just in time" TypeScript: each exports `src/index.ts` directly, run with `tsx` / Vitest. There is no build step yet.

### `@garuda/sim-engine`
Deterministic and network-free: callers pass in an `L2Book` and a timestamp.
- **Market orders** walk the book level by level (real slippage, partial fill if the book is thin, remainder dropped).
- **Limit orders**: the crossing part fills immediately as taker (never worse than the limit); the rest rests. Later book updates (`onBook`) fill resting orders **as maker at the limit price**, capped by the crossing size. Post-only and reduce-only supported.
- **Fees**: 0.035% taker, 0.005% maker (`PHOENIX_FEES`). Optional latency penalty in bps.
- **Funding**: hourly rate (fraction), accrued pro rata: `payment = size × mark × rate × hours`; longs pay when the rate is positive.
- **Accounting**: average-entry positions with flips, `balance` = realized cash, `equity` = balance + unrealized at the latest mark. `closeAll` flattens at the book (remainder the book cannot absorb closes at mark minus a 100 bps haircut, flagged `forced`).

### `@garuda/risk-engine`
- `RiskMonitor.evaluate({balance, equity, now})` returns events: `day_reset`, `warning` (50% / 80% of either buffer, with hysteresis so each fires once per cycle), `breach` (equity at or below the effective floor, no grace; reports the binding rule and whether both broke), `pass` (equity at or above target). Breach is checked before pass; both are terminal.
- Floors: `daily = SOD balance × 0.97` (SOD snapshotted from the last evaluated **balance** at 00:00 UTC, measured on **equity**); `static DD = start × 0.94`, never trails; effective floor = the higher one.
- `snapshot()` gives the dashboard numbers: HP (daily buffer left), armor (DD buffer left), boss HP (distance to target), seconds to reset.
- Leverage (rulebook §12): required margin = Σ notional at mark ÷ class cap; an order that raises it above equity is rejected; reducing orders always allowed. Caps: BTC/ETH/SOL 10x, other crypto 2x, stocks 4x, SPY/QQQ 10x, TLT 5x, GOLD/SILVER/WTIOIL 8x, COPPER 5x. 46-market whitelist.
- `fillsToCombat` / `riskEventToCombat` produce the combat log (`Sir Pudding strikes for +$312 (SOL long closed)`), aggregated per order.
- `quotePayout`: (balance − start) × 80%, $20 minimum, flat book required, resets to starting balance.

### `@garuda/db`
`pg` driver (no ORM) plus plain SQL migrations in `packages/db/migrations`, applied in order at startup and recorded in `schema_migrations` (each in its own transaction).

| Migration | What |
| --- | --- |
| 001_ledger | `challenges` (lifecycle, activity, breach time, revive chain, JSON state), `orders`, `fills`, `funding_payments`, `risk_events`, `combat_log` |
| 002_auth | `auth_nonces`, `sessions` (token stored as a SHA-256 hash) |
| 003_account_idempotency | `revive_requests` (idempotency keys) |
| 004_append_only | Postgres only: triggers that reject UPDATE and DELETE on `fills`, `funding_payments`, `risk_events`, `combat_log` (pg-mem skips it) |

`SimAccount.restore` rebuilds balance, positions (average entry, flips), fees and funding from the fills and funding payments, so the ledger is the source of truth and the cached balance is checked against a replay (`PgChallengeStore.verifyLedger`). Tests use pg-mem by default; `GARUDA_TEST_PG=embedded` (or `GARUDA_TEST_DATABASE_URL`) runs the same tests on real Postgres.

### `@garuda/api`
`ChallengeService` over an async `ChallengeStore` (`InMemoryChallengeStore` or `PgChallengeStore`). Every operation on a challenge is serialised; account creation is serialised per wallet so caps cannot be raced. On breach or pass the service flattens the book and locks the challenge.

**Wallet sign-in (Sign-In with Solana, no transaction, no fee).** `POST /auth/nonce {wallet}` returns a single-use nonce (5 min) and the exact message to sign. The wallet signs it with `signMessage` (Ed25519). `POST /auth/verify {wallet, nonce, signature}` (base58 or base64) verifies with `node:crypto`, burns the nonce (even on a bad signature), and returns an opaque session token (24 h, only its hash is stored). Send `Authorization: Bearer <token>` on every `/challenges` route. A challenge belongs to the wallet that created it: another wallet gets 403 `not_owner`, `wallet` in the create body must match the session, and `GET /challenges` lists only your own.

**Rate limits** (fixed window, in process, defaults in `rate-limit.ts`): 300 requests/min per IP, 120/min per wallet, 20/min per IP on `/auth/*`, 30 orders per 10 s per wallet. 429 `rate_limited` with `Retry-After` and `X-RateLimit-*` headers; `/health` is exempt. Behind a proxy set `GARUDA_TRUST_PROXY=1`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/nonce`, `/auth/verify`, `/auth/logout` | wallet sign-in, session revoke |
| GET | `/auth/me` | wallet behind the token |
| POST | `/challenges` | `{tier, knight?, stage?, nftLevels?}` create (201) under the signed-in wallet. 403 `tier_locked`, `evaluation_cap_exceeded`, `funded_cap_exceeded`; 409 `demo_exists`; 429 `demo_cooldown` |
| GET | `/challenges`, `/challenges/:id` | list yours; state (refreshes marks, funding, resting orders and risk first; `?refresh=false` to skip) |
| POST | `/challenges/:id/orders` | `{symbol, side, size, type, limitPrice?, reduceOnly?, postOnly?}`; 201 accepted, 422 rejected with `reason` (including `feed_halted`), 409 if not active or archived |
| DELETE | `/challenges/:id/orders/:orderId` | cancel a resting order |
| POST | `/challenges/:id/tick` | force a refresh |
| GET | `/challenges/:id/combat-log` | combat log |
| GET / POST | `/challenges/:id/revive` | revive quote and eligibility / revive (header `Idempotency-Key`; 201, or 200 on a replay) |
| POST | `/challenges/:id/reactivate` | free wake-up of a Dormant funded account |
| GET | `/challenges/:id/payout-quote` | payout quote (funded, not breached, not Demo); payout execution is still roadmap |
| GET | `/rules`, `/health`, `/metrics` | rules as code, health (never reveals the builder code), worker metrics |

Pre-trade gates (opening orders only; reduce-only always passes): market whitelisted, feed fresh (2 s) and not halted by the worker, market open (Phoenix tradfi closed periods are reduce-only), circuit breaker (spread over 100 bps or side depth within 0.5% below $10k), margin-style leverage cap.

**Account rules in the service**
- *Caps (rulebook 20):* aggregate evaluation size per wallet at most $200,000, aggregate funded at most $300,000, counted over live accounts (active, not breached, not archived; Demo exempt). Checked on create and on revive.
- *Free Demo:* $5,000, no NFT and no knight id, no payouts, no funded stage, one active per wallet (409), restart allowed 1 hour after a breach (429 before), cannot be revived.
- *Dormancy (rulebook 18):* a funded account with no order or payout request for 90 days goes Dormant (keeps its risk checks, trading or `reactivate` wakes it for free); 365 days later it is Archived (flattened at the last known books, no trading, leaves the caps). Challenge accounts never time out. `sweepLifecycle` applies it; the worker runs it hourly, and a long outage steps through both transitions.
- *Revive (rulebook 17):* Wounded knights only, 24 hours after the breach, 20% off the same tier (Knight $275 becomes $220), at most 3 per knight across its whole chain, a fresh evaluation account for the same knight (scar count +1, new id, the breached account is kept as history). Payment goes through a `PaymentProvider`; the shipped `StubPaymentProvider` always succeeds (real USDC checkout is roadmap M4) and a decline (402) creates nothing. An `Idempotency-Key` makes a retry return the first result with no second charge.
- *Fill-time leverage re-check:* a resting limit order is checked again when it fills, at the fill price and including the maker fee. If equity has fallen so the full size no longer fits, the fill is trimmed to the largest size that does and the rest is cancelled (`leverage_cap_exceeded`, with a combat-log warning). Reduce-only orders always fill.

### `@garuda/worker`
`RiskWorker` consumes a `MarketFeed` (`@garuda/market-data`: `PollingFeed` over any provider today, `ManualFeed` for tests and replays; a Rise websocket feed implements the same interface). It watches only symbols with a live position or resting order and calls `service.onMarketUpdate(snapshot)` for each update: marks, funding, resting fills with the leverage re-check, then the full risk evaluation, so a breach is caught when the price moves rather than at the next API call. Out-of-order snapshots are ignored.
- *Stale-feed kill switch:* no update for 10 s (`GARUDA_STALE_FEED_MS`) halts new exposure in that symbol (`feed_halted`); closing and risk checks continue; the next update lifts it.
- *Metrics* at `/metrics`: updates, errors, breaches caught, resting fills, p50/p99/max latency from snapshot time to persisted evaluation, halted and watched symbols and their age.
- Runs the dormancy/archive sweep at start and hourly. One update that throws is counted and reported, never fatal.

### `@garuda/market-data`
`PhoenixSdkProvider` uses `@ellipsis-labs/rise` (`client.api.orderbook().getOrderbook`, `markets().getLatestMarketStats`, `markets().getMarkets`). Verified live: 100-level books, mark, funding, market status and tradfi session flags. `current_funding_rate` from the live API is in **percent per hour**; the provider divides by 100 (the docs example shows a fraction, the live values match `annualized_funding_rate` only as percent). `fixtures/phoenix-books.json` holds recorded real books (`pnpm fixtures:record`) used by tests and as the offline fallback.

## Tests

`pnpm test` runs 198 tests (196 pass, 2 skipped: one needs `LIVE=1` network, one needs real Postgres). `pnpm test:pg` (GARUDA_TEST_PG=embedded) runs the real-Postgres ones too: 197 pass.

| Package | Tests | Covers |
| --- | --- | --- |
| sim-engine | 30 | book walks, fees, limits, reduce-only, flips, funding, closeAll; ledger replay equals live state |
| risk-engine | 50 | floors, reset, warnings, breach, pass, leverage, combat log, payouts; caps, dormancy, revive, demo rules as pure functions |
| market-data | 10 (1 skipped) | replay, status mapping, PollingFeed (errors, overlap, timers), ManualFeed |
| db | 4 (1 skipped) | migrations, idempotence, rollback on failure, append-only triggers (real Postgres only) |
| api | 89 | original 18 API tests unchanged, plus sign-in (valid, bad signature, replayed and expired nonce, expired session, 403 on foreign accounts), rate limits, caps, demo, dormancy and archive, revive (cooldown, price, cap of 3, idempotency, declined payment), fill-time leverage trim, Postgres restart and ledger replay |
| worker | 15 | breach caught from a dip that recovers before the next poll, seeded 600-step replay against an independent equity oracle (zero missed breaches, each caught on the exact update), stale-feed halt and recovery, metrics, resilience, dormancy sweep, end to end with PollingFeed |

## Decisions and assumptions to review

- Floors and targets are rounded to cents.
- The SOD snapshot uses the last **evaluated** balance, so the service must evaluate regularly (the API evaluates on every tick, order and state read). A worker should tick active challenges at least once around 00:00 UTC.
- Pass or breach closes the book at the live L2 book; the pass is locked in even if close-out costs push equity slightly under target.
- A resting limit order is leverage-checked at placement and again at fill time (trim, never reject silently).
- Maker fills assume the whole crossing size is available to us (`makerFillRatio` = 1, optimistic). Tune toward queue-position modelling before real money depends on it.
- Archiving flattens open positions at the last known books (assumption: archived accounts do not trade). Dormant accounts keep their equity limits.
- The funded cap is measured by account size (starting balance), not current equity. Revive counts per knight across the revive chain.
- A breached account is kept as history; a revive opens a new account, it does not restore the old one.
- Open items still needing owner confirmation are in the rulebook's Appendix B (level gating semantics, revive cap, whitelist thresholds, 2x other-crypto cap, dormancy, restricted countries).

## Known gaps

- `nftLevels` on create is still trusted input until NFT ownership is verified on chain (M3). KYC (M7), real USDC payment for revives and fees (M4) and payout execution (M8) are not built; the payment provider is a stub.
- Price feed is polling (default 1 s) over Phoenix REST. A Rise websocket feed is not built; worst-case detection delay is about the poll period plus request latency. Phoenix `markPrice` is replaced by the book mid on each book update (existing behaviour).
- Single process: the challenge cache and the worker index live in memory, so run one API-plus-worker process per database. Several replicas need a shared cache or the worker split out (Redis for the books/equity cache is not built).
- Rate limits are per process (fixed window, in memory); with several replicas the effective limit multiplies. A Redis-backed limiter is the upgrade.
- Order placement has no idempotency key yet (only revive does). Demo 30-day idle reset (rulebook 18) is not implemented.
- Real Postgres tests are opt-in (`pnpm test:pg` or `GARUDA_TEST_DATABASE_URL`); the default run uses pg-mem, which does not run the append-only triggers.
- No isolated-margin / commodity-specific simulation: Phoenix has isolated-only markets, here everything is cross for rule purposes.
- Funding is accrued pro rata at each update using the current rate, not by replaying historical hourly settlements.
- Demo script moves prices with a scenario overlay on the real book; real prices do not move on demo timescales.

## Next steps

1. **Metaplex Core knight NFTs** (M3): mint a Squire-level knight on every paid Squire/Knight challenge; store level, scars, revive count and history as plugin attributes; verify ownership for Paladin/Ascended gating (replace trusted `nftLevels`).
2. **Rise websocket feed** and a shared cache (Redis) so the API and worker can scale past one process.
3. **Frontend**: dashboard (HP / armor / boss bars, positions, combat log feed), trade ticket, Fallen screen with the revive quote, leaderboard.
4. **Payments and payouts** (M4, M7, M8): USDC fee and revive collection on Solana behind the existing `PaymentProvider`, KYC gate before funded activation, payout requests via treasury multisig.
5. **Phase 2**: route selected funded trades to a firm Phoenix account using `PHOENIX_BUILDER_CODE` (builder-code fees are firm revenue, never charged to traders), with the A-book/B-book disclosures from the rulebook.
