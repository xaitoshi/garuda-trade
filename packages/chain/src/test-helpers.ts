import { transfer, fetchAssetV1, fetchCollectionV1 } from "@metaplex-foundation/mpl-core";
import { mplCore } from "@metaplex-foundation/mpl-core";
import { mplToolbox, transferSol, fetchToken, findAssociatedTokenPda } from "@metaplex-foundation/mpl-toolbox";
import { createSignerFromKeypair, keypairIdentity, publicKey, sol, type Keypair, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";

/** Helpers for scripts and the opt-in chain e2e. Not used by the server. */

/** Request an airdrop (local validator, or devnet when the faucet allows it). Returns false on failure instead of throwing. */
export async function tryAirdrop(umi: Umi, to: string, amountSol: number): Promise<boolean> {
  try {
    await umi.rpc.airdrop(publicKey(to), sol(amountSol));
    return true;
  } catch {
    return false;
  }
}

export async function solBalance(umi: Umi, who: string): Promise<number> {
  return Number((await umi.rpc.getBalance(publicKey(who))).basisPoints) / 1e9;
}

/** Send SOL from the umi identity to another wallet (funds a test buyer). */
export async function fundWallet(umi: Umi, to: string, amountSol: number): Promise<void> {
  await transferSol(umi, { destination: publicKey(to), amount: sol(amountSol) }).sendAndConfirm(umi);
}

/** A Umi that signs as `kp` (a buyer wallet). */
export function umiFor(rpcUrl: string, kp: Keypair): Umi {
  return createUmi(rpcUrl, { commitment: "confirmed" }).use(mplCore()).use(mplToolbox()).use(keypairIdentity(kp));
}

/** Wallet-to-wallet transfer of a knight, signed by the current umi identity (the owner). Throws when the asset is frozen. */
export async function transferKnight(umi: Umi, asset: string, collection: string, to: string): Promise<string> {
  const a = await fetchAssetV1(umi, publicKey(asset));
  const c = await fetchCollectionV1(umi, publicKey(collection));
  const res = await transfer(umi, { asset: a, collection: c, newOwner: publicKey(to) }).sendAndConfirm(umi);
  return base58.deserialize(res.signature)[0];
}

/** USDC (token) balance in base units of a wallet's associated token account; 0n when it does not exist. */
export async function tokenBalance(umi: Umi, mint: string, owner: string): Promise<bigint> {
  const ata = findAssociatedTokenPda(umi, { mint: publicKey(mint), owner: publicKey(owner) })[0];
  try {
    return (await fetchToken(umi, ata)).amount;
  } catch {
    return 0n;
  }
}

export { createSignerFromKeypair };
