import { randomUUID } from "node:crypto";
import {
  deriveKnightState,
  isLive,
  levelIndex,
  type KnightHistoryRow,
  type KnightInfo,
  type KnightLevel,
  type KnightNft,
} from "@garuda/chain";
import type { MarketDataProvider, MarketSnapshot } from "@garuda/market-data";
import {
  CIRCUIT_BREAKER,
  COMMON_RULES,
  DEFAULT_PAYOUT_POLICY,
  DORMANCY,
  REVIVE_RULES,
  TIERS,
  checkAccountCaps,
  checkOrderLeverage,
  checkRevive,
  dailyLedger,
  demoRestartAt,
  fundedProgress,
  fillsToCombat,
  isWhitelisted,
  leverageCap,
  limitsForTier,
  maxOrderSize,
  nextLifecycle,
  normalizeSymbol,
  quotePayout,
  requiredMargin,
  riskEventToCombat,
  RiskMonitor,
  usd,
  type CombatLogEntry,
  type DailyLedger,
  type FundedProgress,
  type HeldAccount,
  type Lifecycle,
  type PayoutPolicy,
  type PayoutQuote,
  type ReviveCheck,
  type RiskEvent,
  type RiskSnapshot,
  type Stage,
  type TierId,
} from "@garuda/risk-engine";
import {
  SimAccount,
  SimEngine,
  type EngineOptions,
  type Fill,
  type L2Book,
  type Order,
  type OrderRequest,
  type RestingFillGate,
} from "@garuda/sim-engine";
import { StubPaymentProvider, type PaymentProvider } from "./payments.js";
import { InMemoryChallengeStore, summarize, type Challenge, type ChallengeStore, type ChallengeSummary, type FundedClaim, type KycStatus } from "./store.js";

export type { Challenge, ChallengeStore } from "./store.js";
export { InMemoryChallengeStore } from "./store.js";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code);
  }
}

export interface ServiceDeps {
  market: MarketDataProvider;
  store?: ChallengeStore;
  /** Challenge clock (ms). Injectable so demos/tests can simulate days. */
  now?: () => number;
  engine?: EngineOptions;
  /** Enforce Paladin/Ascended NFT gating on create. Default true. */
  enforceGating?: boolean;
  /** Revive checkout. Default: StubPaymentProvider (always succeeds; real USDC checkout is roadmap M4). */
  payments?: PaymentProvider;
  /** Refuse an anonymous Demo (no wallet). Default false for library use; the HTTP server turns it on. */
  requireWalletForDemo?: boolean;
  /**
   * Knight NFTs (Metaplex Core, M3). When set: a paid Squire/Knight challenge mints a knight, Paladin/Ascended need a
   * knight the wallet OWNS onchain (`knightAsset`, `nftLevels` is ignored), the knight is transfer-locked while it has a
   * live challenge, and level/status/wins/revives are written back onchain.
   */
  knights?: KnightNft;
  /**
   * Real money mode (M4): paid tiers and revives can only be opened with a verified USDC payment (the PurchaseService
   * passes `paid`). Without it, `create` of a paid tier is refused with 402 `payment_required`.
   */
  requirePayment?: boolean;
  /** Payout split, minimum and auto-approve ceiling (M8). Default: the rulebook numbers. */
  payoutPolicy?: PayoutPolicy;
  /**
   * Path to Funded identity check (rulebook section 9, step 6). "manual": a claim waits in kyc_pending until ops
   * approves it (POST /admin/claims/:id/kyc). "auto": KYC is approved on claim (dev and tests). Default "auto" for
   * library use; the HTTP server defaults to "manual". TODO: vendor integration (e.g. Sumsub) replaces the manual step.
   */
  kycMode?: "auto" | "manual";
  /**
   * Path to Funded risk review (step 7, target about 1 business day). "manual": a claim waits in under_review until ops
   * approves it (POST /admin/claims/:id/approve), which opens the funded account. "auto": approved at once (dev, tests).
   * When either step is manual, a funded account can ONLY be opened through an approved claim.
   */
  fundedReview?: "auto" | "manual";
  /**
   * Phase 2 routing hook (packages/router): called synchronously after every batch of simulated fills, on every stage.
   * Must not throw or block; the router filters to selected FUNDED accounts and queues its own work.
   */
  onFills?: (ev: FillsEvent) => void;
}

/** Simulated fills on one account plus its signed position per filled symbol afterwards (the routing hook's input). */
export interface FillsEvent {
  challengeId: string;
  stage: Stage;
  demo: boolean;
  wallet?: string;
  status: string;
  fills: Fill[];
  positions: Record<string, number>;
}

/** Path to Funded view of an account: progress on the four pass requirements plus the claim (KYC and review). */
export interface PathToFunded extends FundedProgress {
  claim?: FundedClaim;
  /** What the trader should do next. */
  next: "trade" | "claim" | "verify_identity" | "under_review" | "funded" | "rejected" | "none";
}

export interface CreateOpts {
  /** Deterministic challenge id (purchases derive it from the order, so a retry cannot open a second account). */
  id?: string;
  /** Set by the PurchaseService after a verified payment. */
  paid?: { orderId: string; ref: string; amountUsd?: number };
  /** Internal: an approved Path to Funded claim is opening this funded account. */
  claimApproved?: boolean;
}

export interface CreateChallengeInput {
  tier: TierId;
  stage?: Stage;
  knight?: string;
  wallet?: string;
  /** Knight NFT levels held by the wallet. TRUSTED INPUT, honoured ONLY when no `knights` chain is configured (dev and legacy tests). */
  nftLevels?: TierId[];
  /** Paladin/Ascended (and funded) accounts: the knight's asset address. Its owner, level and status are read onchain. */
  knightAsset?: string;
}

export interface PlaceOrderInput {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  type: "market" | "limit";
  limitPrice?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
}

export interface PlaceOrderResult {
  accepted: boolean;
  /** Present when !accepted. */
  reason?: string;
  order?: Order;
  fills: Fill[];
  avgPrice?: number;
  slippageBps?: number;
  events: RiskEvent[];
  combat: CombatLogEntry[];
  state: ChallengeState;
}

export interface ChallengeState {
  id: string;
  simulated: true;
  tier: TierId;
  stage: Stage;
  knight: string;
  /** Paid tiers only. Demo has no knight NFT. */
  knightId?: string;
  /** True for the free Demo: no NFT, no payouts, no unlock credit. */
  demo: boolean;
  wallet?: string;
  status: RiskSnapshot["status"];
  /** Funded accounts only: active, dormant (90 days idle) or archived (365 days dormant). */
  lifecycle: Lifecycle;
  lastActivityAt: number;
  dormantSince?: number;
  archivedAt?: number;
  payoutsEnabled: boolean;
  /** Evaluation accounts: progress on the Path to Funded requirements and the claim state. Null on funded accounts. */
  pathToFunded: PathToFunded | null;
  reviveOf?: string;
  revivedBy?: string;
  scars: number;
  createdAt: number;
  dataSource?: string;
  account: {
    startingBalance: number;
    balance: number;
    equity: number;
    unrealizedPnl: number;
    realizedPnl: number;
    /** Net USD swept out of the balance by payouts so far (sweeps minus reversals). */
    paidOut: number;
    feesPaid: number;
    fundingPaid: number;
    grossNotional: number;
    requiredMargin: number;
    effectiveLeverage: number;
  };
  risk: RiskSnapshot;
  positions: {
    symbol: string;
    side: "long" | "short";
    size: number;
    entryPrice: number;
    markPrice: number;
    notional: number;
    unrealizedPnl: number;
    leverageCap?: number;
  }[];
  openOrders: Order[];
  recentFills: Fill[];
  combatLog: CombatLogEntry[];
}

export interface ReviveInfo extends ReviveCheck {
  challengeId: string;
  knightId?: string;
  tier: TierId;
}

export interface ReviveResult {
  /** True when this call replayed an earlier request with the same idempotency key. */
  replayed: boolean;
  feeUsd: number;
  paymentRef: string;
  state: ChallengeState;
  revive: ReviveInfo;
}

export interface MarketUpdateResult {
  challengeId: string;
  events: RiskEvent[];
  fills: Fill[];
  status: RiskSnapshot["status"];
}

const depthWithin = (levels: readonly (readonly [number, number])[], mid: number, side: "buy" | "sell") => {
  const band = CIRCUIT_BREAKER.depthBandPct;
  let usd = 0;
  for (const [p, s] of levels) {
    if (side === "buy" ? p > mid * (1 + band) : p < mid * (1 - band)) break;
    usd += p * s;
  }
  return usd;
};

const TERMINAL_LIFECYCLE: Lifecycle = "archived";

/** USD rounded DOWN to whole cents: a payout never pays the trader a fraction of a cent more than the quote. */
export const floorCents = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;

