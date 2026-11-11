/**
 * READ-ONLY mainnet dry run of the Beta Access buyer transaction (pnpm early:simulate). Nothing is signed for real and
 * nothing lands: it builds the exact transaction POST /early/claim returns (idempotent treasury USDC account, 1.69 USDC
 * transfer with reference, Core create), prepends a throwaway collection's creation (so no real collection is needed)
 * and runs simulateTransaction with signature checks off, using a large public USDC holder as the pretend buyer.
 * Prints the asset size, the SOL the buyer would spend on it, and the treasury's USDC balance after.
 *
 *   EARLY_RPC_URL=https://api.mainnet-beta.solana.com EARLY_MINT_TREASURY=CCez... pnpm early:simulate
 */
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { findAssociatedTokenPda, mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import { createNoopSigner, generateSigner, publicKey, signerIdentity, transactionBuilder } from "@metaplex-foundation/umi";
import { MAINNET_USDC_MINT, MetaplexEarlyMinter } from "../src/index.js";

const RPC = process.env.EARLY_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TREASURY = process.env.EARLY_MINT_TREASURY ?? "CCezKqU697kanduvFk8GPwD484DGtKH46tfV9o7T2xKq";
const BUYER = process.env.EARLY_SIM_BUYER ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // public exchange wallet holding USDC and SOL
const PRICE = BigInt(Math.round(Number(process.env.EARLY_PRICE_USD ?? 1.69) * 1e6));
const call = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<any>);

const umi = createUmi(RPC).use(mplCore()).use(mplToolbox());
const authority = umi.eddsa.generateKeypair(); // throwaway, never funded
const col = generateSigner(umi);
const minter = new MetaplexEarlyMinter({ rpcUrl: RPC, cluster: "mainnet-beta", authority, collection: col.publicKey, metadataUri: "https://garuda.markets/early/metadata.json" });
const out = await minter.buildPaidMint({
  claimId: "simulate",
  owner: umi.eddsa.generateKeypair().publicKey,
  payer: BUYER,
  usdcMint: MAINNET_USDC_MINT,
  treasury: TREASURY,
  amountBaseUnits: PRICE,
  decimals: 6,
  reference: umi.eddsa.generateKeypair().publicKey,
});
const m = umi.transactions.deserialize(new Uint8Array(Buffer.from(out.transaction, "base64"))).message;
const h = m.header;
const n = m.accounts.length;
const writable = (x: number) => (x < h.numRequiredSignatures ? x < h.numRequiredSignatures - h.numReadonlySignedAccounts : x < n - h.numReadonlyUnsignedAccounts);
const ixs = m.instructions.map((i) => ({ programId: m.accounts[i.programIndex]!, keys: i.accountIndexes.map((x) => ({ pubkey: m.accounts[x]!, isSigner: x < h.numRequiredSignatures, isWritable: writable(x) })), data: i.data }));
const payer = createNoopSigner(publicKey(BUYER));
umi.use(signerIdentity(payer));
const tx = createCollection(umi, { collection: col, name: "Garuda Beta Access", uri: "https://garuda.markets/early/collection.json", updateAuthority: publicKey(authority.publicKey) })
  .add(transactionBuilder(ixs.map((instruction) => ({ instruction, signers: [], bytesCreatedOnChain: 0 }))))
  .setFeePayer(payer)
  .useLegacyVersion()
  .setBlockhash(await umi.rpc.getLatestBlockhash())
  .build(umi);
const treasuryAta = findAssociatedTokenPda(umi, { mint: publicKey(MAINNET_USDC_MINT), owner: publicKey(TREASURY) })[0];
const pre = await umi.rpc.getAccount(treasuryAta);
const sim = (
  await call("simulateTransaction", [
    Buffer.from(umi.transactions.serialize(tx)).toString("base64"),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "jsonParsed", addresses: [out.asset, col.publicKey, treasuryAta] } },
  ])
).result?.value;
console.log(`simulation error: ${JSON.stringify(sim?.err)} | compute units ${sim?.unitsConsumed}`);
console.log(`treasury USDC account ${treasuryAta} ${pre.exists ? "exists" : "MISSING (the buyer tx creates it, +0.00204 SOL once)"}`);
console.log(`asset: ${sim?.accounts?.[0]?.space} bytes, ${sim?.accounts?.[0]?.lamports / 1e9} SOL (rent + 0.0015 SOL Metaplex Core create fee), paid by the buyer`);
console.log(`collection (one-time, paid by the mint authority): ${sim?.accounts?.[1]?.space} bytes, ${sim?.accounts?.[1]?.lamports / 1e9} SOL`);
console.log(`treasury USDC after: ${sim?.accounts?.[2]?.data?.parsed?.info?.tokenAmount?.uiAmountString}`);
