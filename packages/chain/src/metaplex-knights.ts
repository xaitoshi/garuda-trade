import { createHmac } from "node:crypto";
import {
  Key,
  createCollection,
  create,
  fetchAssetV1,
  fetchCollectionV1,
  getAssetV1GpaBuilder,
  mplCore,
  ruleSet,
  updatePlugin,
  update,
  type AssetV1,
} from "@metaplex-foundation/mpl-core";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import {
  createSignerFromKeypair,
  generateSigner,
  keypairIdentity,
  publicKey,
  transactionBuilder,
  type Keypair,
  type KeypairSigner,
  type PublicKey,
  type TransactionBuilder,
  type Umi,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { assertDevnetUrl } from "./cluster.js";
import { COLLECTION_NAME, collectionMetadataUri, fromAttributeList, tierMetadataUri, sameAttrs, toAttributeList } from "./metadata.js";
import type { KnightInfo, KnightNft, MintKnightInput, MintKnightResult, UpdateKnightInput } from "./types.js";

export interface MetaplexKnightsOptions {
  /** Devnet RPC URL. Refused when it looks like mainnet. */
  rpcUrl: string;
  /** Update authority of the collection and of every knight, fee payer, and (on devnet) the treasury. */
  authority: Keypair;
  /** Where the metadata JSON and PNGs are served (the API's /nft routes for now). */
  baseUrl: string;
  /** Existing collection address. When omitted call `ensureCollection()` once. */
  collection?: string;
  /** Creator royalty in basis points on secondary sales (roadmap open question: default 5%). */
  royaltyBps?: number;
  /** Test hook: replace the Umi HTTP layer (mock RPC). */
  configureUmi?: (umi: Umi) => void;
}

/** Deterministic keypair for an order's knight: the same order always means the same asset address, so a retried mint cannot duplicate. */
export function knightAssetKeypair(umi: Pick<Umi, "eddsa">, authoritySecret: Uint8Array, orderId: string): Keypair {
  const seed = createHmac("sha256", Buffer.from(authoritySecret)).update(`garuda-knight:${orderId}`).digest();
  return umi.eddsa.createKeypairFromSeed(new Uint8Array(seed));
}

const FREEZE = "permanentFreezeDelegate" as const;

/** Metaplex Core implementation of the knight NFT seam (devnet). */
export class MetaplexCoreKnights implements KnightNft {
  readonly umi: Umi;
  readonly authority: KeypairSigner;
  private collectionKey?: PublicKey;
  private readonly royaltyBps: number;
  private readonly baseUrl: string;

  constructor(private readonly opts: MetaplexKnightsOptions) {
    assertDevnetUrl(opts.rpcUrl);
    this.umi = createUmi(opts.rpcUrl, { commitment: "confirmed" }).use(mplCore()).use(mplToolbox());
    this.authority = createSignerFromKeypair(this.umi, opts.authority);
    this.umi.use(keypairIdentity(opts.authority));
    opts.configureUmi?.(this.umi);
    this.baseUrl = opts.baseUrl;
    this.royaltyBps = opts.royaltyBps ?? 500;
    if (opts.collection) this.collectionKey = publicKey(opts.collection);
  }

  get collection(): string {
    if (!this.collectionKey) throw new Error("Knight collection not set: call ensureCollection() or pass `collection`");
    return this.collectionKey;
  }

  /** Create the Garuda collection (with the Royalties plugin) unless one is configured. Returns its address. */
  async ensureCollection(): Promise<{ collection: string; signature?: string }> {
    if (this.collectionKey) return { collection: this.collectionKey };
    const collection = generateSigner(this.umi);
    const res = await createCollection(this.umi, {
      collection,
      name: COLLECTION_NAME,
      uri: collectionMetadataUri(this.baseUrl),
      plugins: [
        {
          type: "Royalties",
          basisPoints: this.royaltyBps,
          creators: [{ address: this.authority.publicKey, percentage: 100 }],
          ruleSet: ruleSet("None"),
        },
      ],
    }).sendAndConfirm(this.umi);
    this.collectionKey = collection.publicKey;
    return { collection: collection.publicKey, signature: base58.deserialize(res.signature)[0] };
  }

  async get(address: string): Promise<KnightInfo | undefined> {
    let pk: PublicKey;
    try {
      pk = publicKey(address);
    } catch {
      return undefined;
    }
    let asset: AssetV1;
    try {
      asset = await fetchAssetV1(this.umi, pk);
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      if (name === "AccountNotFoundError" || name === "UnexpectedAccountError" || name === "DeserializingError" || /not found|deserializ|expected/i.test((e as Error)?.message ?? "")) return undefined;
      throw e;
    }
    return this.toInfo(asset);
  }

  private toInfo(asset: AssetV1): KnightInfo | undefined {
    const attrs = fromAttributeList(asset.attributes?.attributeList ?? []);
    const inCollection = asset.updateAuthority.type === "Collection" && asset.updateAuthority.address === this.collection;
    // Attributes written by anyone but our authority do not count: the plugin authority must be the update authority.
    const attrAuthorityOk = asset.attributes?.authority.type === "UpdateAuthority";
    if (!attrs) return undefined;
    return {
      ...attrs,
      asset: asset.publicKey,
      owner: asset.owner,
      frozen: asset[FREEZE]?.frozen ?? false,
      name: asset.name,
      uri: asset.uri,
      genuine: inCollection && attrAuthorityOk && asset[FREEZE]?.authority.type === "UpdateAuthority",
    };
  }

  async mint(input: MintKnightInput): Promise<MintKnightResult> {
    const kp = knightAssetKeypair(this.umi, this.opts.authority.secretKey, input.orderId);
    const signer = createSignerFromKeypair(this.umi, kp);
    const existing = await this.umi.rpc.getAccount(signer.publicKey);
    if (existing.exists) return { asset: signer.publicKey, alreadyMinted: true };
    const collection = await fetchCollectionV1(this.umi, publicKey(this.collection));
    const res = await create(this.umi, {
      asset: signer,
      collection,
      name: input.name,
      uri: tierMetadataUri(this.baseUrl, input.attrs.tier),
      owner: publicKey(input.owner),
      plugins: [
        { type: "Attributes", attributeList: toAttributeList(input.attrs), authority: { type: "UpdateAuthority" } },
        { type: "PermanentFreezeDelegate", frozen: input.frozen, authority: { type: "UpdateAuthority" } },
      ],
    }).sendAndConfirm(this.umi);
    return { asset: signer.publicKey, signature: base58.deserialize(res.signature)[0], alreadyMinted: false };
  }

  async update(input: UpdateKnightInput): Promise<string | undefined> {
    const asset = await fetchAssetV1(this.umi, publicKey(input.asset));
    const cur = this.toInfo(asset);
    if (!cur) throw new Error(`Knight ${input.asset} is not a Garuda knight`);
    const collection = await fetchCollectionV1(this.umi, publicKey(this.collection));
    const wantUri = tierMetadataUri(this.baseUrl, input.attrs.tier);
    let b: TransactionBuilder = transactionBuilder();
    // Compare the RAW list too: a knight minted before Funded scaling stores level as a tier name, which parses as
    // Lv.1 (equal attrs) but must still be rewritten in the new shape.
    const rawNow = JSON.stringify(asset.attributes?.attributeList ?? []);
    if (!sameAttrs(cur, input.attrs) || rawNow !== JSON.stringify(toAttributeList(input.attrs))) {
      b = b.add(updatePlugin(this.umi, { asset: asset.publicKey, collection: collection.publicKey, plugin: { type: "Attributes", attributeList: toAttributeList(input.attrs) } }));
    }
    if (cur.frozen !== input.frozen) {
      b = b.add(updatePlugin(this.umi, { asset: asset.publicKey, collection: collection.publicKey, plugin: { type: "PermanentFreezeDelegate", frozen: input.frozen } }));
    }
    if (cur.uri !== wantUri) {
      b = b.add(update(this.umi, { asset, collection, uri: wantUri }));
    }
    if (b.items.length === 0) return undefined;
    const res = await b.sendAndConfirm(this.umi);
    return base58.deserialize(res.signature)[0];
  }

  async listByOwner(owner: string): Promise<KnightInfo[]> {
    const accts = await getAssetV1GpaBuilder(this.umi).whereField("key", Key.AssetV1).whereField("owner", publicKey(owner)).getDeserialized();
    return accts.map((a) => this.toInfo(a)).filter((x): x is KnightInfo => x !== undefined && x.genuine);
  }
}
