import { randomUUID } from "node:crypto";
import type { MarketDataProvider, MarketSnapshot } from "@garuda/market-data";
import {
  CIRCUIT_BREAKER,
  COMMON_RULES,
  DORMANCY,
  REVIVE_RULES,
  TIERS,
  checkAccountCaps,
  checkOrderLeverage,
  checkRevive,
  demoRestartAt,
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
  type CombatLogEntry,
  type HeldAccount,
  type Lifecycle,
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
import { InMemoryChallengeStore, type Challenge, type ChallengeStore, type ChallengeSummary } from "./store.js";

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
}

export interface CreateChallengeInput {
  tier: TierId;
  stage?: Stage;
  knight?: string;
  wallet?: string;
  /** Knight NFT levels held by the wallet. TRUSTED INPUT until on-chain Metaplex verification exists. */
  nftLevels?: TierId[];
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

export class ChallengeService {
  readonly market: MarketDataProvider;
  readonly store: ChallengeStore;
  readonly engine: SimEngine;
  readonly payments: PaymentProvider;
  private readonly now: () => number;
  private readonly enforceGating: boolean;
  private readonly requireWalletForDemo: boolean;
  /** symbol -> ids of live challenges holding a position or resting order in it (the worker's routing table). */
  private bySymbol = new Map<string, Set<string>>();
  private symbolsOf = new Map<string, Set<string>>();
  private liveIds = new Set<string>();
  private haltedSymbols = new Set<string>();
  private createChains = new Map<string, Promise<unknown>>();

  constructor(deps: ServiceDeps) {
    this.market = deps.market;
    this.store = deps.store ?? new InMemoryChallengeStore();
    this.engine = new SimEngine(deps.engine);
    this.payments = deps.payments ?? new StubPaymentProvider();
    this.now = deps.now ?? Date.now;
    this.enforceGating = deps.enforceGating ?? true;
    this.requireWalletForDemo = deps.requireWalletForDemo ?? false;
  }

  // ------------------------------------------------------------------ create