const payoutReasonText = (reason: PayoutQuote["reason"], p: PayoutPolicy): string =>
  reason === "open_positions"
    ? "Close all open positions before requesting a payout"
    : reason === "no_profit"
      ? "No profit above the starting balance to pay out"
      : reason === "best_day_rule"
        ? `Best-day rule: no single day may be more than ${Math.round((p.bestDayMaxShare ?? COMMON_RULES.bestDayMaxShare) * 100)}% of your profitable days. Keep trading to spread the profit`
        : `Your share of the profit is below the $${p.minUsd} minimum payout`;

/** Challenge ids opened by a paid revive derive from the order id, so a retry can never open a second account. */
export const reviveChallengeId = (orderId: string) => `ch_${orderId.replace(/^ord_/, "")}`;

export class ChallengeService {
  readonly market: MarketDataProvider;
  readonly store: ChallengeStore;
  readonly engine: SimEngine;
  readonly payments: PaymentProvider;
  private readonly now: () => number;
  private readonly enforceGating: boolean;
  private readonly requireWalletForDemo: boolean;
  private readonly requirePayment: boolean;
  readonly payoutPolicy: PayoutPolicy;
  /** Knight NFT chain (undefined = no NFTs: legacy trusted `nftLevels` mode). */
  readonly knights?: KnightNft;
  private knightChains = new Map<string, Promise<unknown>>();
  /** Knights whose onchain state failed to sync (RPC down). `reconcileKnights` retries them. */
  private dirtyKnights = new Set<string>();
  /** symbol -> ids of live challenges holding a position or resting order in it (the worker's routing table). */
  private bySymbol = new Map<string, Set<string>>();
  private symbolsOf = new Map<string, Set<string>>();
  private liveIds = new Set<string>();
  private haltedSymbols = new Set<string>();
  private createChains = new Map<string, Promise<unknown>>();
  readonly kycMode: "auto" | "manual";
  readonly fundedReview: "auto" | "manual";
  private readonly onFills?: (ev: FillsEvent) => void;

  constructor(deps: ServiceDeps) {
    this.onFills = deps.onFills;
    this.market = deps.market;
    this.store = deps.store ?? new InMemoryChallengeStore();
    this.engine = new SimEngine(deps.engine);
    this.payments = deps.payments ?? new StubPaymentProvider();
    this.now = deps.now ?? Date.now;
    this.enforceGating = deps.enforceGating ?? true;
    this.requireWalletForDemo = deps.requireWalletForDemo ?? false;
    this.knights = deps.knights;
    this.requirePayment = deps.requirePayment ?? false;
    this.payoutPolicy = deps.payoutPolicy ?? DEFAULT_PAYOUT_POLICY;
    this.kycMode = deps.kycMode ?? "auto";
    this.fundedReview = deps.fundedReview ?? "auto";
  }

  /** True when funded accounts may only open through an approved claim (KYC or review is a manual step). */
  get claimGate(): boolean {
    return this.kycMode === "manual" || this.fundedReview === "manual";
  }

  // ------------------------------------------------------------------ create

  async create(input: CreateChallengeInput, opts: CreateOpts = {}): Promise<ChallengeState> {
    const spec = TIERS[input.tier];
    if (!spec) throw new ServiceError(400, "unknown_tier");
    const stage = input.stage ?? "evaluation";
    const isDemo = input.tier === "demo";
    if (isDemo && stage !== "evaluation") throw new ServiceError(400, "demo_evaluation_only", "Demo has no funded stage");
    if (isDemo && this.requireWalletForDemo && !input.wallet) throw new ServiceError(400, "wallet_required", "Demo needs a signed-in wallet");
    // Path to Funded: with KYC or the risk review switched on, the only door to a funded account is an approved claim.
    if (stage === "funded" && this.claimGate && !opts.claimApproved) {
      throw new ServiceError(403, "claim_required", "Funded accounts open through the Path to Funded claim: POST /challenges/:id/claim on your passed challenge");
    }
    // Real money mode: a paid evaluation only opens through a verified payment (PurchaseService passes `paid`).
    if (!isDemo && stage === "evaluation" && this.requirePayment && !opts.paid) {
      throw new ServiceError(402, "payment_required", "Paid tiers are bought with USDC: POST /purchases/challenge, pay, then confirm", { quote: "/purchases/challenge" });
    }
    // Legacy gating from trusted client input. With a knight chain configured the knight is verified onchain instead.
    if (!isDemo && !this.knights && this.enforceGating && spec.requires && !(input.nftLevels ?? []).includes(spec.requires)) {
      throw new ServiceError(403, "tier_locked", `${spec.name} requires a ${TIERS[spec.requires].name}-level knight NFT`);
    }
    return this.withCreateLock(input.wallet, async () => {
      if (opts.id) {
        const existing = await this.store.get(opts.id);
        if (existing) return this.view(existing); // an order retry: the account is already open
      }
      await this.assertCanOpen({ tier: input.tier, stage, wallet: input.wallet });
      const ch = this.build({
        tier: input.tier,
        stage,
        knight: input.knight,
        wallet: input.wallet,
        knightId: isDemo || this.knights ? undefined : `kn_${randomUUID().slice(0, 8)}`,
        id: opts.id,
      });
      if (!isDemo && this.knights) await this.attachKnight(ch, input, stage, opts);
      if (opts.paid) ch.paymentRef = opts.paid.ref;
      await this.store.save(ch);
      this.reindex(ch);
      if (ch.knightId && this.knights) await this.syncKnightSafe(ch.knightId);
      return this.view(ch);
    });
  }

  /** Everything `create` checks that does not change anything (caps, tier gating, knight ownership): lets a checkout fail BEFORE the user pays. */
  async assertCanCreate(input: CreateChallengeInput): Promise<void> {
    const spec = TIERS[input.tier];
    if (!spec || input.tier === "demo") throw new ServiceError(400, "unknown_tier");
    const stage = input.stage ?? "evaluation";
    if (stage === "funded" && this.claimGate) throw new ServiceError(403, "claim_required", "Funded accounts open through the Path to Funded claim");
    if (!this.knights && this.enforceGating && spec.requires && !(input.nftLevels ?? []).includes(spec.requires)) {
      throw new ServiceError(403, "tier_locked", `${spec.name} requires a ${TIERS[spec.requires].name}-level knight NFT`);
    }
    await this.assertCanOpen({ tier: input.tier, stage, wallet: input.wallet });
    if (this.knights && input.wallet && (stage === "funded" || (spec.requires && this.enforceGating))) await this.verifyKnight(input, stage);
  }

  // ----------------------------------------------------------------- knights

  /**
   * Read the knight behind a gated or funded account OFFCHAIN-trust-free: it must be a genuine asset of our collection,
   * owned by the wallet right now, high enough, not Wounded and not already in a live evaluation.
   */
  private async verifyKnight(input: CreateChallengeInput, stage: Stage): Promise<KnightInfo> {
    const knights = this.knights!;
    const spec = TIERS[input.tier];
    if (!input.wallet) throw new ServiceError(403, "wallet_required", "Sign in with the wallet that holds the knight");
    if (!input.knightAsset) {
      throw new ServiceError(403, "tier_locked", `${spec.name} needs a knight: pass knightAsset (the knight NFT address you hold)`);
    }
    const info = await knights.get(input.knightAsset);
    if (!info || !info.genuine) throw new ServiceError(403, "knight_not_genuine", "That asset is not a Garuda knight");
    if (info.owner !== input.wallet) throw new ServiceError(403, "not_knight_owner", "The signed-in wallet does not hold that knight");
    const rows = await this.store.summaries({ knightId: info.asset });
    if (stage === "funded") {
      const passed = rows.some((r) => r.tier === input.tier && r.stage === "evaluation" && r.status === "passed");
      if (!passed) throw new ServiceError(403, "evaluation_not_passed", "A funded account needs a passed evaluation of the same tier on this knight");
      if (rows.some((r) => r.stage === "funded" && r.tier === input.tier && isLive(r))) throw new ServiceError(409, "funded_exists", "This knight already has a live funded account at that tier");
      return info;
    }
    if (spec.requires && levelIndex(info.level) < levelIndex(spec.requires as KnightLevel)) {
      throw new ServiceError(403, "tier_locked", `${spec.name} requires a ${TIERS[spec.requires].name}-level knight (this one is ${info.level})`);
    }
    if (info.status === "wounded" || deriveKnightState(rows.map((r) => this.toRow(r))).attrs.status === "wounded") {
      throw new ServiceError(403, "knight_wounded", "A Wounded knight cannot enter a gated tier: revive it first");
    }
    if (rows.some((r) => r.stage === "evaluation" && isLive(r))) throw new ServiceError(409, "knight_busy", "This knight is already in a live challenge");
    return info;
  }

