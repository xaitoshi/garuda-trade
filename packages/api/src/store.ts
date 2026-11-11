import type { MarketSnapshot } from "@garuda/market-data";
import type {
  ChallengeStatus,
  CombatLogEntry,
  Lifecycle,
  RiskEvent,
  RiskMonitor,
  Stage,
  TierId,
} from "@garuda/risk-engine";
import type { L2Book, SimAccount } from "@garuda/sim-engine";

export interface Challenge {
  id: string;
  tier: TierId;
  stage: Stage;
  knight: string;
  /** Present for paid tiers (the future NFT identity); Demo has no knight NFT. */
  knightId?: string;
  wallet?: string;
  createdAt: number;
  /** Funded accounts go dormant, then archived (rulebook section 18). Always "active" for challenge accounts. */
  lifecycle: Lifecycle;
  /** Last order or payout request. */
  lastActivityAt: number;
  dormantSince?: number;
  archivedAt?: number;
  /** When the account was breached (risk status wounded). */
  breachAt?: number;
  /** Set on the NEW challenge created by a revive: the wounded challenge it replaced. */
  reviveOf?: string;
  /** Set on the WOUNDED challenge once a revive has been bought from it. */
  revivedBy?: string;
  /** Revive generations behind this challenge (the knight's scars). */
  scars: number;
  reviveFeeUsd?: number;
  paymentRef?: string;
  /** Path to Funded claim on a PASSED evaluation (rulebook section 9): KYC, then risk review, then the funded account. */
  claim?: FundedClaim;
  account: SimAccount;
  risk: RiskMonitor;
  combatLog: CombatLogEntry[];
  riskEvents: RiskEvent[];
  books: Map<string, L2Book>;
  fundingRates: Map<string, number>;
  dataSource?: MarketSnapshot["source"];
  /** Serialises operations on one challenge. */
  queue: Promise<unknown>;
}

export type KycStatus = "pending" | "approved" | "rejected";
export type ClaimStatus = "kyc_pending" | "under_review" | "approved" | "rejected";

export interface FundedClaim {
  status: ClaimStatus;
  kyc: KycStatus;
  claimedAt: number;
  /** Who claimed (the signed-in wallet, or the knight holder). The funded account opens for this wallet. */
  wallet?: string;
  kycAt?: number;
  kycBy?: string;
  reviewedAt?: number;
  reviewedBy?: string;
  reason?: string;
  /** The funded account opened when the review was approved. */
  fundedId?: string;
}

/** Light row used for caps, revive counts and the worker's active list (no ledger load). */
export interface ChallengeSummary {
  id: string;
  tier: TierId;
  stage: Stage;
  status: ChallengeStatus;
  lifecycle: Lifecycle;
  wallet?: string;
  knightId?: string;
  /** Account size (starting balance). */
  size: number;
  createdAt: number;
  breachAt?: number;
  reviveOf?: string;
  revivedBy?: string;
}

export interface SummaryFilter {
  wallet?: string;
  knightId?: string;
  status?: ChallengeStatus;
}

export interface ReviveRequestRecord {
  idempotencyKey: string;
  wallet: string;
  sourceChallengeId: string;
  newChallengeId: string;
  createdAt: number;
}

/**
 * Persistence seam. `save` is called (inside the challenge's serialised queue) after every mutation and must
 * persist the whole challenge: row, resting-order state and any NEW ledger rows. Implementations may cache
 * live challenge objects (a single API process owns each challenge).
 */
export interface ChallengeStore {
  get(id: string): Promise<Challenge | undefined>;
  list(filter?: { wallet?: string }): Promise<Challenge[]>;
  summaries(filter?: SummaryFilter): Promise<ChallengeSummary[]>;
  save(c: Challenge): Promise<void>;
  findReviveRequest(idempotencyKey: string): Promise<ReviveRequestRecord | undefined>;
  saveReviveRequest(r: ReviveRequestRecord): Promise<void>;
}

export function summarize(c: Challenge): ChallengeSummary {
  return {
    id: c.id,
    tier: c.tier,
    stage: c.stage,
    status: c.risk.status,
    lifecycle: c.lifecycle,
    wallet: c.wallet,
    knightId: c.knightId,
    size: c.account.startingBalance,
    createdAt: c.createdAt,
    breachAt: c.breachAt,
    reviveOf: c.reviveOf,
    revivedBy: c.revivedBy,
  };
}

export function matchesFilter(s: ChallengeSummary, f: SummaryFilter = {}): boolean {
  return (
    (f.wallet === undefined || s.wallet === f.wallet) &&
    (f.knightId === undefined || s.knightId === f.knightId) &&
    (f.status === undefined || s.status === f.status)
  );
}

export class InMemoryChallengeStore implements ChallengeStore {
  private m = new Map<string, Challenge>();
  private revives = new Map<string, ReviveRequestRecord>();
  async get(id: string) {
    return this.m.get(id);
  }
  async save(c: Challenge) {
    this.m.set(c.id, c);
  }
  async list(filter: { wallet?: string } = {}) {
    return [...this.m.values()].filter((c) => filter.wallet === undefined || c.wallet === filter.wallet);
  }
  async summaries(filter: SummaryFilter = {}) {
    return [...this.m.values()].map(summarize).filter((s) => matchesFilter(s, filter));
  }
  async findReviveRequest(key: string) {
    return this.revives.get(key);
  }
  async saveReviveRequest(r: ReviveRequestRecord) {
    this.revives.set(r.idempotencyKey, r);
  }
}
