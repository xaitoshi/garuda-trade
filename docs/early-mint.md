# Garuda Beta Access mint (/early)

`https://garuda.markets/early` sells one **Garuda Beta Access** NFT per wallet and per email for **$1.69 in USDC** on
**Solana mainnet**. It is a Metaplex Core asset in its own "Garuda Beta Access" collection. Shipped **OFF**: with
`EARLY_MINT_ENABLED` unset the page shows "Minting opens soon" and only records waitlist entries (wallet + email). No
payment is taken and nothing touches the chain.

## How a mint works (once enabled)

1. The buyer enters the wallet that should receive the NFT and an email, and connects a wallet to pay (Privy or a
   browser wallet; it can be the same wallet).
2. `POST /early/claim {wallet, email, payer}` validates both, reserves a slot under the cap for 5 minutes and returns
   ONE legacy transaction, pre-signed by Garuda (collection authority + the new asset key), that:
   1. creates the treasury's USDC token account if it is missing (idempotent, a no-op when it exists),
   2. transfers 1.69 USDC from the payer to the treasury, with a unique `reference` key attached,
   3. creates the Core asset for the entered wallet in the collection, with the **buyer as fee and rent payer**.
   Payment and mint land together or not at all. Changing anything in the message voids Garuda's signatures.
3. The wallet adds its signature and sends it. `POST /early/claim/:id/confirm {signature, payer}` reads the
   transaction from the RPC and checks: it succeeded, the payer signed, the claim's reference is present, at least
   1.69 USDC (by the USDC mint) moved from the payer's own token account to the treasury, and the signature was never
   used for another claim (also a UNIQUE column). It then checks the asset exists and records the claim as `minted`.
   The page shows "Minted" with a Solscan link.

If the buyer waits longer than the blockhash lives (about 1 to 2 minutes) the page simply claims again and gets a fresh
transaction for the same claim, asset address and reference.

**Soulbound** by default (`EARLY_SOULBOUND`, default `true`): each asset carries a `PermanentFreezeDelegate` plugin,
frozen, whose authority is the collection's update authority. Holders cannot transfer or list it. The mint authority can
thaw it later if you ever want them tradable. Set `EARLY_SOULBOUND=false` before enabling for freely transferable NFTs.

## Costs (measured with a mainnet simulation, Nov 11 2026: `pnpm early:simulate`)

| Who | What | SOL |
| --- | --- | --- |
| Buyer, per mint | Core asset rent (165 bytes) | 0.00148844 |
| Buyer, per mint | Metaplex Core protocol fee (`create`) | 0.0015 |
| Buyer, per mint | Network fee (3 signatures x 5,000 lamports) | 0.000015 |
| **Buyer total per mint** | plus the **1.69 USDC** price | **≈ 0.0030 SOL** |
| Mint authority, once | Collection account rent (111 bytes) + fee | 0.00121412 + 0.00001 ≈ **0.0012 SOL** |
| Mint authority, per mint | nothing (it only signs) | 0 |

The treasury USDC account `9hdctRhyBAwgWHCBUueNJCDj52WHqV6EX8fijA2WJ8L6` (owner
`CCezKqU697kanduvFk8GPwD484DGtKH46tfV9o7T2xKq`) already exists on mainnet, so buyers never pay for it. If you point
`EARLY_MINT_TREASURY` at a wallet without one, the first buyer's transaction creates it (≈0.00204 SOL, once).

Fund the mint authority with **0.01 SOL** (covers the collection plus headroom for the rare admin fallback mint at
≈0.003 SOL each). It never needs more unless you use the fallback a lot.

## Enable it (owner steps)

1. **Create the mint authority** on a machine you trust (not in chat):
   `solana-keygen new --no-bip39-passphrase -o ~/garuda-early-mint.json` and note its address
   (`solana-keygen pubkey ~/garuda-early-mint.json`). This key is the collection's update authority: keep a backup.
