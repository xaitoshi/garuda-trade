import { randomUUID } from "node:crypto";
import type { MarketDataProvider, MarketSnapshot } from "@garuda/market-data";
import {
  CIRCUIT_BREAKER,
  COMMON_RULES,
  TIERS,
  checkOrderLeverage,
  fillsToCombat,
  isWhitelisted,
  leverageCap,
  limitsForTier,
  normalizeSymbol,
  requiredMargin,
  riskEventToCombat,
  RiskMonitor,
  type CombatLogEntry,
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
} from "@garuda/sim-engine";

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

export interface Challenge {
  id: string;
  tier: TierId;
  stage: Stage;
  knight: string;
  wallet?: string;
  createdAt: number;
  account: SimAccount;
  risk: RiskMonitor;
  combatLog: CombatLogEntry[];
  riskEvents: RiskEvent[];
  books: Map<string, L2Book>;
  fundingRates: Map<string, number>;
  dataSource?: string;
  /** Serialises operations on one challenge. */
  queue: Promise<unknown>;
}

/** Persistence seam. Phase 1 is in-memory; swap for SQLite/Postgres without touching the service. */
export interface ChallengeStore {
  get(id: string): Challenge | undefined;
  put(c: Challenge): void;
  list(): Challenge[];
}

export class InMemoryChallengeStore implements ChallengeStore {
  private m = new Map<string, Challenge>();
  get(id: string) {
    return this.m.get(id);
  }
  put(c: Challenge) {
    this.m.set(c.id, c);
  }
  list() {
    return [...this.m.values()];
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
  wallet?: string;
  status: RiskSnapshot["status"];
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

const depthWithin = (levels: readonly (readonly [number, number])[], mid: number, side: "buy" | "sell") => {
  const band = CIRCUIT_BREAKER.depthBandPct;
  let usd = 0;
  for (const [p, s] of levels) {
    if (side === "buy" ? p > mid * (1 + band) : p < mid * (1 - band)) break;
    usd += p * s;
  }
  return usd;
};

export class ChallengeService {
  readonly market: MarketDataProvider;
  readonly store: ChallengeStore;
  readonly engine: SimEngine;
  private readonly now: () => number;
  private readonly enforceGating: boolean;

  constructor(deps: ServiceDeps) {
    this.market = deps.market;
    this.store = deps.store ?? new InMemoryChallengeStore();
    this.engine = new SimEngine(deps.engine);
    this.now = deps.now ?? Date.now;
    this.enforceGating = deps.enforceGating ?? true;
  }

  // ------------------------------------------------------------------ create

  create(input: CreateChallengeInput): ChallengeState {
    const spec = TIERS[input.tier];
    if (!spec) throw new ServiceError(400, "unknown_tier");
    if (this.enforceGating && spec.requires && !(input.nftLevels ?? []).includes(spec.requires)) {
      throw new ServiceError(403, "tier_locked", `${spec.name} requires a ${TIERS[spec.requires].name}-level knight NFT`);
    }
    const stage = input.stage ?? "evaluation";
    const id = `ch_${randomUUID().slice(0, 8)}`;
    const t = this.now();
    const limits = limitsForTier(input.tier, stage);
    const ch: Challenge = {
      id,
      tier: input.tier,
      stage,
      knight: input.knight?.trim() || "Sir Unnamed",
      wallet: input.wallet,
      createdAt: t,
      account: new SimAccount({ id, startingBalance: spec.accountSize }),
      risk: new RiskMonitor({ limits, createdAt: t }),
      combatLog: [],
      riskEvents: [],
      books: new Map(),
      fundingRates: new Map(),
      queue: Promise.resolve(),
    };
    ch.combatLog.push({
      ts: t,
      kind: "dawn",
      text: `${ch.knight} rides out with ${spec.accountSize.toLocaleString("en-US")} simulated USDC. Daily limit ${(COMMON_RULES.dailyLossPct * 100).toFixed(0)}%, drawdown ${(COMMON_RULES.maxDrawdownPct * 100).toFixed(0)}% static${stage === "evaluation" ? `, boss at +${(COMMON_RULES.profitTargetPct * 100).toFixed(0)}%` : ""}`,
    });
    this.store.put(ch);
    return this.view(ch);
  }

  private get(id: string): Challenge {
    const c = this.store.get(id);
    if (!c) throw new ServiceError(404, "challenge_not_found");
    return c;
  }

  private locked<T>(ch: Challenge, fn: () => Promise<T>): Promise<T> {
    const run = ch.queue.then(fn, fn);
    ch.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------------- state

  async getState(id: string, opts: { refresh?: boolean } = {}): Promise<ChallengeState> {
    const ch = this.get(id);
    if (opts.refresh === false) return this.view(ch);
    return this.locked(ch, async () => {
      await this.refresh(ch);
      return this.view(ch);
    });
  }

  getCombatLog(id: string, limit = 100): CombatLogEntry[] {
    const ch = this.get(id);
    return ch.combatLog.slice(-limit);
  }

  list(): ChallengeState[] {
    return this.store.list().map((c) => this.view(c));
  }

  // -------------------------------------------------------------------- tick

  /** Pull fresh data for every symbol with exposure; accrue funding; fill resting orders; evaluate risk. */
  async tick(id: string): Promise<ChallengeState> {
    const ch = this.get(id);
    return this.locked(ch, async () => {
      await this.refresh(ch);
      return this.view(ch);
    });
  }

  private async refresh(ch: Challenge): Promise<Map<string, MarketSnapshot>> {
    const snaps = new Map<string, MarketSnapshot>();
    if (ch.risk.status !== "active") return snaps;
    const symbols = new Set<string>([...ch.account.positions.keys(), ...ch.account.openOrders().map((o) => o.symbol)]);
    const results = await Promise.all([...symbols].map((s) => this.market.snapshot(s).then((x) => [s, x] as const)));
    const t = this.now();
    ch.dataSource = results[0]?.[1].source ?? ch.dataSource;
    const newFills: Fill[] = [];
    for (const [sym, snap] of results) {
      snaps.set(sym, snap);
      this.ingest(ch, snap);
      this.engine.accrueFunding(ch.account, sym, snap.markPrice, snap.fundingRateHourly, t);
      newFills.push(...this.engine.onBook(ch.account, snap.book, t));
    }
    this.logFills(ch, newFills);
    this.evaluateRisk(ch, t);
    return snaps;
  }

  private ingest(ch: Challenge, snap: MarketSnapshot): void {
    ch.books.set(snap.symbol, snap.book);
    ch.fundingRates.set(snap.symbol, snap.fundingRateHourly);
    ch.account.setMark(snap.symbol, snap.markPrice);
    ch.dataSource = snap.source;
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
    if (events.some((e) => e.type === "breach" || e.type === "pass")) {
      const forced = this.engine.closeAll(ch.account, ch.books, t);
      combat.push(...this.logFills(ch, forced));
      ch.risk.syncFinal(ch.account.balance, ch.account.equity(), t);
    }
    return { events, combat };
  }

  // ------------------------------------------------------------------ orders

  async placeOrder(id: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const ch = this.get(id);
    return this.locked(ch, () => this.placeOrderInner(ch, input));
  }

  private reject(ch: Challenge, reason: string, events: RiskEvent[] = [], combat: CombatLogEntry[] = []): PlaceOrderResult {
    return { accepted: false, reason, fills: [], events, combat, state: this.view(ch) };
  }

  private async placeOrderInner(ch: Challenge, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (ch.risk.status !== "active") throw new ServiceError(409, "challenge_not_active", `challenge is ${ch.risk.status}`);
    const symbol = normalizeSymbol(input.symbol);
    const reduceOnly = input.reduceOnly ?? false;

    // Refresh everything first so equity / margin use current marks, and so day rollover and funding apply.
    const snaps = await this.refresh(ch);
    if (ch.risk.status !== "active") {
      throw new ServiceError(409, "challenge_not_active", `challenge became ${ch.risk.status} before the order`);
    }

    const holdsPosition = ch.account.positionSize(symbol) !== 0;
    if (!isWhitelisted(symbol) && !(reduceOnly && holdsPosition)) return this.reject(ch, "market_not_whitelisted");

    const snap = snaps.get(symbol) ?? (await this.market.snapshot(symbol));
    this.ingest(ch, snap);
    const t = this.now();

    if (!reduceOnly) {
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

    const legs = [...ch.account.positions.values()].map((p) => ({
      symbol: p.symbol,
      size: p.size,
      markPrice: ch.account.markOf(p.symbol) ?? p.entryPrice,
    }));
    const lev = checkOrderLeverage({
      equity: ch.account.equity(),
      positions: legs,
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
    const ch = this.get(id);
    return this.locked(ch, async () => {
      const o = ch.account.orders.get(orderId);
      if (!o) throw new ServiceError(404, "order_not_found");
      return this.engine.cancel(ch.account, orderId, this.now())!;
    });
  }

  // -------------------------------------------------------------------- view

  private view(ch: Challenge): ChallengeState {
    const a = ch.account;
    const legs = [...a.positions.values()].map((p) => ({ symbol: p.symbol, size: p.size, markPrice: a.markOf(p.symbol) ?? p.entryPrice }));
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
      wallet: ch.wallet,
      status: ch.risk.status,
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
        requiredMargin: requiredMargin(legs),
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