  /** Bind a knight to a new challenge: mint a Squire-level knight, or verify and transfer-lock the one passed in. */
  private async attachKnight(ch: Challenge, input: CreateChallengeInput, stage: Stage, opts: CreateOpts): Promise<void> {
    const knights = this.knights!;
    const spec = TIERS[input.tier];
    if (stage === "funded" || (spec.requires && this.enforceGating)) {
      const info = await this.verifyKnight(input, stage);
      ch.knightId = info.asset;
      // The knight keeps its name across accounts: reuse the onchain one unless the caller picked a name.
      if (!input.knight?.trim()) ch.knight = info.name.replace(/^Knight /, "").trim() || ch.knight;
      await this.lockKnight(ch, info.owner);
      return;
    }
    if (!input.wallet) throw new ServiceError(400, "wallet_required", "A knight is minted to a wallet: sign in first");
    try {
      const res = await knights.mint({
        owner: input.wallet,
        name: `Knight ${ch.knight}`.slice(0, 32),
        orderId: opts.paid?.orderId ?? ch.id,
        frozen: true,
        attrs: { level: "squire", status: "active", tier: input.tier as KnightLevel, challengeId: ch.id, wins: 0, revives: 0 },
      });
      ch.knightId = res.asset;
    } catch (e) {
      throw new ServiceError(502, "mint_failed", `Knight mint failed: ${(e as Error).message}`);
    }
  }

  /**
   * Freeze the knight for `ch` BEFORE the challenge is saved, then re-read the owner: if the knight moved between the
   * ownership check and the freeze, undo and refuse, so a live challenge never sits on a knight somebody else now holds.
   */
  private async lockKnight(ch: Challenge, expectedOwner: string): Promise<void> {
    const id = ch.knightId!;
    try {
      await this.syncKnight(id, { extra: summarize(ch) });
    } catch (e) {
      this.dirtyKnights.add(id);
      throw new ServiceError(502, "knight_lock_failed", `Could not lock the knight onchain: ${(e as Error).message}`);
    }
    const after = await this.knights!.get(id);
    if (!after || after.owner !== expectedOwner) {
      await this.syncKnightSafe(id);
      throw new ServiceError(409, "knight_moved", "The knight changed hands while the challenge was opening");
    }
  }

  private toRow(s: ChallengeSummary): KnightHistoryRow {
    return { id: s.id, tier: s.tier, stage: s.stage, status: s.status, lifecycle: s.lifecycle, createdAt: s.createdAt, reviveOf: s.reviveOf };
  }

