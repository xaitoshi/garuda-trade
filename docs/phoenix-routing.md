# Phase 2: Phoenix order routing (A-book) runbook

Garuda's Phase 2 copies the trades of **selected FUNDED traders** onto a **firm-owned Phoenix account** on Solana mainnet. Evaluation (challenge) and demo accounts are never routed. Every funded trade gets a per-trade label: **A-book** when it is mirrored to Phoenix, **B-book** when it stays internal (rulebook section 22).

**Shipped state: routing is OFF.** `ROUTING_ENABLED` is unset in production, no delegate key is loaded, `/health` reports `"routing": "disabled"`, and the router ignores every fill and writes nothing.

Code: `packages/router` (router, caps, audit store, live Phoenix client). Hooks: `ChallengeService` `onFills` (packages/api), the `/admin/routing` routes (packages/api/src/app.ts), and wiring in `packages/worker/src/server.ts`. Tables come from migration `008_routing.sql`.

## How it works

- **Position mirroring.** For each selected funded account and market, the firm's target position is `trader position x multiplier` (`ROUTING_SIZE_MULTIPLIER`, default 0.1, with optional per-trader overrides). On every simulated fill the router sends the difference as a Phoenix **isolated market order**. Because it mirrors positions rather than individual fills, closes, partial reduces, flips and breach close-outs all end up at the same target.
- **Orders.** Each order is built server-side by Phoenix (`POST /v1/ix/place-isolated-market-order` through the Rise SDK `@ellipsis-labs/rise` 0.7.4) with `authority` = the firm wallet and `positionAuthority` = the delegate. The delegate signs and pays the fee. The order is all-or-nothing (`minBaseLotsToFill = numBaseLots`) with a worst-price limit (`maxPriceInTicks`) at the reference price ± `ROUTING_MAX_SLIPPAGE_BPS`. Opening orders move `notional / ROUTING_ISOLATED_LEVERAGE` USDC into the market's isolated subaccount. Reductions are sent reduce-only.
- **Caps on new exposure:**
  - market allowlist (`ROUTING_MARKETS`)
  - per-trade notional
  - per-trader notional
  - total firm notional
  - daily loss halt (realized plus unrealized, UTC day)
  - minimum order notional
  
  An increase above a cap is clipped to fit. If nothing is left after clipping, the trade is skipped and labelled B-book. **Reductions and closes are never blocked**, so a halt can't leave the firm stuck with exposure.
- **Reconciliation** (every `ROUTING_RECONCILE_MS`, default 60s, or `POST /admin/routing/reconcile`):
  1. Re-derives every target from the traders' current simulated books. This catches missed or failed orders, deselected traders, and breached or vanished accounts.
  2. In live mode, compares the expected firm book with Phoenix's actual positions (`GET /v1/trader/state/:authority`). Any drift above `ROUTING_DRIFT_TOLERANCE_USD` is recorded and logged but **never traded automatically**, because it may be a manual intervention.
- **Audit log.** The `routing_orders` table gets one row per intent, send, failure, skip or drift. Each row records mode (`dry_run` or `live`), A/B book, action, reason, the signature or error, and the triggering simulated fill id. Read it with `GET /admin/routing/orders`.

## Switches (three independent layers)

| Layer | How | Effect |
|---|---|---|
| Master switch | env `ROUTING_ENABLED=true` (Railway variable, needs a redeploy) | Off by default. **No API route can turn it on.** |
| Dry run | env `ROUTING_DRY_RUN` (default **true**) | While true, intended orders are logged (`status: dry_run`) and nothing is sent. Going live needs `ROUTING_DRY_RUN=false` **and** the delegate key **and** `PHOENIX_FIRM_AUTHORITY`. If any of those is missing, live mode is refused and routing reports `disabled`. |
| Kill switch | `POST /admin/routing/halt` | Blocks all new exposure immediately and persists across restarts. Reductions still mirror. `POST /admin/routing/resume` clears it. `POST /admin/routing/flatten` closes every routed position. |
| Per-trader opt-in | `PUT /admin/routing/traders/:challengeId {"enabled": true, "multiplier"?: 0.05}` | Only live, non-demo **funded** accounts can be selected. Deselecting closes that trader's routed positions. |

The hard kill is to set `ROUTING_ENABLED=false` (or delete it) on Railway and redeploy. If the firm still holds Phoenix positions, flatten them first, or close them in the Phoenix app with the firm wallet.

All admin routes need `Authorization: Bearer $GARUDA_ADMIN_TOKEN`. An optional `x-admin-actor: <name>` header names who made the change in the logs.

## Enabling it, step by step (owner)

### 1. Create two wallets (on your own machine)

- **Firm wallet (owner).** Holds the USDC and owns the Phoenix trader account. Use a hardware wallet or a fresh keypair kept offline. **It never goes on the server.**
- **Delegate (trade-only).** `solana-keygen new --no-bip39-passphrase -o garuda-delegate.json`. This key can place and cancel orders on the firm's account but cannot withdraw (Phoenix position authority). It needs a little SOL for transaction fees (for example 0.05 to 0.1 SOL).

### 2. Register the firm wallet on Phoenix and deposit

Connect the firm wallet at https://app.phoenix.trade, register or onboard it, and deposit USDC. How much to deposit is your call. It should at least cover `ROUTING_MAX_TOTAL_NOTIONAL_USD / ROUTING_ISOLATED_LEVERAGE` plus a buffer for losses and fees.

