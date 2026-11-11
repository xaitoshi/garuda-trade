import { TIERS, type TierId } from "@garuda/risk-engine";

/**
 * Knight tiers, lowest to highest (rulebook section 16). A knight's tier is the tier of the challenge it was minted
 * for, and moves up only when its funded account graduates (Squire Lv.3 levelling up becomes Knight Lv.1, and so on).
 */
export const KNIGHT_TIERS = ["squire", "knight", "paladin", "ascended"] as const;
export type KnightTier = (typeof KNIGHT_TIERS)[number];

/**
 * Status lives onchain in the Attributes plugin: active (live challenge), funded (live funded account), wounded
 * (latest fight breached) or idle (nothing live, transferable). `ascended` is a legacy value from the old level model;
 * it still parses but is no longer written.
 */
export const KNIGHT_STATUSES = ["active", "funded", "wounded", "ascended", "idle"] as const;
export type KnightStatus = (typeof KNIGHT_STATUSES)[number];

export const tierIndex = (t: KnightTier): number => KNIGHT_TIERS.indexOf(t);
export const isKnightTierName = (x: string): x is KnightTier => (KNIGHT_TIERS as readonly string[]).includes(x);
export const isKnightTier = (t: TierId): t is KnightTier => t !== "demo";

/** Everything the platform keeps in a knight's onchain Attributes plugin, plus what the chain says about the asset. */
export interface KnightAttrs {
  /** The knight's tier: the tier of its live (or latest) account. Art and metadata follow the tier. */
  tier: KnightTier;
  /** Funded level within the tier (Funded scaling): 1 until the funded account levels up; 1 again after a breach. */
  level: number;
  status: KnightStatus;
  /** Id of that challenge. */
  challengeId: string;
  /** Challenges passed. */
  wins: number;
  /** Revives used (the knight's scars). */
  revives: number;
}

export interface KnightInfo extends KnightAttrs {
  /** Asset address (this is the knight id). */
  asset: string;
  /** Current owner wallet. */
  owner: string;
  /** Transfer lock (Metaplex Core PermanentFreezeDelegate). True while the knight has a live account. */
  frozen: boolean;
  name: string;
  uri: string;
  /** True when the asset belongs to the Garuda collection with the Garuda update authority (a forged lookalike is not). */
  genuine: boolean;
}

export interface MintKnightInput {
  /** Wallet that receives the knight. */
  owner: string;
  name: string;
  attrs: KnightAttrs;
  /** Order id: the asset address is derived from it, so a retry mints the SAME asset (never a second one). */
  orderId: string;
  /** Mint already frozen (the knight enters a live challenge right away). */
  frozen: boolean;
}

export interface MintKnightResult {
  asset: string;
  /** Mint transaction signature (undefined when the asset already existed: an idempotent retry). */
  signature?: string;
  alreadyMinted: boolean;
}

export interface UpdateKnightInput {
  asset: string;
  attrs: KnightAttrs;
  frozen: boolean;
  /** Knight name stays as minted; only the per-tier metadata URI changes when the knight graduates. */
  name?: string;
}

/**
 * The knight NFT seam. `MetaplexCoreKnights` is the devnet implementation (Metaplex Core); `FakeKnights` is the
 * in-memory one for tests. The service only ever asks these questions.
 */
export interface KnightNft {
  readonly collection: string;
  /** Read a knight. Undefined when the address is not an asset at all. Check `genuine` before trusting it. */
  get(asset: string): Promise<KnightInfo | undefined>;
  mint(input: MintKnightInput): Promise<MintKnightResult>;
  /** Write attributes, the per-level URI and the transfer lock in one transaction. No-op when nothing differs. Returns the signature, or undefined when already in sync. */
  update(input: UpdateKnightInput): Promise<string | undefined>;
  /** Knights of the collection a wallet holds. */
  listByOwner(owner: string): Promise<KnightInfo[]>;
}

/** Fee schedule in USDC (rulebook section 3). */
export const CHALLENGE_FEES_USD: Record<Exclude<TierId, "demo">, number> = { squire: TIERS.squire.fee, knight: TIERS.knight.fee, paladin: TIERS.paladin.fee, ascended: TIERS.ascended.fee };

export const USDC_DECIMALS = 6;
/** Whole cents to base units, exact (no float drift): 95.20 -> 95_200_000. */
export const usdToBaseUnits = (usd: number, decimals = USDC_DECIMALS): bigint => {
  const cents = Math.round(usd * 100);
  return (BigInt(cents) * 10n ** BigInt(decimals)) / 100n;
};
