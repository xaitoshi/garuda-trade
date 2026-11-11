/**
 * Phase 2 routing setup (run by the OWNER on their own machine, never on the server):
 * set the trade-only delegate as the Phoenix position authority of the firm trader account.
 *
 *   pnpm phoenix:delegate --firm <FIRM_WALLET_PUBKEY> --delegate <DELEGATE_PUBKEY> [--pda 0] [--subaccount 0]
 *       prints the DelegateTrader instruction (nothing is signed or sent)
 *   pnpm phoenix:delegate ... --send --keypair ~/.config/solana/garuda-firm.json [--rpc https://...]
 *       signs with the FIRM OWNER keypair file and sends it to MAINNET
 *
 * The owner key is read from a local file only for this one transaction and is never printed. The delegate's PUBLIC
 * key is all this script needs; the delegate secret goes into the server's PHOENIX_DELEGATE_KEYPAIR secret.
 * UNVERIFIED on mainnet: whether isolated child subaccounts inherit the parent's position authority. If the first
 * live order fails with an authority error, run this again with --subaccount <child index> (see docs/phoenix-routing.md).
 */
import { readFileSync } from "node:fs";
import { createPhoenixClient } from "@ellipsis-labs/rise";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from "@solana/kit";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const firm = arg("firm");
const delegate = arg("delegate");
if (!firm || !delegate) {
  console.error("usage: pnpm phoenix:delegate --firm <FIRM_WALLET> --delegate <DELEGATE_PUBKEY> [--pda 0] [--subaccount 0] [--send --keypair <owner.json>]");
  process.exit(1);
}
if (firm === delegate) {
  console.error("The delegate must be a separate key from the firm wallet.");
  process.exit(1);
}
const rpcUrl = arg("rpc") ?? process.env.PHOENIX_TRADE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const px = createPhoenixClient({ apiUrl: process.env.PHOENIX_API_URL ?? "https://perp-api.phoenix.trade", rpcUrl, ws: false });
await px.exchange.ready();
const ix = await px.ixs.buildDelegateTrader({
  traderWallet: firm as never,
  traderPdaIndex: Number(arg("pda") ?? 0),
  traderSubaccountIndex: Number(arg("subaccount") ?? 0),
  newPositionAuthority: delegate as never,
});
console.log("DelegateTrader instruction");
console.log(`  program   ${ix.programAddress}`);
for (const a of ix.accounts ?? []) console.log(`  account   ${a.address} role=${a.role}`);

if (!args.includes("--send")) {
  console.log("\nNot sent. Add --send --keypair <firm owner keypair file> to sign and send on MAINNET.");
  process.exit(0);
}
const keyPath = arg("keypair");
if (!keyPath) {
  console.error("--send needs --keypair <firm owner keypair file>");
  process.exit(1);
}
const owner = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")) as number[]));
if (owner.address !== firm) {
  console.error(`The keypair file is ${owner.address}, not the firm wallet ${firm}.`);
  process.exit(1);
}
const rpc = createSolanaRpc(rpcUrl);
const send = sendAndConfirmTransactionFactory({ rpc: rpc as never, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) as never });
const { value: blockhash } = await rpc.getLatestBlockhash().send();
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(owner, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstructions([ix as unknown as Instruction], m),
);
const tx = await signTransactionMessageWithSigners(msg);
await send(tx as never, { commitment: "confirmed" });
console.log(`Sent: https://solscan.io/tx/${getSignatureFromTransaction(tx)}`);
process.exit(0);