  async create(input: CreateChallengeInput): Promise<ChallengeState> {
    const spec = TIERS[input.tier];
    if (!spec) throw new ServiceError(400, "unknown_tier");
    const stage = input.stage ?? "evaluation";
    const isDemo = input.tier === "demo";
    if (isDemo && stage !== "evaluation") throw new ServiceError(400, "demo_evaluation_only", "Demo has no funded stage");
    if (isDemo && this.requireWalletForDemo && !input.wallet) throw new ServiceError(400, "wallet_required", "Demo needs a signed-in wallet");
    // Demo carries no NFT, so it never has a gating credit and nftLevels are ignored for it.
    if (!isDemo && this.enforceGating && spec.requires && !(input.nftLevels ?? []).includes(spec.requires)) {
      throw new ServiceError(403, "tier_locked", `${spec.name} requires a ${TIERS[spec.requires].name}-level knight NFT`);
    }
    return this.withCreateLock(input.wallet, async () => {
      await this.assertCanOpen({ tier: input.tier, stage, wallet: input.wallet });
      const ch = this.build({ tier: input.tier, stage, knight: input.knight, wallet: input.wallet, knightId: isDemo ? undefined : `kn_${randomUUID().slice(0, 8)}` });
      await this.store.save(ch);
      this.reindex(ch);
      return this.view(ch);
    });
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
  }): Challenge {
    const spec = TIERS[a.tier];
    const id = `ch_${randomUUID().slice(0, 8)}`;
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
      try {
        return await fn();
      } finally {
        await this.store.save(ch);
        this.reindex(ch);
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
    return (order, size) => {
      if (order.reduceOnly) return { size };
      const mark = ch.account.markOf(order.symbol);
      if (mark === undefined) return { size };
      const positions = this.legs(ch);
      const equity = ch.account.equity();
      const chk = checkOrderLeverage({ equity, positions, order: { symbol: order.symbol, side: order.side, size, markPrice: mark } });
      if (chk.allowed) return { size };
      const max = chk.reason === "market_not_whitelisted" ? 0 : maxOrderSize({ equity, positions, symbol: order.symbol, side: order.side, markPrice: mark });
      const allowed = Math.max(0, Math.min(size, max * (1 - 1e-9)));
      ch.combatLog.push({
        ts: t,
        kind: "warning",
        text: `${ch.knight}'s resting ${order.side} for ${size} ${order.symbol} is ${allowed > 0 ? `trimmed to ${Number(allowed.toPrecision(6))}` : "cancelled"}: leverage cap`,
      });
      return { size: allowed, reason: chk.reason ?? "leverage_cap_exceeded" };
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
    return out;
  }

  /** Evaluate rules; on breach or pass, flatten the book. Returns the events produced. */
  private evaluateRisk(ch: Challenge, t: number): { events: RiskEvent[]; combat: CombatLogEntry[] } {
    const events = ch.risk.evaluate({ balance: ch.account.balance, equity: ch.account.equity(), now: t });
    const ctx = { knight: ch.knight, startingBalance: ch.account.startingBalance };
    const combat: CombatLogEntry[] = [];
    for (const e of events) combat.push(riskEventToCombat(ctx, e));
    ch.combatLog.push(...combat);
    ch.riskEvents.push(...events);
    if (events.some((e) => e.type === "breach")) ch.breachAt = t;
    if (events.some((e) => e.type === "breach" || e.type === "pass")) {
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

  /** Payout quote (rulebook section 11). Funded, non-demo, not breached; archived accounts may still claim profit. KYC is roadmap M7. */
  async payoutQuote(id: string): Promise<PayoutQuote & { kycRequired: true }> {
    const ch = await this.get(id);
    if (ch.tier === "demo") throw new ServiceError(403, "payouts_unavailable", "Demo accounts have no payouts");
    if (ch.stage !== "funded") throw new ServiceError(403, "payouts_unavailable", "Payouts are only available on funded accounts");
    if (ch.risk.status === "wounded") throw new ServiceError(403, "payouts_unavailable", "Breached accounts have no payouts");
    const q = quotePayout({ startingBalance: ch.account.startingBalance, balance: ch.account.balance, hasOpenPositions: ch.account.positions.size > 0 });
    return { ...q, kycRequired: true };
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
  async revive(id: string, opts: { idempotencyKey?: string } = {}): Promise<ReviveResult> {
    const old = await this.get(id);
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
        // Reviving closes the wounded account out of the caps, so check the cap for the replacement.
        await this.assertCanOpen({ tier: old.tier, stage: "evaluation", wallet: old.wallet });
        const receipt = await this.payments.charge({
          wallet: old.wallet ?? "anonymous",
          amountUsd: info.fee,
          kind: "revive",
          reference: old.id,
          idempotencyKey: opts.idempotencyKey,
        });
        if (!receipt.ok) throw new ServiceError(402, "payment_failed", receipt.error ?? "payment failed");

        const fresh = this.build({ tier: old.tier, stage: "evaluation", knight: old.knight, wallet: old.wallet, knightId: old.knightId, reviveOf: old.id, scars: old.scars + 1 });
        fresh.reviveFeeUsd = info.fee;
        fresh.paymentRef = receipt.ref;
        fresh.combatLog.push({
          ts: fresh.createdAt,
          kind: "dawn",
          text: `${fresh.knight} is revived (scar ${fresh.scars}, ${REVIVE_RULES.maxPerKnight - (info.revivesUsed + 1)} revives left) for $${info.fee.toFixed(2)}`,
        });
        old.revivedBy = fresh.id;
        await this.store.save(fresh);
        await this.store.save(old);
        if (opts.idempotencyKey && old.wallet) {
          await this.store.saveReviveRequest({ idempotencyKey: opts.idempotencyKey, wallet: old.wallet, sourceChallengeId: old.id, newChallengeId: fresh.id, createdAt: this.now() });
        }
        this.reindex(fresh);
        this.reindex(old);
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
