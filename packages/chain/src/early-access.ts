import { createHmac } from "node:crypto";
import { create, createCollection, fetchAssetV1, fetchCollectionV1, mplCore } from "@metaplex-foundation/mpl-core";
import { createIdempotentAssociatedToken, findAssociatedTokenPda, mplToolbox, transferTokensChecked } from "@metaplex-foundation/mpl-toolbox";
import { createNoopSigner, createSignerFromKeypair, generateSigner, keypairIdentity, publicKey, type Keypair, type KeypairSigner, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { DEVNET_GENESIS_HASH } from "./cluster.js";
import type { FetchLike, JsonRpc } from "./rpc.js";
import { RpcError } from "./rpc.js";
import { withReference } from "./usdc.js";

/**
 * Garuda Beta Access (the /early page). Unlike the knight and checkout code (devnet only, see cluster.ts), this module
 * is MEANT to run on Solana MAINNET: it mints one Metaplex Core asset per paid claim into the "Garuda Beta Access"
 * collection and verifies the buyer's USDC payment. It is off unless EARLY_MINT_ENABLED=true, and the cluster the RPC
 * reports (genesis hash) must match EARLY_CLUSTER, so a devnet key can never be pointed at mainnet by accident.
 */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Circle's USDC on Solana mainnet. */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const EARLY_NFT_NAME = "Garuda Beta Access";
export const EARLY_COLLECTION_NAME = "Garuda Beta Access";

export type EarlyCluster = "mainnet-beta" | "devnet";

export const genesisFor = (c: EarlyCluster) => (c === "mainnet-beta" ? MAINNET_GENESIS_HASH : DEVNET_GENESIS_HASH);

/** Plain JSON-RPC over fetch with NO devnet guard (Beta Access only). The cluster is checked by genesis hash instead. */
export class EarlyRpc implements JsonRpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}
  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new RpcError(method, res.status, `HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message ?? "rpc error");
    return body.result;
  }
}

export async function assertEarlyCluster(rpc: JsonRpc, expected: EarlyCluster): Promise<void> {
  const h = (await rpc.call("getGenesisHash", [])) as string;
  if (h !== genesisFor(expected)) throw new Error(`EARLY_RPC_URL is not ${expected} (genesis ${h}); refusing to mint`);
}

export interface EarlyMintInput {
  /** Claim id: the asset address is derived from it, so a retried mint can never mint twice. */
  claimId: string;
  owner: string;
}
export interface EarlyMintResult {
  asset: string;
  signature?: string;
  alreadyMinted: boolean;
}

export interface PaidMintInput {
  claimId: string;
  /** Receives the NFT. */
  owner: string;
  /** Signs, pays the USDC, the network fee and the asset rent (the connected wallet; may equal owner). */
  payer: string;
  usdcMint: string;
  treasury: string;
  amountBaseUnits: bigint;
  decimals: number;
  /** Unique per claim, attached to the USDC transfer so the server can match the payment. */
  reference: string;
}

export interface PaidMintTx {
  /** Legacy transaction, base64 wire format, already signed by the collection authority and the new asset key. */
  transaction: string;
  asset: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** The chain seam the API uses. Faked in tests. */
export interface EarlyMinter {
  readonly cluster: EarlyCluster;
  readonly collection: string;
  /** Collection update authority (signs each mint; pays nothing per mint in the buyer-paid flow). */
  readonly authority: string;
  /**
   * Buyer-paid mint: ONE transaction that (1) creates the treasury's USDC token account if it is missing (idempotent),
   * (2) moves the USDC from the payer to the treasury with the claim's reference, and (3) creates the Core asset in the
   * collection with the payer as rent and fee payer. Payment and mint land together or not at all; the buyer's wallet
   * adds the last signature, and any change to the message voids the server's signatures.
   */
  buildPaidMint(input: PaidMintInput): Promise<PaidMintTx>;
  /** Current owner of an asset in our collection, or undefined when it does not exist (yet). */
  assetOwner(asset: string): Promise<string | undefined>;
  /** Server-paid mint (admin fallback only; the mint authority pays rent). */
  mint(input: EarlyMintInput): Promise<EarlyMintResult>;
  /** Mint authority SOL balance in lamports (shown on admin status, so ops can top it up). */
  balanceLamports(): Promise<number>;
}

export function earlyAssetKeypair(umi: Pick<Umi, "eddsa">, authoritySecret: Uint8Array, claimId: string): Keypair {
  const seed = createHmac("sha256", Buffer.from(authoritySecret)).update(`garuda-early:${claimId}`).digest();
  return umi.eddsa.createKeypairFromSeed(new Uint8Array(seed));
}

export interface MetaplexEarlyMinterOptions {
  rpcUrl: string;
  cluster: EarlyCluster;
  /** Mint authority: update authority of the collection, fee payer and rent payer of every mint. */
  authority: Keypair;
  /** Existing "Garuda Beta Access" collection (create it once with scripts/early-create-collection.ts). */
  collection?: string;
  /** Asset metadata JSON URI, e.g. https://garuda.markets/nft/early/metadata.json */
  metadataUri: string;
  /**
   * Soulbound (default true): every asset carries a PermanentFreezeDelegate plugin, frozen, whose authority is the
   * update authority. The holder cannot transfer it; the firm can thaw it later if it ever wants them tradable.
   */
  soulbound?: boolean;
  name?: string;
  configureUmi?: (umi: Umi) => void;
}

export class MetaplexEarlyMinter implements EarlyMinter {
  readonly umi: Umi;
  readonly signer: KeypairSigner;
  readonly cluster: EarlyCluster;
  private collectionKey?: string;

  constructor(private readonly o: MetaplexEarlyMinterOptions) {
    this.cluster = o.cluster;
    this.umi = createUmi(o.rpcUrl, { commitment: "confirmed" }).use(mplCore()).use(mplToolbox());
    this.umi.use(keypairIdentity(o.authority));
    o.configureUmi?.(this.umi);
    this.signer = createSignerFromKeypair(this.umi, o.authority);
    this.collectionKey = o.collection;
  }

  get authority(): string {
    return this.signer.publicKey;
  }

  get collection(): string {
    if (!this.collectionKey) throw new Error("EARLY_COLLECTION is not set: run scripts/early-create-collection.ts first");
    return this.collectionKey;
  }

  /** Create the collection (once). Returns the address; the caller stores it in EARLY_COLLECTION. */
  async createCollection(uri: string, name = EARLY_COLLECTION_NAME): Promise<{ collection: string; signature: string }> {
    const c = generateSigner(this.umi);
    const res = await createCollection(this.umi, { collection: c, name, uri }).sendAndConfirm(this.umi);
    this.collectionKey = c.publicKey;
    return { collection: c.publicKey, signature: base58.deserialize(res.signature)[0] };
  }

  async balanceLamports(): Promise<number> {
    const b = await this.umi.rpc.getBalance(this.signer.publicKey);
    return Number(b.basisPoints);
  }

  async buildPaidMint(i: PaidMintInput): Promise<PaidMintTx> {
    const kp = earlyAssetKeypair(this.umi, this.o.authority.secretKey, i.claimId);
    const asset = createSignerFromKeypair(this.umi, kp);
    const payer = createNoopSigner(publicKey(i.payer));
    const mint = publicKey(i.usdcMint);
    const treasury = publicKey(i.treasury);
    const treasuryAta = findAssociatedTokenPda(this.umi, { mint, owner: treasury })[0];
    const payerAta = findAssociatedTokenPda(this.umi, { mint, owner: payer.publicKey })[0];
    const soulbound = this.o.soulbound ?? true;
    const ata = createIdempotentAssociatedToken(this.umi, { payer, ata: treasuryAta, owner: treasury, mint });
    const pay = withReference(transferTokensChecked(this.umi, { source: payerAta, destination: treasuryAta, mint, authority: payer, amount: i.amountBaseUnits, decimals: i.decimals }), i.reference);
    const mintIx = create(this.umi, {
      asset,
      collection: { publicKey: publicKey(this.collection), oracles: [], lifecycleHooks: [] },
      name: this.o.name ?? EARLY_NFT_NAME,
      uri: this.o.metadataUri,
      owner: publicKey(i.owner),
      payer,
      authority: this.signer,
      plugins: soulbound ? [{ type: "PermanentFreezeDelegate", frozen: true, authority: { type: "UpdateAuthority" } }] : [],
    });
    const bh = await this.umi.rpc.getLatestBlockhash({ commitment: "confirmed" });
    const tx = await ata.add(pay).add(mintIx).setFeePayer(payer).useLegacyVersion().setBlockhash(bh).buildAndSign(this.umi);
    return {
      transaction: Buffer.from(this.umi.transactions.serialize(tx)).toString("base64"),
      asset: asset.publicKey,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    };
  }

  async assetOwner(address: string): Promise<string | undefined> {
    try {
      const a = await fetchAssetV1(this.umi, publicKey(address));
      if (a.updateAuthority.type !== "Collection" || a.updateAuthority.address !== this.collection) return undefined;
      return a.owner;
    } catch {
      return undefined;
    }
  }

  async mint(i: EarlyMintInput): Promise<EarlyMintResult> {
    const kp = earlyAssetKeypair(this.umi, this.o.authority.secretKey, i.claimId);
    const asset = createSignerFromKeypair(this.umi, kp);
    const existing = await this.umi.rpc.getAccount(asset.publicKey);
    if (existing.exists) return { asset: asset.publicKey, alreadyMinted: true };
    const collection = await fetchCollectionV1(this.umi, publicKey(this.collection));
    const soulbound = this.o.soulbound ?? true;
    const res = await create(this.umi, {
      asset,
      collection,
      name: this.o.name ?? EARLY_NFT_NAME,
      uri: this.o.metadataUri,
      owner: publicKey(i.owner),
      plugins: soulbound ? [{ type: "PermanentFreezeDelegate", frozen: true, authority: { type: "UpdateAuthority" } }] : [],
    }).sendAndConfirm(this.umi);
    return { asset: asset.publicKey, signature: base58.deserialize(res.signature)[0], alreadyMinted: false };
  }

  /** Read back a minted asset (tests and the devnet smoke run). */
  async fetch(asset: string) {
    return fetchAssetV1(this.umi, publicKey(asset));
  }
}

/** Collection and asset metadata JSON (Metaplex token standard). Served as static files from garuda.markets. */
export function earlyMetadata(imageUrl: string, externalUrl = "https://garuda.markets/early") {
  return {
    name: EARLY_NFT_NAME,
    symbol: "GARUDA",
    description: "Early supporter of Garuda, the first prop firm on Solana, powered by Phoenix. Holders get beta access.",
    image: imageUrl,
    external_url: externalUrl,
    attributes: [{ trait_type: "Access", value: "Beta" }],
    properties: { files: [{ uri: imageUrl, type: "image/png" }], category: "image" },
  };
}
