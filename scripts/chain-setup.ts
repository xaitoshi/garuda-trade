/**
 * One-time Solana DEVNET setup for Garuda M3/M4:
 *   pnpm chain:setup            devnet (RPC from GARUDA_SOLANA_RPC_URL or the public endpoint)
 *   CHAIN_RPC=http://127.0.0.1:8899 pnpm chain:setup   a local validator (for dry runs, NOT devnet)
 *
 * 1. loads or creates the platform keypair at .keys/platform.json (gitignored, mode 0600)
 * 2. tries a devnet airdrop (the public faucet is rate limited / closed at times: fund the printed address at
 *    https://faucet.solana.com by hand and rerun)
 * 3. creates the Garuda Knights collection (Metaplex Core, Royalties plugin)
 * 4. creates a test USDC mint (6 decimals, platform is the mint authority) and the treasury token account
 * 5. writes .keys/chain.json and prints the env lines for the server
 * Re-running reuses what exists. Mainnet RPC URLs are refused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HttpRpc,
  MetaplexCoreKnights,
  SolanaUsdc,
  assertDevnetCluster,
  createTestMint,
  loadOrCreateKeypairFile,
  newSigner,
  solBalance,
  tryAirdrop,
} from "@garuda/chain";

const rpcUrl = process.env.CHAIN_RPC ?? process.env.GARUDA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const local = /127\.0\.0\.1|localhost/.test(rpcUrl);
const keyDir = resolve(process.cwd(), ".keys");
const { keypair, created } = loadOrCreateKeypairFile(resolve(keyDir, "platform.json"));
const statePath = resolve(keyDir, "chain.json");
const state: { collection?: string; usdcMint?: string } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

console.log(`platform key ${created ? "CREATED" : "loaded"}: ${keypair.publicKey}`);
if (!local) await assertDevnetCluster(new HttpRpc(rpcUrl));

const baseUrl = process.env.GARUDA_PUBLIC_URL ?? "http://localhost:3000";
const knights = new MetaplexCoreKnights({ rpcUrl, authority: keypair, baseUrl, collection: state.collection });
const umi = knights.umi;

let bal = await solBalance(umi, keypair.publicKey);
if (bal < 0.5) {
  console.log(`balance ${bal} SOL: requesting airdrop...`);
  for (const amt of [2, 1]) {
    if (await tryAirdrop(umi, keypair.publicKey, amt)) break;
  }
  bal = await solBalance(umi, keypair.publicKey);
}
if (bal < 0.2) {
  console.error(`\nNot enough SOL (${bal}). The devnet faucet refused the airdrop.\nFund ${keypair.publicKey} at https://faucet.solana.com (choose devnet) and run this again.`);
  process.exit(2);
}
console.log(`balance: ${bal} SOL`);

if (!state.collection) {
  const c = await knights.ensureCollection();
  state.collection = c.collection;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`collection created: ${c.collection} (tx ${c.signature})`);
} else console.log(`collection exists: ${state.collection}`);

if (!state.usdcMint) {
  state.usdcMint = await createTestMint(umi, newSigner(umi));
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`test USDC mint created: ${state.usdcMint}`);
} else console.log(`test USDC mint exists: ${state.usdcMint}`);

const usdc = new SolanaUsdc({ rpcUrl, rpc: new HttpRpc(rpcUrl), mint: state.usdcMint, treasury: keypair });
console.log(`treasury token account: ${await usdc.ensureTreasuryAta()}`);

console.log(`
Add to your environment:
GARUDA_CHAIN=devnet
GARUDA_SOLANA_RPC_URL=${rpcUrl}
GARUDA_KEYPAIR_PATH=.keys/platform.json
GARUDA_KNIGHT_COLLECTION=${state.collection}
GARUDA_USDC_MINT=${state.usdcMint}
GARUDA_PUBLIC_URL=${baseUrl}
`);
