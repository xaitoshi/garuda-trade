# Garuda core

Core engine for **Garuda**, a gamified onchain prop firm on Phoenix Perps (Solana). Traders pass a one-step challenge on a **simulated** account that trades against the **live Phoenix L2 book**, then get funded and paid out in USDC. Phase 1 is simulation only: nothing is ever sent to Phoenix.

The rules implemented here are the settled "Garuda Trading Rules" (Notion page, copy at `garuda/rules.md`): Demo $5k free, Squire $10k, Knight $25k, Paladin $50k, Ascended $100k; 10% target, 6% **static** max drawdown, 3% daily loss on start-of-day balance, 80% split, no time limit, no minimum days.

## Quick start

```bash
pnpm install
pnpm test            # 296 tests pass + 3 skipped (see Tests); Postgres tests run on pg-mem; no network or SOL needed
pnpm test:pg         # same suite with the Postgres tests on REAL Postgres (embedded, no docker needed)
pnpm typecheck
pnpm demo            # $25k challenge against the LIVE Phoenix book (falls back to recorded books)
pnpm demo:mock       # force the recorded-book fallback
docker compose up -d db && cp .env.example .env
pnpm api             # API + streaming risk worker on :3000 (PORT to change)
pnpm chain:setup     # one-time Solana DEVNET setup: platform key, knight collection, test USDC mint (see Solana devnet)
pnpm web:stub        # stub API on :3000: real engine, fake knights and fake USDC, recorded books (for the web app)
VITE_DEV_WALLET=1 pnpm web:dev   # web app on :5173, /api proxied to :3000 (see Web app)
pnpm web:screens     # drive the real UI with Playwright and write docs/screens/*.png
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

### `@garuda/chain`
Solana **devnet only** (every client refuses mainnet-looking RPC URLs, and `assertDevnetCluster` checks the genesis hash at server start). Two seams, each with a real and an in-memory implementation:
- `KnightNft`: `MetaplexCoreKnights` (Metaplex Core, `mpl-core` 1.10 through Umi) and `FakeKnights`. A knight is a Core asset in the Garuda Knights collection (Royalties plugin on the collection, 5% default) with an **Attributes** plugin (`level` squire/knight/paladin/ascended, `status` active/funded/wounded/ascended/idle, `tier`, `challenge_id`, `wins`, `revives`) and a **PermanentFreezeDelegate** whose authority is the platform. `frozen` is the transfer lock: the owner cannot lift it (a plain FreezeDelegate would let him revoke it).
- `UsdcChain`: `SolanaUsdc` (verify an incoming transfer, send a refund) and `FakeUsdc`.
- `deriveKnightState(history)` is the single rule for what a knight's onchain state must be (level from passed evaluations and never lowered, wins, revives = scars, frozen while any challenge is live, status). It is a pure function of challenge history, so every sync is idempotent and a retry after an RPC failure converges.
- The asset address of a knight is derived from the order id (HMAC of the platform secret and the order id), so a retried mint returns the same asset and can never create a second knight. The refund transaction carries a key derived the same way, so an earlier refund is found on chain instead of paid twice.
- Metadata: one JSON file per level (`levelMetadataUri`) pointing at the PNGs in `garuda-landing/knights` (knight-1.png Squire to knight-4.png Ascended). The asset URI moves to the next level file on level-up. The API serves them at `/nft/collection.json`, `/nft/metadata/<level>.json` and `/nft/images/knight-N.png` (public, static; swap for Arweave/Irys later, which only changes `GARUDA_PUBLIC_URL`).

### `@garuda/api`
`ChallengeService` over an async `ChallengeStore` (`InMemoryChallengeStore` or `PgChallengeStore`). Every operation on a challenge is serialised; account creation is serialised per wallet so caps cannot be raced. On breach or pass the service flattens the book and locks the challenge.

**Wallet sign-in (Sign-In with Solana, no transaction, no fee).** `POST /auth/nonce {wallet}` returns a single-use nonce (5 min) and the exact message to sign. The wallet signs it with `signMessage` (Ed25519). `POST /auth/verify {wallet, nonce, signature}` (base58 or base64) verifies with `node:crypto`, burns the nonce (even on a bad signature), and returns an opaque session token (24 h, only its hash is stored). Send `Authorization: Bearer <token>` on every `/challenges` route. A challenge belongs to the wallet that created it: another wallet gets 403 `not_owner`, `wallet` in the create body must match the session, and `GET /challenges` lists only your own.

**Rate limits** (fixed window, in process, defaults in `rate-limit.ts`): 300 requests/min per IP, 120/min per wallet, 20/min per IP on `/auth/*`, 30 orders per 10 s per wallet. 429 `rate_limited` with `Retry-After` and `X-RateLimit-*` headers; `/health` is exempt. Behind a proxy set `GARUDA_TRUST_PROXY=1`.

**Knights (M3).** With a knight chain configured (`ChallengeService({knights})`) the client's `nftLevels` is ignored and everything is read from the chain:
- *Mint:* a paid challenge without a knight mints a Squire-level knight to the buyer's wallet, already frozen, with `challenge_id` and `tier` set. A mint failure creates no account.
- *Gating:* a gated tier (Paladin needs a Knight-level knight, Ascended a Paladin-level one) or a funded account needs `knightAsset` in the request. The asset must be a **genuine** knight (in the Garuda collection, update authority and plugin authorities are the platform: a lookalike with self-written attributes fails `knight_not_genuine`), held by the signed-in wallet right now (`not_knight_owner`), high enough (`tier_locked`), not Wounded (`knight_wounded`), not already fighting (`knight_busy`). A funded account needs a passed evaluation of the same tier on that knight.
- *Transfer lock:* any live challenge (evaluation or funded, dormant included) freezes the knight. The freeze is written before the account is saved and the owner is re-read after it; if the knight moved in between the request is refused (`knight_moved`) and the freeze undone. A failed freeze refuses the open (`knight_lock_failed`), so no live account ever sits on an unlocked knight.
- *Level-up and wounds:* on a pass the knight levels up (Squire or Knight pass gives Knight, Paladin pass gives Paladin, Ascended pass gives Ascended), `wins` +1, the lock lifts, the URI moves to the new level file. A breach sets `wounded` and lifts the lock (a Wounded knight may be sold). A revive sets `revives` +1 and relocks.
- *Rights follow the knight for revives of a Wounded knight:* whoever holds it on chain now can quote and buy the revive and owns the new account; the seller can no longer. Funded and live accounts stay with the earning wallet because the knight is locked while they live. The payout quote reports `destination`, the wallet holding the knight at request time.
- *Sync failures:* the onchain write after a breach or pass is best effort; on an RPC error the knight is marked dirty and `reconcileKnights()` (the server runs it every 30 s, and once for all knights at start) heals it. `GET /health` shows `chain.dirtyKnights`.

**USDC checkout (M4).** `PurchaseService` (the `/purchases` routes) replaces the payment stub when `GARUDA_CHAIN=devnet`. Flow: **quote** (fails now when the account could not be opened: caps, tier gating, knight ownership, revive eligibility) returns the exact amount in USDC base units, the mint, the treasury wallet and a unique `reference` key; the buyer sends one SPL `transferChecked` of that amount to the treasury token account with `reference` as an extra read-only account (Solana Pay style); **confirm** with the signature. The server then reads the transaction from the RPC and checks: it succeeded, it carries the reference, the signed-in wallet signed it, the amount that landed in the treasury token account for the USDC mint (from the transaction's own pre and post token balances) is at least the quote, that amount left the signer's own token account, and it is not older than the order. A transfer that cannot be found yet returns 202 `pending` (retry). Only then is the knight minted and the account opened. Prices: Squire $119, Knight $275, Paladin $499, Ascended $899; revive is 20% off the tier fee ($95.20, $220, $399.20, $719.20).
- *Idempotency:* the challenge id, knight asset and refund all derive from the order id; a signature is bound to one order (unique index, `signature_reused`); the confirm is serialised per order. Replaying a confirm, or racing four of them, opens exactly one account and mints one knight.
- *Atomicity:* verify, then caps and gating preflight, then mint, then account, all inside the wallet's creation lock. If anything fails after the money was verified, the order goes `refund_pending` and the refund is sent to the payer's token account (`refunded`). If the refund send itself fails it stays `refund_failed`; `PurchaseService.reconcile()` (every 30 s in the server) retries it, finishes paid orders a crash left half done, and expires stale quotes (30 min). Order states: pending, paid, fulfilled, refund_pending, refund_failed, refunded, expired.
- With `requirePayment` (set by `GARUDA_CHAIN=devnet`) a direct `POST /challenges` for a paid tier is 402 `payment_required` pointing at `/purchases/challenge`, and the legacy revive route no longer uses the stub (402 pointing at `/purchases/revive`). Demo and funded accounts stay free of fees.
- Orders live in `payment_orders` (migration 005); `PgOrderStore` or `InMemoryOrderStore`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/nonce`, `/auth/verify`, `/auth/logout` | wallet sign-in, session revoke |
| GET | `/auth/me` | wallet behind the token |
| POST | `/challenges` | `{tier, knight?, stage?, nftLevels?, knightAsset?}` create (201) under the signed-in wallet (`nftLevels` is only used when no knight chain is configured). 402 `payment_required` for paid evaluations in real-money mode; 403 `tier_locked`, `not_knight_owner`, `knight_not_genuine`, `knight_wounded`, `evaluation_cap_exceeded`, `funded_cap_exceeded`; 409 `demo_exists`, `knight_busy`, `knight_moved`; 429 `demo_cooldown` |
| GET | `/challenges`, `/challenges/:id` | list yours; state (refreshes marks, funding, resting orders and risk first; `?refresh=false` to skip) |
| POST | `/challenges/:id/orders` | `{symbol, side, size, type, limitPrice?, reduceOnly?, postOnly?}`; 201 accepted, 422 rejected with `reason` (including `feed_halted`), 409 if not active or archived |
| DELETE | `/challenges/:id/orders/:orderId` | cancel a resting order |
| POST | `/challenges/:id/tick` | force a refresh |
| GET | `/challenges/:id/combat-log` | combat log |
| GET / POST | `/challenges/:id/revive` | revive quote and eligibility / revive (header `Idempotency-Key`; 201, or 200 on a replay). With a knight chain the holder of a Wounded knight is the one allowed; in real-money mode the POST is 402 and the buyer uses `/purchases/revive` |
| POST | `/challenges/:id/reactivate` | free wake-up of a Dormant funded account |
| GET | `/challenges/:id/payout-quote` | payout quote (funded, not breached, not Demo); payout execution is still roadmap |
| POST | `/purchases/challenge` | `{tier, knightAsset?}` quote a challenge purchase: amount, mint, treasury, `reference`, expiry (201) |
| POST | `/purchases/revive` | `{challengeId}` quote a revive at 20% off (201) |
| POST | `/purchases/:id/confirm` | `{signature}` verify the transfer on chain, then mint and open the account: 200 `fulfilled` (also on replay), 202 `pending` (transfer not visible yet), 200 `refunded` or `refund_pending` with `order.failure`; 402 `payment_<reason>` (`underpaid`, `no_transfer_to_treasury`, `reference_missing`, `payer_balance_mismatch`, `bad_signature`, `payer_not_signer`, `too_old`, `transaction_failed`); 409 `signature_reused`, `order_already_paid`; 410 `order_expired` |
| GET | `/purchases`, `/purchases/:id` | your orders; one order |
| GET | `/knights`, `/knights/:asset` | knights you hold (read from chain); one genuine knight |
| GET | `/nft/collection.json`, `/nft/metadata/:level.json`, `/nft/images/knight-N.png` | public metadata and art the onchain URIs point at |
| GET | `/rules`, `/health`, `/metrics` | rules as code, health (never reveals the builder code), worker metrics |

Pre-trade gates (opening orders only; reduce-only always passes): market whitelisted, feed fresh (2 s) and not halted by the worker, market open (Phoenix tradfi closed periods are reduce-only), circuit breaker (spread over 100 bps or side depth within 0.5% below $10k), margin-style leverage cap.

**Account rules in the service**
- *Caps (rulebook 20):* aggregate evaluation size per wallet at most $200,000, aggregate funded at most $300,000, counted over live accounts (active, not breached, not archived; Demo exempt). Checked on create and on revive.
- *Free Demo:* $5,000, no NFT and no knight id, no payouts, no funded stage, one active per wallet (409), restart allowed 1 hour after a breach (429 before), cannot be revived.
- *Dormancy (rulebook 18):* a funded account with no order or payout request for 90 days goes Dormant (keeps its risk checks, trading or `reactivate` wakes it for free); 365 days later it is Archived (flattened at the last known books, no trading, leaves the caps). Challenge accounts never time out. `sweepLifecycle` applies it; the worker runs it hourly, and a long outage steps through both transitions.
- *Revive (rulebook 17):* Wounded knights only, 24 hours after the breach, 20% off the same tier (Knight $275 becomes $220), at most 3 per knight across its whole chain, a fresh evaluation account for the same knight (scar count +1, new id, the breached account is kept as history). Payment goes through a `PaymentProvider`: the `StubPaymentProvider` (dev default) always succeeds, `PaymentRequiredProvider` (real-money mode) sends the buyer to the USDC checkout above, and a decline (402) creates nothing. An `Idempotency-Key` makes a retry return the first result with no second charge.
- *Fill-time leverage re-check:* a resting limit order is checked again when it fills, at the fill price and including the maker fee. If equity has fallen so the full size no longer fits, the fill is trimmed to the largest size that does and the rest is cancelled (`leverage_cap_exceeded`, with a combat-log warning). Reduce-only orders always fill.

### `@garuda/worker`
`RiskWorker` consumes a `MarketFeed` (`@garuda/market-data`: `PollingFeed` over any provider today, `ManualFeed` for tests and replays; a Rise websocket feed implements the same interface). It watches only symbols with a live position or resting order and calls `service.onMarketUpdate(snapshot)` for each update: marks, funding, resting fills with the leverage re-check, then the full risk evaluation, so a breach is caught when the price moves rather than at the next API call. Out-of-order snapshots are ignored.
- *Stale-feed kill switch:* no update for 10 s (`GARUDA_STALE_FEED_MS`) halts new exposure in that symbol (`feed_halted`); closing and risk checks continue; the next update lifts it.
- *Metrics* at `/metrics`: updates, errors, breaches caught, resting fills, p50/p99/max latency from snapshot time to persisted evaluation, halted and watched symbols and their age.
- Runs the dormancy/archive sweep at start and hourly. One update that throws is counted and reported, never fatal.

### `@garuda/market-data`
`PhoenixSdkProvider` uses `@ellipsis-labs/rise` (`client.api.orderbook().getOrderbook`, `markets().getLatestMarketStats`, `markets().getMarkets`). Verified live: 100-level books, mark, funding, market status and tradfi session flags. `current_funding_rate` from the live API is in **percent per hour**; the provider divides by 100 (the docs example shows a fraction, the live values match `annualized_funding_rate` only as percent). `fixtures/phoenix-books.json` holds recorded real books (`pnpm fixtures:record`) used by tests and as the offline fallback.

## Web app (M5)

`packages/web` (`@garuda/web`): Vite + React 19 + react-router SPA, ported from the seven mocks and the landing page (warm black `#110f10`, fire `#ff5f01`, violet, Hanken Grotesk, the chibi knight and boss PNGs). It talks to the real API only; nothing is faked in the browser.

| Route | What it does |
| --- | --- |
| `/` | Landing. Tier cards and rules come from `GET /rules` (with built-in fallbacks so it renders without the API). |
| `/challenges` | Free Demo card plus Squire, Knight, Paladin, Ascended. Paladin and Ascended show a lock until the wallet holds the required knight. Checkout: name your knight, accept the terms, pay in USDC, reveal. The Revive tab lists wounded knights. |
| `/terminal`, `/terminal/:id` | Battle terminal: knight and boss panel (PNG per state), profit target, daily loss and drawdown bars, account tile, candle chart, live book and mark, order ticket (market and limit, size by percent, leverage, take profit as a reduce-only limit, reduce-only), positions, open orders, history, combat log. A passed challenge shows the Ascension screen (claim the funded account). |
| `/barracks` | One card per knight with filters and a detail panel (evolution strip, milestones, scars). |
| `/revive/:id` | Wounded screen: what broke (chart rebuilt from fills, floor line, breach point), the 20% revive price from `/challenges/:id/revive`, knight record. Checks out through the same USDC flow. |
| `/leaderboard` | Sample data, labelled as such (no backend yet). |
| `/payouts` | Read-only. Shows what a funded account would be owed (`payout-quote`); the request button is disabled until KYC (M7) and the payout rail (M8) exist. |

**Wallet and sign-in.** `@solana/wallet-adapter-react`; Phantom, Solflare, Backpack and other Wallet Standard wallets register themselves. Connecting runs the API's flow: `POST /auth/nonce`, `signMessage`, `POST /auth/verify`, then the bearer token is kept in `sessionStorage`.

**USDC checkout.** `POST /purchases/challenge` (or `/purchases/revive`) returns a quote; the app builds one SPL `transferChecked` to the treasury token account with the quote's `reference` as an extra read-only key, the wallet signs and sends it, then `POST /purchases/:id/confirm` with the signature (202 `pending` is retried). On the stub server (`health.chain === "stub"`) the wallet transfer is replaced by `POST /dev/stub-pay`. The app shows "SIMULATED ACCOUNT" in the header on every page.

**Public market routes** added for the app: `GET /markets/:symbol?depth=` (book, mark, funding) and `GET /markets/:symbol/candles?tf=&limit=` (Phoenix candles, or synthetic ones on the recorded books; the chart says which). Both are public and cached for a short time. CORS is off by default; set `GARUDA_CORS_ORIGIN` (comma list or `*`) only if the app is served from another origin. In dev the Vite proxy keeps everything same-origin.

**Run it.**

```bash
pnpm install
pnpm web:stub                        # terminal 1: stub API on :3000 (fake knights + USDC, recorded books that drift)
VITE_DEV_WALLET=1 pnpm web:dev       # terminal 2: http://localhost:5173
pnpm web:screens                     # starts its own stub (:3111) and Vite (:5188), writes docs/screens/*.png
pnpm web:build                       # type-checks and builds packages/web/dist
```

`VITE_DEV_WALLET=1` adds a throwaway in-browser wallet ("Garuda Dev Wallet", key in `localStorage`) next to the real ones. It signs messages and fake transfers only and must never be enabled in a production build. Against a real server: `GARUDA_CHAIN=devnet pnpm api`, then `GARUDA_API_PROXY=http://localhost:3000 pnpm web:dev` with Phantom or Solflare set to devnet.

| Env var | Where | Meaning |
| --- | --- | --- |
| `VITE_API_URL` | web build | API base URL. Default `/api` (the dev and preview proxy). Needs `GARUDA_CORS_ORIGIN` on the API when cross-origin. |
| `VITE_SOLANA_RPC` | web build | RPC for the wallet adapter and the USDC transfer. Default devnet. |
| `VITE_DEV_WALLET` | web build | `1` enables the dev wallet. |
| `GARUDA_API_PROXY` | vite dev and preview | Where `/api` is proxied. Default `http://localhost:3000`. |
| `WEB_PORT` | vite | Dev port (5173) and preview port (4173). |
| `GARUDA_CORS_ORIGIN` | API | Allowed browser origins. Unset means none. |

**Screenshots** (`docs/screens/`, produced by `pnpm web:screens` through the real UI: connect the dev wallet, sign in, buy a Squire, trade, seed a wounded and a passed account through the real engine, revive through checkout, claim funded): `00-landing`, `01-terminal`, `02-challenges`, `02b-checkout`, `02c-reveal`, `03-barracks`, `04-ascension`, `04b-funded-terminal`, `05-wounded`, `05b-revived`, `06-leaderboard`, `07-payouts`, and 390px wide `m-landing`, `m-challenges`, `m-terminal`. The stub-only routes `/dev/stub-pay` and `/dev/seed` exist only in `scripts/web-stub-server.ts`.

## Solana devnet (M3 and M4)

Devnet only, no real funds. `GARUDA_CHAIN=devnet` turns on knights and USDC checkout; without it the server behaves as before (stub payments, trusted `nftLevels`).

```bash
pnpm chain:setup                 # creates .keys/platform.json (gitignored), airdrops devnet SOL, creates the collection,
                                 # a test USDC mint and the treasury token account; prints the env lines
pnpm chain:faucet <wallet> 1000  # test USDC to a wallet (the platform key is the mint authority of the test mint)
GARUDA_CHAIN=devnet GARUDA_KNIGHT_COLLECTION=... GARUDA_USDC_MINT=... pnpm api
pnpm test:chain:devnet           # opt-in end to end on devnet (needs SOL on the platform key)
pnpm test:chain:local            # same test against a local solana-test-validator (see below)
```

The public devnet faucet is rate limited and sometimes closed (the RPC `requestAirdrop` answers 410 at times). If `pnpm chain:setup` cannot airdrop, fund the printed platform address at https://faucet.solana.com (devnet) by hand and run it again. Circle's devnet USDC can be used instead of the test mint: set `GARUDA_USDC_MINT` to it and fund buyers from Circle's faucet.

The platform key is the update authority of the collection and every knight, the treasury (receives fees, signs refunds) and the fee payer. On devnet one key is fine; for mainnet it should become a multisig (Squads) with a separate hot refund key (roadmap open question).

Environment: `GARUDA_CHAIN=devnet`, `GARUDA_SOLANA_RPC_URL` (default public devnet), `GARUDA_KEYPAIR_PATH` (default `.keys/platform.json`), `GARUDA_KNIGHT_COLLECTION`, `GARUDA_USDC_MINT`, `GARUDA_PUBLIC_URL` (base URL written into the knight metadata URIs; must be reachable by wallets and explorers), `GARUDA_ART_DIR` (default `/workspace/garuda-landing/knights`), `GARUDA_RECONCILE_MS` (default 30000).

**Local validator dry run (not devnet).** `solana-test-validator --reset --url devnet --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d --clone-upgradeable-program SysExL2WDyJi9aRZrXorrjHJut3JwHQ7R9bTyctbNNG --clone-upgradeable-program TokExjvjJmhKaRBShsBAsbSvEWMA1AgUNK7ps4SAc2p` runs the REAL mpl-core, mpl-system-extras and mpl-toolbox programs locally with free SOL; `pnpm test:chain:local` then exercises the same `MetaplexCoreKnights` and `SolanaUsdc` code on it: collection, test USDC, pay, verify, mint, freeze (a transfer by the owner is rejected), pass and level-up, unlock, transfer, refund after a failed mint, idempotent replays. To start the server on it set `GARUDA_CHAIN_ALLOW_LOCAL=1` (skips the devnet genesis check for loopback URLs only).

## Tests

`pnpm test` runs 276 tests (273 pass, 3 skipped: one needs `LIVE=1` network, one needs real Postgres, one is the chain end to end that needs `DEVNET=1` or `LOCAL_VALIDATOR=1`). `pnpm test:pg` (GARUDA_TEST_PG=embedded) runs the real-Postgres ones too: 274 pass. Nothing in the default run needs network or SOL: the chain is mocked (mocked RPC with fixture transactions, `FakeKnights`, `FakeUsdc`).

| Package | Tests | Covers |
| --- | --- | --- |
| sim-engine | 30 | book walks, fees, limits, reduce-only, flips, funding, closeAll; ledger replay equals live state |
| risk-engine | 50 | floors, reset, warnings, breach, pass, leverage, combat log, payouts; caps, dormancy, revive, demo rules as pure functions |
| market-data | 10 (1 skipped) | replay, status mapping, PollingFeed (errors, overlap, timers), ManualFeed |
| db | 4 (1 skipped) | migrations (incl. 005 payment_orders), idempotence, rollback on failure, append-only triggers (real Postgres only) |
| chain | 31 | devnet-only guard, HttpRpc errors, exact USDC base units, attribute round trip, per-level metadata, `deriveKnightState` (pass, wound, revive, funded, order independence), deterministic asset and refund keys, `verifyPayment` against fixture transactions (ok, overpay, pending, failed tx, missing or foreign reference, payer not signer, too old, underpaid, wrong mint, wrong destination, wrong source), `withReference`, refund idempotency |
| api | 135 + 1 opt-in | original 18 API tests unchanged, plus sign-in (valid, bad signature, replayed and expired nonce, expired session, 403 on foreign accounts), rate limits, caps, demo, dormancy and archive, revive (cooldown, price, cap of 3, idempotency, declined payment), fill-time leverage trim, Postgres restart and ledger replay; knights (19: mint, lock, level-up, wound, forged assets, gating from chain, revive relock, sold wounded knight, mid-open ownership change, sync failure and reconcile, payout destination); purchases (27: exact quotes, pay-verify-mint, replay, concurrent confirms, signature replay across orders, every rejection reason, pending then confirm, expiry, refund on failed mint or cap or sold knight, refund retry, crash recovery, revive at 20% off, `PgOrderStore`, HTTP incl. sign-in and static NFT routes); opt-in chain e2e |
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

- **Web app (M5).** The leaderboard is sample data (no ranking backend). Payouts are read-only until M7 and M8. Stop-loss and stop orders are disabled in the ticket (the engine has market and limit only); take profit is a reduce-only limit. The wounded chart is rebuilt from fills because the API keeps no equity history. Knight traits and rarity have no pipeline, so the reveal shows only real attributes (level, account, rules, status); art is the four PNG sets, no animated loops or reduce-motion switch yet. Live state is polled (1 to 8 s), not WebSocket or SSE. Not run in a browser against real devnet (the faucet is closed to this environment): the wallet transaction path is typechecked and its quote and confirm halves are covered by API tests, the stub covers the rest. Desktop and 390px layouts were checked on the screenshots; there is no cross-browser or tablet pass.
- **Not run on Solana devnet yet.** The devnet faucet was closed to this build environment (RPC `requestAirdrop` answers 410, the PoW faucets are drained, faucet.solana.com asks bots not to use it), so the platform key holds 0 devnet SOL. The code is covered by mocked tests, and the same code passes the full end to end against a local validator running the real mpl-core and SPL programs (`pnpm test:chain:local`). To produce devnet addresses: fund `F64qji9FjMXLFF7UF5pjRYMSmbkjwJwD5YWd3FBVaMC4` (or run `pnpm chain:setup` for your own key) and run `pnpm chain:setup && pnpm test:chain:devnet`.
- Knight image and metadata JSON are served by the API (`/nft/*`), not Arweave/Irys; wallets and explorers need `GARUDA_PUBLIC_URL` to be publicly reachable. Art is the four landing PNGs, one per level; the generative trait pipeline and animated loops are not built.
- The knight's Attributes carry level, status, tier, current challenge id, wins and revives. Full history lives in our database; it is not mirrored onchain.
- Payment confirm is pull based (the buyer posts the signature). There is no webhook or log subscription that finds a payment whose buyer never came back to confirm; such an order expires after 30 minutes and a late payment is not matched automatically (refund by hand from the signature). Overpayment is accepted and the excess is recorded on the order but not sent back automatically.
- Confirmation uses commitment `confirmed`, not `finalized`: a rollback after confirmed is very unlikely but possible. `SolanaUsdc` takes `commitment: "finalized"`; use it for mainnet.
- A mint that succeeded on chain but whose challenge save then failed leaves an orphan frozen-free knight asset (deterministic address, harmless, the refund still goes out). A reaper for orphans is not built.
- A Wounded knight sold on a marketplace gives the new holder the revive right and the new account, but the old wounded account stays in the seller's history; the seller's funded and live accounts are unaffected (their knights are locked).
- Single process: purchase serialisation and the knight sync queue are in memory, same constraint as the challenge cache.
- Royalty enforcement on secondary sales (Core Royalties plugin with `ruleSet None`) is not enforced; marketplaces may ignore it. Royalty percent (5%) and update-authority custody (single key, not a multisig) are open owner decisions.
- KYC (M7) and payout execution (M8) are not built; `payoutQuote` only reports the destination (the knight holder).
- Price feed is polling (default 1 s) over Phoenix REST. A Rise websocket feed is not built; worst-case detection delay is about the poll period plus request latency. Phoenix `markPrice` is replaced by the book mid on each book update (existing behaviour).
- Single process: the challenge cache and the worker index live in memory, so run one API-plus-worker process per database. Several replicas need a shared cache or the worker split out (Redis for the books/equity cache is not built).
- Rate limits are per process (fixed window, in memory); with several replicas the effective limit multiplies. A Redis-backed limiter is the upgrade.
- Order placement has no idempotency key yet (only revive does). Demo 30-day idle reset (rulebook 18) is not implemented.
- Real Postgres tests are opt-in (`pnpm test:pg` or `GARUDA_TEST_DATABASE_URL`); the default run uses pg-mem, which does not run the append-only triggers.
- No isolated-margin / commodity-specific simulation: Phoenix has isolated-only markets, here everything is cross for rule purposes.
- Funding is accrued pro rata at each update using the current rate, not by replaying historical hourly settlements.
- Demo script moves prices with a scenario overlay on the real book; real prices do not move on demo timescales.

## Next steps

1. **Devnet run of M3/M4**: fund the platform key, `pnpm chain:setup`, `pnpm test:chain:devnet`, then wire the frontend wallet flow (build the `transferChecked` plus reference transaction with `@solana/spl-token`). Then Arweave/Irys for art and metadata, a payment watcher, finalized commitment, multisig authority.
2. **Rise websocket feed** and a shared cache (Redis) so the API and worker can scale past one process.
3. **Frontend follow-ups**: WebSocket or SSE state, a real leaderboard, stop orders, trait art and reveal animation, a devnet browser run with Phantom.
4. **KYC and payouts** (M7, M8): KYC gate before funded activation, payout requests via treasury multisig.
5. **Phase 2**: route selected funded trades to a firm Phoenix account using `PHOENIX_BUILDER_CODE` (builder-code fees are firm revenue, never charged to traders), with the A-book/B-book disclosures from the rulebook.
