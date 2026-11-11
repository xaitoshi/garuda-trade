/**
 * Create the "Garuda Beta Access" Metaplex Core collection (run ONCE per cluster). See docs/early-mint.md.
 *
 *   EARLY_CLUSTER=mainnet-beta EARLY_RPC_URL=https://... EARLY_MINT_KEYPAIR_PATH=~/garuda-early-mint.json \
 *     pnpm early:collection -- --yes
 *
 * Prints the collection address: set it as EARLY_COLLECTION on Railway. The mint authority pays the rent (~0.0016 SOL
 * plus the Metaplex Core protocol fee, if any). Refuses to run unless the RPC's genesis hash matches EARLY_CLUSTER, and on
 * mainnet unless --yes is passed.
 */
import { readFileSync } from "node:fs";
import { EARLY_COLLECTION_NAME, EarlyRpc, MetaplexEarlyMinter, assertEarlyCluster, keypairFromSecret, type EarlyCluster } from "@garuda/chain";

const env = process.env;
const cluster: EarlyCluster = env.EARLY_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";
const rpcUrl = env.EARLY_RPC_URL ?? (cluster === "devnet" ? "https://api.devnet.solana.com" : "");
if (!rpcUrl) throw new Error("Set EARLY_RPC_URL (a mainnet RPC, e.g. Helius)");
const raw = env.EARLY_MINT_KEYPAIR ?? (env.EARLY_MINT_KEYPAIR_PATH ? readFileSync(env.EARLY_MINT_KEYPAIR_PATH.replace(/^~/, env.HOME ?? "~"), "utf8") : "");
if (!raw) throw new Error("Set EARLY_MINT_KEYPAIR_PATH (Solana CLI keypair file) or EARLY_MINT_KEYPAIR");
if (cluster === "mainnet-beta" && !process.argv.includes("--yes")) throw new Error("This creates a collection on MAINNET and spends SOL. Re-run with --yes.");

await assertEarlyCluster(new EarlyRpc(rpcUrl), cluster);
const authority = keypairFromSecret(Uint8Array.from(JSON.parse(raw) as number[]));
const uri = env.EARLY_COLLECTION_URI ?? "https://garuda.markets/early/collection.json";
const m = new MetaplexEarlyMinter({ rpcUrl, cluster, authority, metadataUri: env.EARLY_METADATA_URI ?? "https://garuda.markets/early/metadata.json" });
const before = await m.balanceLamports();
console.log(`cluster ${cluster} | mint authority ${m.authority} | balance ${before / 1e9} SOL`);
const { collection, signature } = await m.createCollection(uri, EARLY_COLLECTION_NAME);
const after = await m.balanceLamports();
console.log(`collection ${collection}\nsignature ${signature}\ncost ${(before - after) / 1e9} SOL\n\nSet on Railway: EARLY_COLLECTION=${collection}`);