### 3. Make the delegate the position authority

```bash
pnpm phoenix:delegate --firm <FIRM_WALLET> --delegate <DELEGATE_PUBKEY>                           # prints the instruction
pnpm phoenix:delegate --firm <FIRM_WALLET> --delegate <DELEGATE_PUBKEY> --send --keypair firm.json # signs + sends (mainnet)
```

Or set the delegate from the Phoenix app if it offers that. **Unverified:** whether isolated child subaccounts inherit the parent's position authority. If the first live order fails with an authority or signer error, the router refuses to send anything the delegate can't sign alone (`order needs signer ... refusing`). In that case, delegate the child subaccount too (`--subaccount <index>`), or ask Phoenix.

### 4. Optional: builder code (Flight)

Set `PHOENIX_BUILDER_AUTHORITY` (plus `PHOENIX_BUILDER_PDA_INDEX` and `PHOENIX_BUILDER_SUBACCOUNT_INDEX` if they aren't 0) to route orders through Flight. Note that when the firm both trades and owns the builder account, the builder fee is a transfer between two firm accounts. It only becomes real revenue from flow the firm doesn't own. Traders are never charged a builder fee.

### 5. Set the Railway variables (service `api`) and redeploy

```
ROUTING_ENABLED=true
ROUTING_DRY_RUN=true                      # start here
PHOENIX_FIRM_AUTHORITY=<firm wallet pubkey>
PHOENIX_DELEGATE_KEYPAIR=[..64 numbers..]  # contents of garuda-delegate.json, as a SECRET variable
PHOENIX_TRADE_RPC_URL=<paid mainnet RPC>   # e.g. Helius/Triton; public RPC drops transactions
# PHOENIX_TRADE_WS_URL=<matching websocket URL if it isn't the http URL with ws://>
# Caps (defaults shown):
ROUTING_SIZE_MULTIPLIER=0.1
ROUTING_MAX_TRADE_NOTIONAL_USD=500
ROUTING_MAX_TRADER_NOTIONAL_USD=1000
ROUTING_MAX_TOTAL_NOTIONAL_USD=5000
ROUTING_DAILY_LOSS_LIMIT_USD=250
ROUTING_MARKETS=SOL,BTC,ETH
ROUTING_MAX_SLIPPAGE_BPS=50
ROUTING_MIN_ORDER_NOTIONAL_USD=10
ROUTING_ISOLATED_LEVERAGE=3
ROUTING_RECONCILE_MS=60000
ROUTING_DRIFT_TOLERANCE_USD=25
GARUDA_ADMIN_TOKEN=<openssl rand -hex 32>  # if not already set
```

The key is read once at boot and then removed from the process environment. It is never logged, and the status endpoint shows only the delegate's **public** key. A malformed routing config doesn't stop the API: routing stays off and the boot log says why.

### 6. Dry run

1. Check `/health`: `"routing": "dry_run"`. Check `GET /admin/routing`: it should show `delegateKeyLoaded: true` and the right `firmAuthority` and `delegate`.
2. Select one or two proven funded traders: `PUT /admin/routing/traders/<challengeId> {"enabled": true}`.
3. Watch `GET /admin/routing/orders` and the `[garuda-router] DRY_RUN ...` log lines for a few days. Confirm the sizes, caps, closes and B-book labels look right.

### 7. Go live

1. Optionally halt first (`POST /admin/routing/halt`). Then set `ROUTING_DRY_RUN=false` and redeploy. `/health` should show `"routing": "live"` (or `live:halted`).
2. Resume if you halted (`POST /admin/routing/resume`). Watch the first orders' signatures on Solscan and `lastReconcile.drift` in `GET /admin/routing`.
3. Dry-run positions are tracked separately, so live starts from a flat book.

### Kill switch

| Situation | What to do |
|---|---|
| Something looks wrong | `POST /admin/routing/halt`. New exposure stops at once and closes still mirror. |
| Get flat now | `POST /admin/routing/flatten` |
| Full stop | Set `ROUTING_ENABLED=false` on Railway and redeploy. If Phoenix positions remain, close them with the firm wallet in the Phoenix app. To be extra safe, remove the delegate's position authority or empty its SOL so it can't pay fees. |

## Admin API

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/routing` | Mode, halt, config, keys (public), exposure, daily PnL, positions, traders, last reconcile |
| GET | `/admin/routing/orders?challengeId=&limit=` | Audit log, newest first |
| PUT | `/admin/routing/traders/:challengeId` | `{enabled, multiplier?, note?}` per-trader opt-in |
| POST | `/admin/routing/halt` / `/resume` | Kill switch |
| POST | `/admin/routing/flatten` | Close every routed position |
| POST | `/admin/routing/reconcile` | Run a reconciliation now |

## Known limits and unverified details

- The router assumes each order fills at the reference (simulated fill) price when it updates its own book. Real fills on Phoenix may differ by up to the slippage limit. Reconciliation catches **size** drift but not price drift.
- If an all-or-nothing order can't fill inside the limit, it fails. It is retried on the next fill or reconciliation, and every attempt is audited.
- No priority fee or compute-budget instruction is added. Under congestion, use a paid RPC and consider adding one.
- Unverified until the first live run: delegate-signed `transferAmount` into isolated subaccounts, position-authority inheritance on isolated child subaccounts, and the sign convention of `basePositionLots` in the trader-state snapshot.