  private knightQueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.knightChains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.knightChains.set(id, tail);
    void tail.then(() => {
      if (this.knightChains.get(id) === tail) this.knightChains.delete(id);
    });
    return run;
  }

  /**
   * Write the knight's derived state onchain: level, status, wins, revives, current tier and challenge, the per-level
   * metadata URI, and the transfer lock (frozen while any challenge is live). Idempotent: nothing is sent when the chain
   * already matches. `extra` is a challenge not saved yet (so a lock can land before the row exists).
   */
  async syncKnight(knightId: string, o: { extra?: ChallengeSummary } = {}): Promise<string | undefined> {
    const knights = this.knights;
    if (!knights) return undefined;
    return this.knightQueue(knightId, async () => {
      const rows = (await this.store.summaries({ knightId })).filter((r) => r.id !== o.extra?.id);
      if (o.extra) rows.push(o.extra);
      const want = deriveKnightState(rows.map((r) => this.toRow(r)));
      const sig = await knights.update({ asset: knightId, attrs: want.attrs, frozen: want.frozen });
      this.dirtyKnights.delete(knightId);
      return sig;
    });
  }

  /** `syncKnight` that never throws: a failure marks the knight dirty for `reconcileKnights`. */
  private async syncKnightSafe(knightId: string | undefined): Promise<void> {
    if (!knightId || !this.knights) return;
    try {
      await this.syncKnight(knightId);
    } catch {
      this.dirtyKnights.add(knightId);
    }
  }

  /** Knights waiting for a retry (RPC failure on the last sync). */
  dirtyKnightIds(): string[] {
    return [...this.dirtyKnights];
  }

  /** Retry dirty knights; `all` re-syncs every knight that has ever fought. Returns how many were synced and how many still fail. */
  async reconcileKnights(o: { all?: boolean } = {}): Promise<{ synced: number; failed: number }> {
    if (!this.knights) return { synced: 0, failed: 0 };
    const ids = new Set(this.dirtyKnights);
    if (o.all) for (const s of await this.store.summaries()) if (s.knightId) ids.add(s.knightId);
    let synced = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.syncKnight(id);
        synced++;
      } catch {
        this.dirtyKnights.add(id);
        failed++;
      }
    }
    return { synced, failed };
  }

  /** May this wallet act on the challenge? The owner of record always; for a WOUNDED knight, whoever holds it onchain now (rights follow the knight). */
  async canAct(id: string, wallet: string | undefined): Promise<boolean> {
    const ch = await this.get(id);
    if (!wallet) return false;
    if (this.knights && ch.knightId && ch.risk.status === "wounded") {
      const info = await this.knights.get(ch.knightId);
      return Boolean(info?.genuine && info.owner === wallet);
    }
    return ch.wallet === wallet;
  }

  /** Construct a fresh challenge (not yet saved). */
  private build(a: {
    tier: TierId;
    stage: Stage;
    knight?: string;
    wallet?: string;
    knightId?: string;
    reviveOf?: string;
    scars?: number;
    id?: string;
  }): Challenge {
    const spec = TIERS[a.tier];
    const id = a.id ?? `ch_${randomUUID().slice(0, 8)}`;
    const t = this.now();
    const ch: Challenge = {
      id,
      tier: a.tier,
      stage: a.stage,
      knight: a.knight?.trim() || "Sir Unnamed",
      knightId: a.knightId,
      wallet: a.wallet,
      createdAt: t,
      lifecycle: "active",
      lastActivityAt: t,
      reviveOf: a.reviveOf,
      scars: a.scars ?? 0,
      account: new SimAccount({ id, startingBalance: spec.accountSize }),
      risk: new RiskMonitor({ limits: limitsForTier(a.tier, a.stage), createdAt: t }),
      combatLog: [],
      riskEvents: [],
      books: new Map(),
      fundingRates: new Map(),
      queue: Promise.resolve(),
    };
    ch.combatLog.push({
      ts: t,
      kind: "dawn",
      text: `${ch.knight} rides out with ${spec.accountSize.toLocaleString("en-US")} simulated USDC. Daily limit ${(COMMON_RULES.dailyLossPct * 100).toFixed(0)}%, drawdown ${(COMMON_RULES.maxDrawdownPct * 100).toFixed(0)}% static${a.stage === "evaluation" ? `, boss at +${(COMMON_RULES.profitTargetPct * 100).toFixed(0)}%` : ""}`,
    });
    return ch;
  }

  /** Account caps (rulebook section 20) and the Demo rules (one active per wallet, 1h restart after a breach). */
  private async assertCanOpen(a: { tier: TierId; stage: Stage; wallet?: string }): Promise<void> {
    if (!a.wallet) return; // identity unknown: nothing to aggregate (the HTTP layer always supplies the signed-in wallet)
    const held = await this.store.summaries({ wallet: a.wallet });
    if (a.tier === "demo") {
      const demos = held.filter((h) => h.tier === "demo");
      if (demos.some((d) => d.status === "active")) throw new ServiceError(409, "demo_exists", "One active Demo per wallet");
      const lastBreach = Math.max(0, ...demos.map((d) => d.breachAt ?? 0));
      const opens = demoRestartAt(lastBreach || undefined, this.now());
      if (opens !== undefined) throw new ServiceError(429, "demo_cooldown", "A breached Demo restarts 1 hour after the breach", { availableAt: opens });
      return;
    }
    const cap = checkAccountCaps({ held: held.map(toHeld), stage: a.stage, tier: a.tier });
    if (!cap.ok) {
      throw new ServiceError(403, cap.reason!, `Aggregate ${a.stage} account size would exceed $${cap.cap.toLocaleString("en-US")}`, cap);
    }
  }

  private withCreateLock<T>(wallet: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!wallet) return fn();
    const prev = this.createChains.get(wallet) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.createChains.set(wallet, tail);
    void tail.then(() => {
      if (this.createChains.get(wallet) === tail) this.createChains.delete(wallet);
    });
    return run;
  }

  private async get(id: string): Promise<Challenge> {
    const c = await this.store.get(id);
    if (!c) throw new ServiceError(404, "challenge_not_found");
    return c;
  }

  /** Wallet that owns a challenge (undefined for legacy/anonymous ones). Throws 404 for unknown ids. */
  async ownerOf(id: string): Promise<string | undefined> {
    return (await this.get(id)).wallet;
  }

  private locked<T>(ch: Challenge, fn: () => Promise<T>): Promise<T> {
    const run = ch.queue.then(fn, fn);
    ch.queue = run.catch(() => undefined);
    return run;
  }

  /** Serialise on the challenge, then persist and re-index it whatever happened (a rejected order may still have refreshed marks). */
  private mutate<T>(ch: Challenge, fn: () => Promise<T>): Promise<T> {
    return this.locked(ch, async () => {
      const before = ch.risk.status;
      try {
        return await fn();
      } finally {
        await this.store.save(ch);
        this.reindex(ch);
        // A breach or pass changes the knight (Wounded / level up) and releases the transfer lock.
        if (ch.risk.status !== before) await this.syncKnightSafe(ch.knightId);
      }
    });
  }

  // ------------------------------------------------------------ worker index

  private reindex(ch: Challenge): void {
    for (const sym of this.symbolsOf.get(ch.id) ?? []) this.bySymbol.get(sym)?.delete(ch.id);
    this.symbolsOf.delete(ch.id);
    const live = ch.risk.status === "active" && ch.lifecycle !== TERMINAL_LIFECYCLE;
    if (!live) {
      this.liveIds.delete(ch.id);
      return;
    }
    this.liveIds.add(ch.id);
    const syms = new Set<string>([...ch.account.positions.keys(), ...ch.account.openOrders().map((o) => o.symbol)]);
    this.symbolsOf.set(ch.id, syms);
    for (const sym of syms) {
      let set = this.bySymbol.get(sym);
      if (!set) this.bySymbol.set(sym, (set = new Set()));
      set.add(ch.id);
    }
  }

  /** Load every live (active, not archived) challenge from the store and index it. Call once at startup. */
  async warm(): Promise<number> {
    const live = await this.store.summaries({ status: "active" });
    let n = 0;
    for (const s of live) {
      if (s.lifecycle === TERMINAL_LIFECYCLE) continue;
      const ch = await this.store.get(s.id);
      if (ch) {
        this.reindex(ch);
        n++;
      }
    }
    return n;
  }

  /** Symbols with at least one live position or resting order: what a market feed needs to watch. */
  activeSymbols(): string[] {
    return [...this.bySymbol.entries()].filter(([, ids]) => ids.size > 0).map(([sym]) => sym);
  }

  /** Ids of live challenges (active and not archived). */
  liveChallengeIds(): string[] {
    return [...this.liveIds];
  }

  /** Stale-feed kill switch: while halted, NEW exposure in the symbol is refused (reduce-only and risk checks continue). */
  setFeedHalted(symbol: string, halted: boolean): void {
    if (halted) this.haltedSymbols.add(symbol);
    else this.haltedSymbols.delete(symbol);
  }

  haltedFeeds(): string[] {
    return [...this.haltedSymbols];
  }

  // ------------------------------------------------------------------- state

  async getState(id: string, opts: { refresh?: boolean } = {}): Promise<ChallengeState> {
    const ch = await this.get(id);
    if (opts.refresh === false) return this.view(ch);
    return this.mutate(ch, async () => {
      await this.refresh(ch);
      return this.view(ch);
    });
  }

  async getCombatLog(id: string, limit = 100): Promise<CombatLogEntry[]> {
    const ch = await this.get(id);
    return ch.combatLog.slice(-limit);
  }

  async list(filter: { wallet?: string } = {}): Promise<ChallengeState[]> {
    return (await this.store.list(filter)).map((c) => this.view(c));
  }

  // -------------------------------------------------------------------- tick

  /** Pull fresh data for every symbol with exposure; accrue funding; fill resting orders; evaluate risk. */
  async tick(id: string): Promise<ChallengeState> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      await this.refresh(ch);
      return this.view(ch);
    });
  }

  private isLive(ch: Challenge): boolean {
    return ch.risk.status === "active" && ch.lifecycle !== TERMINAL_LIFECYCLE;
  }

  private async refresh(ch: Challenge): Promise<Map<string, MarketSnapshot>> {
    const snaps = new Map<string, MarketSnapshot>();
    if (!this.isLive(ch)) return snaps;
    const symbols = new Set<string>([...ch.account.positions.keys(), ...ch.account.openOrders().map((o) => o.symbol)]);
    const results = await Promise.all([...symbols].map((s) => this.market.snapshot(s).then((x) => [s, x] as const)));
    const t = this.now();
    ch.dataSource = results[0]?.[1].source ?? ch.dataSource;
    const newFills: Fill[] = [];
    for (const [sym, snap] of results) {
      snaps.set(sym, snap);
      newFills.push(...this.applySnapshot(ch, snap, t));
    }
    this.logFills(ch, newFills);
    this.evaluateRisk(ch, t);
    return snaps;
  }

  /** Ingest one snapshot: marks, funding accrual, resting-order fills (leverage re-checked at fill time). */
  private applySnapshot(ch: Challenge, snap: MarketSnapshot, t: number): Fill[] {
    this.ingest(ch, snap);
    this.engine.accrueFunding(ch.account, snap.symbol, snap.markPrice, snap.fundingRateHourly, t);
    return this.engine.onBook(ch.account, snap.book, t, this.fillGate(ch, t));
  }

  private ingest(ch: Challenge, snap: MarketSnapshot): void {
    ch.books.set(snap.symbol, snap.book);
    ch.fundingRates.set(snap.symbol, snap.fundingRateHourly);
    ch.account.setMark(snap.symbol, snap.markPrice);
    ch.dataSource = snap.source;
  }

  /**
   * Leverage re-check when a RESTING limit order fills (rulebook section 12). At placement the order was within the
   * cap, but equity and other positions move while it rests. A fill that would push required margin above equity is
   * trimmed to the largest size that fits; the unfilled rest is cancelled with reason `leverage_cap_exceeded`.
   * Reduce-only orders always fill.
   */
  private fillGate(ch: Challenge, t: number): RestingFillGate {
    return (order, size, price) => {
      if (order.reduceOnly) return { size };
      const mark = ch.account.markOf(order.symbol);
      if (mark === undefined) return { size };
      const positions = this.legs(ch);
      const equity = ch.account.equity();
      const sign = order.side === "buy" ? 1 : -1;
      // The fill happens at the limit price, not the mark, and pays a fee: equity right after the fill is lower than now.
      const equityAfter = (s: number) => equity - sign * (price - mark) * s - s * price * this.engine.fees.makerFeeRate;
      const fits = (s: number) =>
        checkOrderLeverage({ equity: equityAfter(s), positions, order: { symbol: order.symbol, side: order.side, size: s, markPrice: mark } });
      const full = fits(size);
      if (full.allowed) return { size };
      let allowed = 0;
      if (full.reason !== "market_not_whitelisted") {
        let lo = 0;
        let hi = size;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid).allowed) lo = mid;
          else hi = mid;
        }
        allowed = lo * (1 - 1e-9);
      }
      ch.combatLog.push({
        ts: t,
        kind: "warning",
        text: `${ch.knight}'s resting ${order.side} for ${size} ${order.symbol} is ${allowed > 0 ? `trimmed to ${Number(allowed.toPrecision(6))}` : "cancelled"}: leverage cap`,
      });
      return { size: allowed, reason: full.reason ?? "leverage_cap_exceeded" };
    };
  }

  private legs(ch: Challenge) {
    return [...ch.account.positions.values()].map((p) => ({
      symbol: p.symbol,
      size: p.size,
      markPrice: ch.account.markOf(p.symbol) ?? p.entryPrice,
    }));
  }

  private logFills(ch: Challenge, fills: Fill[]): CombatLogEntry[] {
    const out: CombatLogEntry[] = [];
    const ctx = { knight: ch.knight, startingBalance: ch.account.startingBalance };
    out.push(...fillsToCombat(ctx, fills));
    ch.combatLog.push(...out);
    if (fills.length && this.onFills) {
      try {
        const positions: Record<string, number> = {};
        for (const f of fills) positions[f.symbol] = ch.account.positionSize(f.symbol);
        this.onFills({ challengeId: ch.id, stage: ch.stage, demo: ch.tier === "demo", wallet: ch.wallet, status: ch.risk.status, fills, positions });
      } catch {
        /* the routing hook must never break a simulated fill */
      }
    }
    return out;
  }

  /**
   * Evaluate rules; on a breach, flatten the book. A pass needs every Path to Funded rule (closed-balance target, flat
   * book, minimum trading days, best-day rule), so there is nothing to close on a pass. Returns the events produced.
   */
  private evaluateRisk(ch: Challenge, t: number): { events: RiskEvent[]; combat: CombatLogEntry[] } {
    const flat = ch.account.positions.size === 0;
    let gatesMet = true;
    if (ch.stage === "evaluation" && flat && ch.risk.status === "active") {
      const p = this.progressOf(ch);
      gatesMet = p.daysMet && p.bestDay.ok;
    }
    const events = ch.risk.evaluate({ balance: ch.account.balance, equity: ch.account.equity(), now: t, flat, gatesMet });
    const ctx = { knight: ch.knight, startingBalance: ch.account.startingBalance };
    const combat: CombatLogEntry[] = [];
    for (const e of events) combat.push(riskEventToCombat(ctx, e));
    ch.combatLog.push(...combat);
    ch.riskEvents.push(...events);
    if (events.some((e) => e.type === "breach")) ch.breachAt = t;
    if (events.some((e) => e.type === "pass")) {
      combat.push({ ts: t, kind: "dawn", text: `${ch.knight} may now claim a funded account: verify identity, then a risk review of about one business day` });
      ch.combatLog.push(combat[combat.length - 1]!);
    }
    if (events.some((e) => e.type === "breach")) {
      const forced = this.engine.closeAll(ch.account, ch.books, t);
      combat.push(...this.logFills(ch, forced));
      ch.risk.syncFinal(ch.account.balance, ch.account.equity(), t);
    }
    return { events, combat };
  }

  // --------------------------------------------------------- streaming path

  /**
   * Streaming entry point (the risk worker calls this for every price/book update). Applies the snapshot to every
   * live challenge with exposure in that symbol, WITHOUT any API call: marks, funding, resting-order fills with the
   * fill-time leverage check, then the full risk evaluation (breach closes the book at the snapshot's book).
   */
  async onMarketUpdate(snap: MarketSnapshot): Promise<MarketUpdateResult[]> {
    const ids = [...(this.bySymbol.get(snap.symbol) ?? [])];
    const out: MarketUpdateResult[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const ch = await this.store.get(id);
        if (!ch) return;
        await this.mutate(ch, async () => {
          if (!this.isLive(ch)) return;
          // A snapshot older than the book we already hold (out-of-order delivery) must not roll marks backwards.
          const held = ch.books.get(snap.symbol);
          if (held && snap.book.ts < held.ts) return;
          const t = this.now();
          const fills = this.applySnapshot(ch, snap, t);
          this.logFills(ch, fills);
          const risk = this.evaluateRisk(ch, t);
          out.push({ challengeId: id, events: risk.events, fills, status: ch.risk.status });
        });
      }),
    );
    return out;
  }

  // ------------------------------------------------------------------ orders

  async placeOrder(id: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const ch = await this.get(id);
    return this.mutate(ch, () => this.placeOrderInner(ch, input));
  }

  private reject(ch: Challenge, reason: string, events: RiskEvent[] = [], combat: CombatLogEntry[] = []): PlaceOrderResult {
    return { accepted: false, reason, fills: [], events, combat, state: this.view(ch) };
  }

  private async placeOrderInner(ch: Challenge, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (ch.lifecycle === "archived") throw new ServiceError(409, "account_archived", "Archived accounts cannot trade");
    if (ch.risk.status !== "active") throw new ServiceError(409, "challenge_not_active", `challenge is ${ch.risk.status}`);
    const symbol = normalizeSymbol(input.symbol);
    const reduceOnly = input.reduceOnly ?? false;

    // Refresh everything first so equity / margin use current marks, and so day rollover and funding apply.
    const snaps = await this.refresh(ch);
    if (ch.risk.status !== "active") {
      throw new ServiceError(409, "challenge_not_active", `challenge became ${ch.risk.status} before the order`);
    }

    // Any order attempt is activity; a Dormant account wakes for free (rulebook section 18).
    ch.lastActivityAt = this.now();
    if (ch.lifecycle === "dormant") this.wake(ch, ch.lastActivityAt);

    const holdsPosition = ch.account.positionSize(symbol) !== 0;
    if (!isWhitelisted(symbol) && !(reduceOnly && holdsPosition)) return this.reject(ch, "market_not_whitelisted");

    const snap = snaps.get(symbol) ?? (await this.market.snapshot(symbol));
    this.ingest(ch, snap);
    const t = this.now();

    if (!reduceOnly) {
      if (this.haltedSymbols.has(symbol)) return this.reject(ch, "feed_halted");
      if (Date.now() - snap.fetchedAt > CIRCUIT_BREAKER.staleFeedMs) return this.reject(ch, "stale_feed");
      if (!snap.tradable) return this.reject(ch, `market_closed:${snap.tradableReason ?? "unknown"}`);
      const bid = snap.book.bids[0]?.[0];
      const ask = snap.book.asks[0]?.[0];
      if (bid === undefined || ask === undefined) return this.reject(ch, "no_liquidity");
      const mid = (bid + ask) / 2;
      const spreadBps = ((ask - bid) / mid) * 10_000;
      if (spreadBps > CIRCUIT_BREAKER.maxSpreadBps) return this.reject(ch, "circuit_breaker:spread");
      const depth = depthWithin(input.side === "buy" ? snap.book.asks : snap.book.bids, mid, input.side);
      if (depth < CIRCUIT_BREAKER.minSideDepthUsd) return this.reject(ch, "circuit_breaker:depth");
    }

    const lev = checkOrderLeverage({
      equity: ch.account.equity(),
      positions: this.legs(ch),
      order: { symbol, side: input.side, size: input.size, markPrice: snap.markPrice, reduceOnly },
    });
    if (!lev.allowed) return this.reject(ch, lev.reason ?? "leverage_cap_exceeded");

    const req: OrderRequest = {
      symbol,
      side: input.side,
      size: input.size,
      type: input.type,
      limitPrice: input.limitPrice,
      reduceOnly,
      postOnly: input.postOnly,
    };
    const res = this.engine.submit(ch.account, req, snap.book, t);
    if (res.order.status === "rejected") return this.reject(ch, res.order.rejectReason ?? "rejected");

    const combat = this.logFills(ch, res.fills);
    const risk = this.evaluateRisk(ch, t);
    return {
      accepted: true,
      order: res.order,
      fills: res.fills,
      avgPrice: res.avgPrice,
      slippageBps: res.slippageBps,
      events: risk.events,
      combat: [...combat, ...risk.combat],
      state: this.view(ch),
    };
  }

  async cancelOrder(id: string, orderId: string): Promise<Order> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      const o = ch.account.orders.get(orderId);
      if (!o) throw new ServiceError(404, "order_not_found");
      return this.engine.cancel(ch.account, orderId, this.now())!;
    });
  }

  // --------------------------------------------------------------- lifecycle

  private wake(ch: Challenge, t: number): void {
    ch.lifecycle = "active";
    ch.dormantSince = undefined;
    ch.lastActivityAt = t;
    ch.combatLog.push({ ts: t, kind: "dawn", text: `${ch.knight} wakes from dormancy` });
  }

  /** Free reactivation of a Dormant funded account (rulebook section 18). Archived accounts cannot be reactivated here. */
  async reactivate(id: string): Promise<ChallengeState> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      if (ch.lifecycle === "archived") throw new ServiceError(409, "account_archived", "Archived accounts cannot trade");
      if (ch.lifecycle === "active") return this.view(ch);
      this.wake(ch, this.now());
      return this.view(ch);
    });
  }

  /** Record a payout request as activity (the payout flow itself is roadmap M8). */
  async recordPayoutRequest(id: string): Promise<ChallengeState> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      ch.lastActivityAt = this.now();
      if (ch.lifecycle === "dormant") this.wake(ch, ch.lastActivityAt);
      return this.view(ch);
    });
  }

  /**
   * Apply the funded-account inactivity rules to every live funded account: Dormant after 90 days with no order or
   * payout request, archived 365 days later. Dormant accounts keep their equity limits (a breach is still a breach);
   * archiving flattens the book at the last known books because archived accounts do not trade.
   * Returns what changed.
   */
  async sweepLifecycle(now: number = this.now()): Promise<{ id: string; from: Lifecycle; to: Lifecycle; at: number }[]> {
    const funded = (await this.store.summaries({ status: "active" })).filter((s) => s.stage === "funded" && s.lifecycle !== TERMINAL_LIFECYCLE);
    const changes: { id: string; from: Lifecycle; to: Lifecycle; at: number }[] = [];
    for (const s of funded) {
      const ch = await this.store.get(s.id);
      if (!ch) continue;
      await this.mutate(ch, async () => {
        for (let i = 0; i < 2; i++) {
          const n = nextLifecycle({
            stage: ch.stage,
            tier: ch.tier,
            status: ch.risk.status,
            lifecycle: ch.lifecycle,
            lastActivityAt: ch.lastActivityAt,
            dormantSince: ch.dormantSince,
            now,
          });
          if (n.lifecycle === ch.lifecycle) break;
          const from = ch.lifecycle;
          const at = n.at ?? now;
          ch.lifecycle = n.lifecycle;
          if (n.lifecycle === "dormant") {
            ch.dormantSince = at;
            ch.combatLog.push({ ts: at, kind: "dawn", text: `${ch.knight} falls dormant after ${DORMANCY.dormantAfterDays} idle days` });
          } else {
            ch.archivedAt = at;
            const forced = this.engine.closeAll(ch.account, ch.books, at);
            this.logFills(ch, forced);
            ch.risk.syncFinal(ch.account.balance, ch.account.equity(), at);
            ch.combatLog.push({ ts: at, kind: "dawn", text: `${ch.knight} is archived after ${DORMANCY.archiveAfterDays} dormant days` });
          }
          changes.push({ id: ch.id, from, to: n.lifecycle, at });
        }
      });
    }
    return changes;
  }

  // ----------------------------------------------------------------- payouts

  /**
   * Payout quote (rulebook section 11). Funded, non-demo, not breached; archived accounts may still claim profit.
   * There is no identity gate: the payout destination is the authenticated wallet (the signed-in wallet, which for a
   * Privy email login is the embedded Solana wallet). Without a signed-in wallet (open dev mode) it falls back to the
   * knight holder, then the account's wallet.
   */
  async payoutQuote(id: string, actorWallet?: string): Promise<PayoutQuote & { destination?: string; split: number; minUsd: number; autoMaxUsd: number; autoApprove: boolean }> {
    const ch = await this.get(id);
    this.assertPayoutAccount(ch);
    const q = this.quoteFor(ch);
    const holder = this.knights && ch.knightId ? (await this.knights.get(ch.knightId))?.owner : undefined;
    const { split, minUsd, autoMaxUsd } = this.payoutPolicy;
    return { ...q, destination: actorWallet ?? holder ?? ch.wallet, split, minUsd, autoMaxUsd, autoApprove: q.eligible && floorCents(q.traderShare) <= autoMaxUsd };
  }

  private assertPayoutAccount(ch: Challenge): void {
    if (ch.tier === "demo") throw new ServiceError(403, "payouts_unavailable", "Demo accounts have no payouts");
    if (ch.stage !== "funded") throw new ServiceError(403, "payouts_unavailable", "Payouts are only available on funded accounts");
    if (ch.risk.status === "wounded") throw new ServiceError(403, "payouts_unavailable", "Breached accounts have no payouts");
  }

  private quoteFor(ch: Challenge): PayoutQuote {
    const share = this.payoutPolicy.bestDayMaxShare ?? COMMON_RULES.bestDayMaxShare;
    return quotePayout({
      startingBalance: ch.account.startingBalance,
      balance: ch.account.balance,
      hasOpenPositions: ch.account.positions.size > 0,
      split: this.payoutPolicy.split,
      minPayout: this.payoutPolicy.minUsd,
      // Rule 8: the best-day rule over the current payout cycle (since the funded account opened or the last payout).
      bestDay: share < 1 ? fundedProgress({ startingBalance: ch.account.startingBalance, balance: ch.account.balance, openPositions: 0, ledger: this.ledgerOf(ch, this.lastSweepAt(ch)), bestDayMaxShare: share }).bestDay : undefined,
    });
  }

  /** Time of the latest payout sweep that was not reversed: the start of the current payout cycle. */
  private lastSweepAt(ch: Challenge): number | undefined {
    const reversed = new Set(ch.account.adjustments.filter((a) => a.kind === "payout_reversal").map((a) => a.ref));
    let at: number | undefined;
    for (const a of ch.account.adjustments) if (a.kind === "payout_sweep" && !reversed.has(a.ref)) at = Math.max(at ?? 0, a.ts);
    return at;
  }

  // ---------------------------------------------------------- path to funded

  /** Per-UTC-day realized P&L and trading days, from the ledger (fills and funding). */
  private ledgerOf(ch: Challenge, since?: number): DailyLedger {
    return dailyLedger(ch.account.fills, ch.account.fundingPayments, since);
  }

  /** Progress on the four Path to Funded pass requirements (rulebook section 9). */
  private progressOf(ch: Challenge): FundedProgress {
    const l = ch.risk.limits;
    return fundedProgress({
      startingBalance: ch.account.startingBalance,
      balance: ch.account.balance,
      openPositions: ch.account.positions.size,
      ledger: this.ledgerOf(ch),
      profitTargetPct: l.profitTargetPct ?? COMMON_RULES.profitTargetPct,
      minTradingDays: l.minTradingDays,
      bestDayMaxShare: l.bestDayMaxShare,
    });
  }

  private pathView(ch: Challenge): PathToFunded | null {
    if (ch.stage !== "evaluation") return null;
    const p = this.progressOf(ch);
    const c = ch.claim;
    let next: PathToFunded["next"] = "none";
    if (ch.tier === "demo") next = ch.risk.status === "active" ? "trade" : "none";
    else if (ch.risk.status === "active") next = "trade";
    else if (ch.risk.status === "passed") {
      if (!c) next = "claim";
      else if (c.status === "kyc_pending") next = "verify_identity";
      else if (c.status === "under_review") next = "under_review";
      else if (c.status === "approved") next = "funded";
      else next = "rejected";
    }
    // A passed account keeps showing the requirements as met even if the ledger view shifts later.
    const shown = ch.risk.status === "passed" ? { ...p, eligible: true } : p;
    return { ...shown, claim: c, next };
  }

  /**
   * Step 5: the trader claims the funded account on a PASSED evaluation. Then step 6 (KYC) and step 7 (risk review,
   * about one business day). In "auto" modes (dev, tests) those steps pass at once and the funded account opens now.
   * Idempotent: a second claim returns the current state.
   */
  async claimFunded(id: string, opts: { actorWallet?: string } = {}): Promise<ChallengeState> {
    const ch = await this.get(id);
    if (ch.tier === "demo") throw new ServiceError(403, "demo_no_funded", "Demo has no funded stage");
    if (ch.stage !== "evaluation") throw new ServiceError(409, "not_an_evaluation", "Only a passed challenge can be claimed");
    if (ch.risk.status !== "passed") {
      throw new ServiceError(409, "not_eligible", "Meet every Path to Funded requirement first: +10% closed, flat, 3 trading days, best-day rule", { pathToFunded: this.pathView(ch) });
    }
    let holder = ch.wallet;
    if (this.knights && ch.knightId) {
      const k = await this.knights.get(ch.knightId);
      if (!k || !k.genuine) throw new ServiceError(409, "knight_not_genuine", "The knight NFT could not be verified onchain");
      if (opts.actorWallet && k.owner !== opts.actorWallet) throw new ServiceError(403, "not_knight_owner", "Only the wallet holding this knight can claim");
      holder = k.owner;
    }
    // An account funded before Path to Funded existed: record it as an approved claim instead of opening a second one.
    if (!ch.claim) {
      const legacy = (await this.store.summaries(ch.knightId ? { knightId: ch.knightId } : { wallet: ch.wallet })).find(
        (r) => r.stage === "funded" && r.tier === ch.tier && r.createdAt >= ch.createdAt && (ch.knightId ? r.knightId === ch.knightId : true) && r.lifecycle !== "archived" && r.status === "active",
      );
      if (legacy) {
        await this.locked(ch, async () => {
          const t = this.now();
          ch.claim = { status: "approved", kyc: "approved", claimedAt: t, wallet: ch.wallet, kycAt: t, kycBy: "legacy", reviewedAt: t, reviewedBy: "legacy", fundedId: legacy.id };
          await this.store.save(ch);
        });
        return this.view(ch);
      }
    }
    await this.locked(ch, async () => {
      if (ch.claim && ch.claim.status !== "rejected") return;
      if (ch.claim?.status === "rejected") throw new ServiceError(409, "claim_rejected", ch.claim.reason ? `Claim rejected: ${ch.claim.reason}` : "This claim was rejected");
      const t = this.now();
      const kyc: KycStatus = this.kycMode === "auto" ? "approved" : "pending";
      ch.claim = { status: kyc === "approved" ? "under_review" : "kyc_pending", kyc, claimedAt: t, wallet: opts.actorWallet ?? holder, ...(kyc === "approved" ? { kycAt: t, kycBy: "auto" } : {}) };
      ch.combatLog.push({ ts: t, kind: "dawn", text: `${ch.knight} claims a funded account: ${kyc === "approved" ? "risk review started" : "verify identity next"}` });
      await this.store.save(ch);
    });
    if (ch.claim?.status === "under_review" && this.fundedReview === "auto") await this.reviewClaim(id, { decision: "approve", actor: "auto" });
    return this.view((await this.store.get(id))!);
  }

  /** Step 6 (ops / KYC vendor webhook later): record the identity check result. TODO: Sumsub (or similar) integration. */
  async setClaimKyc(id: string, a: { decision: "approve" | "reject"; actor?: string; reason?: string }): Promise<ChallengeState> {
    const ch = await this.get(id);
    await this.locked(ch, async () => {
      const c = ch.claim;
      if (!c) throw new ServiceError(404, "claim_not_found", "No funded claim on this challenge");
      if (c.status !== "kyc_pending") throw new ServiceError(409, "claim_not_kyc_pending", `Claim is ${c.status}`);
      const t = this.now();
      c.kyc = a.decision === "approve" ? "approved" : "rejected";
      c.kycAt = t;
      c.kycBy = a.actor ?? "admin";
      if (a.decision === "approve") c.status = "under_review";
      else {
        c.status = "rejected";
        c.reason = a.reason ?? "identity check failed";
      }
      ch.combatLog.push({ ts: t, kind: "dawn", text: a.decision === "approve" ? `${ch.knight}'s identity is verified: risk review started` : `${ch.knight}'s identity check failed` });
      await this.store.save(ch);
    });
    if (ch.claim?.status === "under_review" && this.fundedReview === "auto") return this.reviewClaim(id, { decision: "approve", actor: "auto" });
    return this.view(ch);
  }

  /**
   * Step 7: risk review decision. Approve opens the funded account on the same knight at the same starting balance
   * (status under_review -> approved, the funded account is live). Checks done by ops: cross-account or external
   * hedging, collusion, feed or latency exploits, account sharing, all-in lottery cycling.
   */
  async reviewClaim(id: string, a: { decision: "approve" | "reject"; actor?: string; reason?: string }): Promise<ChallengeState> {
    const ch = await this.get(id);
    const c = ch.claim;
    if (!c) throw new ServiceError(404, "claim_not_found", "No funded claim on this challenge");
    if (c.status === "approved") return this.view(ch);
    if (c.status !== "under_review") throw new ServiceError(409, "claim_not_under_review", `Claim is ${c.status}`);
    if (c.kyc !== "approved") throw new ServiceError(409, "kyc_not_approved", "Identity check must be approved first");
    const t = this.now();
    if (a.decision === "reject") {
      await this.locked(ch, async () => {
        c.status = "rejected";
        c.reviewedAt = t;
        c.reviewedBy = a.actor ?? "admin";
        c.reason = a.reason ?? "risk review";
        ch.combatLog.push({ ts: t, kind: "dawn", text: `${ch.knight}'s funded claim is rejected after risk review` });
        await this.store.save(ch);
      });
      return this.view(ch);
    }
    const funded = await this.create(
      { tier: ch.tier, stage: "funded", wallet: c.wallet ?? ch.wallet, knight: ch.knight, knightAsset: ch.knightId },
      { claimApproved: true },
    );
    await this.locked(ch, async () => {
      c.status = "approved";
      c.reviewedAt = t;
      c.reviewedBy = a.actor ?? "admin";
      c.fundedId = funded.id;
      ch.combatLog.push({ ts: t, kind: "dawn", text: `${ch.knight}'s funded account is live: ${usd(funded.account.startingBalance)}, 80% profit split` });
      await this.store.save(ch);
    });
    return this.view(ch);
  }

  /** Ops queue: claims, optionally by status. */
  async listClaims(status?: FundedClaim["status"]): Promise<{ challengeId: string; tier: TierId; knight: string; knightId?: string; wallet?: string; claim: FundedClaim; pathToFunded: PathToFunded | null }[]> {
    const rows = (await this.store.summaries({ status: "passed" })).filter((r) => r.stage === "evaluation" && r.tier !== "demo");
    const out = [];
    for (const r of rows) {
      const ch = await this.store.get(r.id);
      if (!ch?.claim || (status && ch.claim.status !== status)) continue;
      out.push({ challengeId: ch.id, tier: ch.tier, knight: ch.knight, knightId: ch.knightId, wallet: ch.wallet, claim: ch.claim, pathToFunded: this.pathView(ch) });
    }
    return out.sort((x, y) => x.claim.claimedAt - y.claim.claimedAt);
  }

  /**
   * Reserve a payout (M8), atomically with the challenge lock held:
   *   1. refresh marks and run the risk rules (rolls the day, so the sweep below can never read as a daily loss),
   *   2. re-check eligibility on the fresh numbers (funded, not breached, flat book, profit above the minimum),
   *   3. `hooks.create` persists the payout record (it returns the existing one for an idempotent replay),
   *   4. sweep the profit out of the balance (a ledger adjustment, rulebook section 11: the balance resets to the
   *      starting balance), rebase the daily-loss baseline, save,
   *   5. `hooks.debited` marks the payout as debited.
   * A crash between 3 and 5 leaves a payout whose sweep is not applied; `payoutFinalizeDebit` finishes it.
   */
  async payoutReserve<T extends { id: string; replayed?: boolean }>(
    id: string,
    actorWallet: string | undefined,
    hooks: {
      create(q: PayoutQuote & { destination: string; sweepUsd: number }): Promise<T>;
      debited(created: T): Promise<T>;
    },
  ): Promise<T> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      this.assertPayoutAccount(ch);
      await this.refresh(ch);
      this.assertPayoutAccount(ch); // the refresh may just have breached it
      const q = this.quoteFor(ch);
      if (!q.eligible) {
        throw new ServiceError(409, "payout_not_eligible", payoutReasonText(q.reason, this.payoutPolicy), { reason: q.reason, quote: q });
      }
      const holder = this.knights && ch.knightId ? (await this.knights.get(ch.knightId))?.owner : undefined;
      if (this.knights && ch.knightId && actorWallet && holder !== actorWallet) throw new ServiceError(403, "not_knight_owner", "Only the wallet holding this knight can request a payout");
      const destination = actorWallet ?? holder ?? ch.wallet;
      if (!destination) throw new ServiceError(400, "no_destination", "No wallet to pay: sign in first");
      const created = await hooks.create({ ...q, destination, sweepUsd: q.grossProfit });
      if (created.replayed) return created;
      const t = this.now();
      this.applySweep(ch, created.id, q.grossProfit, t);
      ch.lastActivityAt = t;
      if (ch.lifecycle === "dormant") this.wake(ch, t);
      await this.store.save(ch);
      return hooks.debited(created);
    });
  }

  private applySweep(ch: Challenge, payoutId: string, sweepUsd: number, t: number): boolean {
    const applied = ch.account.applyAdjustment({ id: `payout_sweep:${payoutId}`, kind: "payout_sweep", amount: -sweepUsd, ref: payoutId, ts: t });
    if (!applied) return false;
    ch.risk.rebaseAfterPayout(ch.account.balance, ch.account.equity(), t);
    ch.combatLog.push({ ts: t, kind: "tribute", text: `${ch.knight} pays tribute: ${usd(sweepUsd)} of profit swept, balance back to ${usd(ch.account.startingBalance)}` });
    return true;
  }

  /**
   * Finish the sweep of a payout whose record exists but whose debit was never confirmed (a crash in the window
   * above). Idempotent. `impossible` means the profit is no longer there (the account traded in between), so the
   * payout cannot be honoured and the caller rejects it; nothing was swept so nothing is reversed.
   */
  async payoutFinalizeDebit(id: string, payoutId: string, sweepUsd: number): Promise<"applied" | "already" | "impossible"> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      if (ch.account.hasAdjustment(`payout_sweep:${payoutId}`)) return "already";
      await this.refresh(ch);
      const profit = ch.account.balance - ch.account.startingBalance;
      if (ch.risk.status === "wounded" || ch.account.positions.size > 0 || profit < sweepUsd - 1e-6) return "impossible";
      this.applySweep(ch, payoutId, sweepUsd, this.now());
      return "applied";
    });
  }

  /** Give a rejected payout's profit back (a positive ledger adjustment). Idempotent; a no-op when nothing was swept. */
  async payoutReverse(id: string, payoutId: string, sweepUsd: number): Promise<boolean> {
    const ch = await this.get(id);
    return this.mutate(ch, async () => {
      if (!ch.account.hasAdjustment(`payout_sweep:${payoutId}`)) return false;
      const t = this.now();
      const applied = ch.account.applyAdjustment({ id: `payout_reversal:${payoutId}`, kind: "payout_reversal", amount: sweepUsd, ref: payoutId, ts: t });
      if (!applied) return false;
      ch.risk.syncFinal(ch.account.balance, ch.account.equity(), t);
      ch.combatLog.push({ ts: t, kind: "tribute", text: `${ch.knight}'s payout is declined: ${usd(sweepUsd)} returns to the balance` });
      return true;
    });
  }

  /** Put a line in the account's combat log (payout paid, and so on). */
  async payoutNote(id: string, text: string): Promise<void> {
    const ch = await this.get(id);
    await this.mutate(ch, async () => {
      ch.combatLog.push({ ts: this.now(), kind: "tribute", text });
    });
  }

  // ------------------------------------------------------------------ revive

  /** Can this wounded challenge be revived right now, and for how much? (Does not charge or change anything.) */
  async reviveInfo(id: string): Promise<ReviveInfo> {
    const ch = await this.get(id);
    return this.reviveCheck(ch);
  }

  private async reviveCheck(ch: Challenge): Promise<ReviveInfo> {
    const used = ch.knightId ? (await this.store.summaries({ knightId: ch.knightId })).filter((s) => s.reviveOf !== undefined).length : 0;
    const check = checkRevive({
      tier: ch.tier,
      status: ch.risk.status,
      alreadyRevived: ch.revivedBy !== undefined,
      revivesUsed: used,
      breachAt: ch.breachAt,
      now: this.now(),
    });
    return { ...check, challengeId: ch.id, knightId: ch.knightId, tier: ch.tier };
  }

  /**
   * Revive a Wounded knight (rulebook section 17): 20% off the same tier, max 3 per knight, 24h after the breach.
   * Starts a NEW challenge (fresh balance and limits, evaluation stage, new id) for the same knight; the breached
   * account is not restored. Payment goes through the stubbed PaymentProvider. With an idempotency key a retry
   * returns the original result instead of charging twice.
   */
  async revive(
    id: string,
    opts: {
      idempotencyKey?: string;
      /** Signed-in wallet making the request. With a knight chain it must hold the knight now (rights follow the knight). */
      actorWallet?: string;
      /** A verified USDC payment from the PurchaseService: skips the PaymentProvider. */
      prepaid?: { orderId: string; ref: string; amountUsd: number };
    } = {},
  ): Promise<ReviveResult> {
    const old = await this.get(id);
    if (opts.prepaid) {
      // Deterministic id per order: a retry returns the account the first call opened.
      const existing = await this.store.get(reviveChallengeId(opts.prepaid.orderId));
      if (existing) return { replayed: true, feeUsd: existing.reviveFeeUsd ?? 0, paymentRef: existing.paymentRef ?? "", state: this.view(existing), revive: await this.reviveCheck(old) };
    }
    if (opts.idempotencyKey) {
      const prior = await this.store.findReviveRequest(opts.idempotencyKey);
      if (prior) {
        if (prior.sourceChallengeId !== id) throw new ServiceError(409, "idempotency_key_reused", "Idempotency key was used for a different challenge");
        const fresh = await this.get(prior.newChallengeId);
        return { replayed: true, feeUsd: fresh.reviveFeeUsd ?? 0, paymentRef: fresh.paymentRef ?? "", state: this.view(fresh), revive: await this.reviveCheck(old) };
      }
    }
    return this.withCreateLock(old.wallet, () =>
      this.locked(old, async () => {
        const info = await this.reviveCheck(old);
        if (!info.eligible) {
          const status = info.reason === "revive_cooldown" ? 429 : info.reason === "demo_no_revive" ? 403 : 409;
          throw new ServiceError(status, info.reason!, `Revive unavailable: ${info.reason}`, info);
        }
        // Whoever holds the knight onchain NOW owns the revive and the new account (a Wounded knight may have been sold).
        let owner = old.wallet;
        if (this.knights && old.knightId) {
          const k = await this.knights.get(old.knightId);
          if (!k || !k.genuine) throw new ServiceError(409, "knight_not_genuine", "The knight NFT could not be verified onchain");
          if (opts.actorWallet && k.owner !== opts.actorWallet) throw new ServiceError(403, "not_knight_owner", "The signed-in wallet does not hold this knight");
          owner = k.owner;
        }
        // Reviving closes the wounded account out of the caps, so check the cap for the replacement.
        await this.assertCanOpen({ tier: old.tier, stage: "evaluation", wallet: owner });
        let receipt: { ok: boolean; ref?: string; error?: string };
        if (opts.prepaid) {
          if (Math.abs(opts.prepaid.amountUsd - info.fee) > 0.005) throw new ServiceError(409, "price_changed", `Revive price is now $${info.fee.toFixed(2)}`, { fee: info.fee });
          receipt = { ok: true, ref: opts.prepaid.ref };
        } else {
          receipt = await this.payments.charge({
            wallet: owner ?? "anonymous",
            amountUsd: info.fee,
            kind: "revive",
            reference: old.id,
            idempotencyKey: opts.idempotencyKey,
          });
        }
        if (!receipt.ok) {
          if (receipt.error === "payment_required") throw new ServiceError(402, "payment_required", "Revive is paid in USDC: POST /purchases/revive, pay, then confirm", { quote: "/purchases/revive" });
          throw new ServiceError(402, "payment_failed", receipt.error ?? "payment failed");
        }

        const fresh = this.build({
          tier: old.tier,
          stage: "evaluation",
          knight: old.knight,
          wallet: owner,
          knightId: old.knightId,
          reviveOf: old.id,
          scars: old.scars + 1,
          id: opts.prepaid ? reviveChallengeId(opts.prepaid.orderId) : undefined,
        });
        fresh.reviveFeeUsd = info.fee;
        fresh.paymentRef = receipt.ref;
        fresh.combatLog.push({
          ts: fresh.createdAt,
          kind: "dawn",
          text: `${fresh.knight} is revived (scar ${fresh.scars}, ${REVIVE_RULES.maxPerKnight - (info.revivesUsed + 1)} revives left) for $${info.fee.toFixed(2)}`,
        });
        // Transfer-lock the knight (and write revives + 1, status Active) before the new account exists.
        if (this.knights && fresh.knightId && owner) await this.lockKnight(fresh, owner);
        old.revivedBy = fresh.id;
        await this.store.save(fresh);
        await this.store.save(old);
        if (opts.idempotencyKey && owner) {
          await this.store.saveReviveRequest({ idempotencyKey: opts.idempotencyKey, wallet: owner, sourceChallengeId: old.id, newChallengeId: fresh.id, createdAt: this.now() });
        }
        this.reindex(fresh);
        this.reindex(old);
        await this.syncKnightSafe(fresh.knightId);
        return { replayed: false, feeUsd: info.fee, paymentRef: receipt.ref ?? "", state: this.view(fresh), revive: await this.reviveCheck(old) };
      }),
    );
  }

  // -------------------------------------------------------------------- view

  private view(ch: Challenge): ChallengeState {
    const a = ch.account;
    const equity = a.equity();
    const gross = a.grossNotional();
    const snapNow = this.now();
    // Keep the risk snapshot consistent with the ledger even between evaluations.
    const risk = ch.risk.snapshot(snapNow);
    return {
      id: ch.id,
      simulated: true,
      tier: ch.tier,
      stage: ch.stage,
      knight: ch.knight,
      knightId: ch.knightId,
      demo: ch.tier === "demo",
      wallet: ch.wallet,
      status: ch.risk.status,
      lifecycle: ch.lifecycle,
      lastActivityAt: ch.lastActivityAt,
      dormantSince: ch.dormantSince,
      archivedAt: ch.archivedAt,
      payoutsEnabled: TIERS[ch.tier].payouts && ch.stage === "funded" && ch.risk.status !== "wounded",
      pathToFunded: this.pathView(ch),
      reviveOf: ch.reviveOf,
      revivedBy: ch.revivedBy,
      scars: ch.scars,
      createdAt: ch.createdAt,
      dataSource: ch.dataSource,
      account: {
        startingBalance: a.startingBalance,
        balance: a.balance,
        equity,
        unrealizedPnl: a.unrealizedPnl(),
        realizedPnl: a.realizedPnl,
        paidOut: a.payoutsSwept(),
        feesPaid: a.feesPaid,
        fundingPaid: a.fundingPaid,
        grossNotional: gross,
        requiredMargin: requiredMargin(this.legs(ch)),
        effectiveLeverage: gross / Math.max(equity, 1e-9),
      },
      risk,
      positions: [...a.positions.values()].map((p) => {
        const mark = a.markOf(p.symbol) ?? p.entryPrice;
        return {
          symbol: p.symbol,
          side: p.size > 0 ? ("long" as const) : ("short" as const),
          size: Math.abs(p.size),
          entryPrice: p.entryPrice,
          markPrice: mark,
          notional: Math.abs(p.size) * mark,
          unrealizedPnl: (mark - p.entryPrice) * p.size,
          leverageCap: leverageCap(p.symbol),
        };
      }),
      openOrders: a.openOrders(),
      recentFills: a.fills.slice(-20),
      combatLog: ch.combatLog.slice(-20),
    };
  }
}

const toHeld = (s: ChallengeSummary): HeldAccount => ({ tier: s.tier, stage: s.stage, size: s.size, status: s.status, lifecycle: s.lifecycle });