2. **Fund it with 0.01 SOL** on mainnet from your own wallet.
3. **Create the collection** (one time, ≈0.0012 SOL, needs `--yes` on mainnet):
   ```sh
   EARLY_CLUSTER=mainnet-beta EARLY_RPC_URL=https://<your mainnet RPC> \
   EARLY_MINT_KEYPAIR_PATH=~/garuda-early-mint.json pnpm early:collection -- --yes
   ```
   It prints `EARLY_COLLECTION=<address>`.
4. **Set Railway variables** on the `api` service (production):
   | Variable | Value |
   | --- | --- |
   | `EARLY_MINT_ENABLED` | `true` |
   | `EARLY_RPC_URL` | a mainnet RPC (Helius, Triton...). The public endpoint works but rate limits |
   | `EARLY_MINT_KEYPAIR` | contents of `~/garuda-early-mint.json` (the 64-number JSON array), as a secret |
   | `EARLY_COLLECTION` | the address from step 3 |
   | `EARLY_MINT_TREASURY` | optional, default `CCezKqU697kanduvFk8GPwD484DGtKH46tfV9o7T2xKq` |
   | `EARLY_PRICE_USD` | optional, default `1.69` |
   | `EARLY_MAX_SUPPLY` | optional, default `1000` |
   | `EARLY_SOULBOUND` | optional, default `true` |
   | `EARLY_CLUSTER` | optional, default `mainnet-beta` (the RPC's genesis hash must match or minting stays off) |
   | `EARLY_USDC_MINT` | optional, default mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
   | `EARLY_METADATA_URI` | optional, default `https://garuda.markets/early/metadata.json` |
5. Redeploy. The API log line and `/health` show `early: minting on mainnet-beta $1.69 cap 1000`. Any missing or wrong
   setting logs `[garuda-early] minting config rejected` and the page stays in waitlist mode. `GET /early/status` shows
   `enabled: true`.
6. Do one real $1.69 mint yourself and check it on Solscan before announcing.

To switch off: set `EARLY_MINT_ENABLED=false` (or delete it) and redeploy. Claims already minted stay minted.

## Waitlist

Entries made while minting was off stay in `early_claims` with status `waitlist`. When minting opens, the same
wallet + email claims again on the page and pays like everyone else (their row turns into the purchase). Email them
from the admin list.

## Admin (Bearer `GARUDA_ADMIN_TOKEN`)

- `GET /admin/early`: status, counts per status, treasury, USDC mint, mint authority address and SOL balance.
- `GET /admin/early/claims?status=waitlist,minted&limit=500`: claims WITH emails (public routes never return emails).
- `POST /admin/early/mint-pending`: for claims marked `paid` whose asset was not visible at confirm time, records the
  asset if it exists or, as a last resort, mints it server-paid (≈0.003 SOL from the mint authority).
- `DELETE /admin/early/claims/:id`: removes a waitlist or unpaid claim (paid and minted rows cannot be deleted).

## Artwork

The NFT image is `packages/web/public/early/garuda-beta-access.png`, served at
`https://garuda.markets/early/garuda-beta-access.png`. The page uses the same file (`EARLY_ART` in
`packages/web/src/lib/config.ts`). Metadata JSON: `https://garuda.markets/early/metadata.json` (asset) and
`https://garuda.markets/early/collection.json` (collection). To swap the art, replace the PNG **keeping the file name**,
then redeploy the web app: every asset (already minted or not) points at the same metadata URL, so wallets pick up the
new image as their caches refresh. Do this before enabling minting if possible.

## Data

Table `early_claims` (migration `010_early_access.sql`): wallet UNIQUE, email UNIQUE (lowercased), reference UNIQUE,
payment_signature UNIQUE, plus status, payer, asset, mint signature, a hash of the claimer's IP, and timestamps.
Claims are rate limited to 6 per 10 minutes per IP on top of the global per-IP limit.
