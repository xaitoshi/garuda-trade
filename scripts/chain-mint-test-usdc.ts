/**
 * Give a wallet test USDC on devnet (the platform key is the mint authority of the test mint made by chain-setup).
 *   pnpm chain:faucet <wallet> [amountUsd=1000]
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { MetaplexCoreKnights, loadKeypairFile, mintTestTokens, usdToBaseUnits } from "@garuda/chain";

const [wallet, amt = "1000"] = process.argv.slice(2);
if (!wallet) {
  console.error("usage: pnpm chain:faucet <wallet> [amountUsd]");
  process.exit(1);
}
const rpcUrl = process.env.CHAIN_RPC ?? process.env.GARUDA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const keyDir = resolve(process.cwd(), ".keys");
const state = JSON.parse(readFileSync(resolve(keyDir, "chain.json"), "utf8")) as { usdcMint: string };
const k = new MetaplexCoreKnights({ rpcUrl, authority: loadKeypairFile(resolve(keyDir, "platform.json")), baseUrl: "http://x" });
const ata = await mintTestTokens(k.umi, state.usdcMint, wallet, usdToBaseUnits(Number(amt)));
console.log(`minted ${amt} test USDC to ${wallet} (token account ${ata}, mint ${state.usdcMint})`);
