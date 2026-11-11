import { randomUUID } from "node:crypto";
import { resolveMode, type RoutingConfig } from "./config.js";
import type { RoutingStore } from "./store.js";
import type {
  FillEvent,
  PhoenixTradingClient,
  RouteAction,
  RoutedPosition,
  RoutingMode,
  RoutingOrderRecord,
  RoutingTrader,
  TraderBook,
} from "./types.js";

type Mode = Exclude<RoutingMode, "disabled">;

export interface RouterDeps {
  config: RoutingConfig;
  store: RoutingStore;
  /** Live Phoenix client. Absent unless PHOENIX_DELEGATE_KEYPAIR and PHOENIX_FIRM_AUTHORITY are set. */
  client?: PhoenixTradingClient;
  /** Current simulated book of a challenge (reconciliation re-derives every target from it). */
  traderBook?: (challengeId: string) => Promise<TraderBook | undefined>;
  /** True when a Flight builder authority is configured (fees on routed orders go to the firm's builder account). */
  builderConfigured?: boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Leg {
  action: Exclude<RouteAction, "skip" | "drift">;
  side: "buy" | "sell";
  size: number;
  reduceOnly: boolean;
}

interface SyncCtx {
  challengeId: string;
  wallet?: string;
  symbol: string;
  target: number;
  price: number;
  triggerFillId?: string;
  reason?: string;
}

export interface DriftRow {
  symbol: string;
  expected: number;
  actual: number;
  diffUsd: number;
}

export interface RoutingStatus {
  mode: RoutingMode;
  reason?: string;
  halted: boolean;
  haltReason?: string;
  dryRun: boolean;
  config: RoutingConfig;
  firmAuthority?: string;
  delegate?: string;
  delegateKeyLoaded: boolean;
  builderConfigured: boolean;
  exposure: { totalNotionalUsd: number; byTrader: Record<string, number>; bySymbol: Record<string, number> };
  dailyPnlUsd: number;
  positions: RoutedPosition[];
  traders: RoutingTrader[];
  stats: { mirrored: number; skipped: number; failed: number };
  lastReconcile?: { at: number; drift: DriftRow[]; error?: string; resynced: number };
}

const EPS = 1e-9;
const sign = (x: number) => (x > EPS ? 1 : x < -EPS ? -1 : 0);

/**
 * Phase 2 A-book router. Mirrors the POSITION of each selected funded account onto the firm's Phoenix account:
 * firm target = trader position x multiplier, then caps. Mirroring positions (not individual fills) means closes,
 * reduces, breach close-outs and missed events all converge on the same target, and reconciliation can re-derive it.
 *
 * Safety: does nothing unless ROUTING_ENABLED=true; DRY_RUN (the default once enabled) only logs; reduce-only legs are
 * always allowed so a halt never strands firm exposure; increases pass the market allowlist, per-trade, per-trader and
 * total notional caps, and the daily loss halt.
 */
export class PhoenixRouter {
  readonly config: RoutingConfig;
  readonly mode: RoutingMode;
  readonly modeReason?: string;
  private readonly store: RoutingStore;
  private readonly client?: PhoenixTradingClient;
  private readonly traderBook?: RouterDeps["traderBook"];
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly builderConfigured: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private marks = new Map<string, number>();
  private halt?: string;
  private timer?: ReturnType<typeof setInterval>;
  private stats = { mirrored: 0, skipped: 0, failed: 0 };
  private lastReconcile?: RoutingStatus["lastReconcile"];

  constructor(deps: RouterDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.client = deps.client;
    this.traderBook = deps.traderBook;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(`[garuda-router] ${m}`));
    this.builderConfigured = deps.builderConfigured ?? false;
    const r = resolveMode(this.config, Boolean(this.client));
    this.mode = r.mode;
    this.modeReason = r.reason;
  }

  private get m(): Mode {
    if (this.mode === "disabled") throw new Error("routing disabled");
    return this.mode;
  }

  /** Load the persisted halt flags. Call once before start(). */
  async init(): Promise<void> {
    if (this.mode === "disabled") return;
    await this.refreshHalt();
  }

  /** For /health: "disabled", "dry_run", "live", or "<mode>:halted". */
  healthLabel(): string {
    if (this.mode === "disabled") return "disabled";
    return this.halt ? `${this.mode}:halted` : this.mode;
  }

  start(): void {
    if (this.mode === "disabled" || this.timer) return;
    this.timer = setInterval(() => void this.reconcile().catch((e) => this.log(`reconcile failed: ${errMsg(e)}`)), this.config.reconcileMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  /** Resolves when every queued routing job has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch((e) => this.log(`job failed: ${errMsg(e)}`));
    return p;
  }

  // ------------------------------------------------------------------ fills

  /**
   * Hook for the challenge service: called synchronously after every batch of simulated fills. Never throws and never
   * blocks the caller; evaluation and demo accounts are ignored outright (only FUNDED accounts can be A-booked).
   */
  onFills(ev: FillEvent): void {
    if (this.mode === "disabled") return;
    if (ev.stage !== "funded" || ev.demo || ev.fills.length === 0) return;
    void this.enqueue(() => this.handle(ev)).catch(() => undefined);
  }

  private async handle(ev: FillEvent): Promise<void> {
    const trader = await this.store.getTrader(ev.challengeId);
    const eligible = Boolean(trader?.enabled) && ev.status === "active";
    const last = new Map<string, FillEvent["fills"][number]>();
    for (const f of ev.fills) last.set(f.symbol, f);
    for (const [symbol, fill] of last) {
      this.marks.set(symbol, fill.price);
      const cur = (await this.store.getPosition(this.m, ev.challengeId, symbol))?.size ?? 0;
      if (!eligible && Math.abs(cur) < EPS) {
        // Per-trade label: this funded trade stays internal (B-book).
        await this.record({
          challengeId: ev.challengeId, wallet: ev.wallet, symbol, side: fill.side, size: fill.size, price: fill.price, book: "B", action: "skip",
          status: "skipped", reason: !trader?.enabled ? "trader_not_selected" : `account_${ev.status}`, triggerFillId: fill.id,
        });
        continue;
      }
      const mult = trader?.multiplier ?? this.config.sizeMultiplier;
      const target = eligible ? (ev.positions[symbol] ?? 0) * mult : 0;
      await this.syncTo({ challengeId: ev.challengeId, wallet: ev.wallet, symbol, target, price: fill.price, triggerFillId: fill.id, reason: eligible ? undefined : `account_${ev.status}` });
    }
    await this.checkDailyLoss();
  }

  // ------------------------------------------------------------------ core

  /** Move the firm's routed position for (challenge, symbol) toward `target` (signed base units). */
  private async syncTo(c: SyncCtx): Promise<void> {
    const mode = this.m;
    const pos = await this.store.getPosition(mode, c.challengeId, c.symbol);
    const cur = pos?.size ?? 0;
    const legs: Leg[] = [];
    let after = cur;
    if (sign(cur) !== 0 && (sign(c.target) === 0 || sign(c.target) !== sign(cur))) {
      legs.push({ action: "close", side: cur > 0 ? "sell" : "buy", size: Math.abs(cur), reduceOnly: true });
      after = 0;
    } else if (sign(cur) !== 0 && Math.abs(c.target) < Math.abs(cur) - EPS) {
      const size = Math.abs(cur) - Math.abs(c.target);
      if (size * c.price >= this.config.minOrderNotionalUsd) {
        legs.push({ action: "reduce", side: cur > 0 ? "sell" : "buy", size, reduceOnly: true });
        after = c.target;
      }
    }
    if (Math.abs(c.target) > Math.abs(after) + EPS) {
      legs.push({ action: sign(after) === 0 ? "open" : "increase", side: c.target > 0 ? "buy" : "sell", size: Math.abs(c.target) - Math.abs(after), reduceOnly: false });
    }
    for (const leg of legs) {
      if (leg.reduceOnly) {
        await this.execute(leg, c);
        continue;
      }
      const gated = await this.gate(leg, c);
      if (gated.size <= EPS) {
        if (leg.size * c.price >= this.config.minOrderNotionalUsd) {
          await this.record({ challengeId: c.challengeId, wallet: c.wallet, symbol: c.symbol, side: leg.side, size: leg.size, price: c.price, book: "B", action: "skip", status: "skipped", reason: gated.reason, triggerFillId: c.triggerFillId });
        }
        continue;
      }
      await this.execute({ ...leg, size: gated.size }, { ...c, reason: gated.reason ?? c.reason });
    }
  }

  /** Caps for an exposure-increasing leg. Returns the allowed size (possibly clipped) or 0 with the reason. */
  private async gate(leg: Leg, c: SyncCtx): Promise<{ size: number; reason?: string }> {
    const cfg = this.config;
    if (this.halt) return { size: 0, reason: `halted:${this.halt}` };
    if (!cfg.markets.includes(c.symbol)) return { size: 0, reason: "market_not_allowed" };
    if (!(c.price > 0)) return { size: 0, reason: "no_price" };
    const positions = await this.store.listPositions(this.m);
    const notional = (p: RoutedPosition) => (p.symbol === c.symbol && p.challengeId === c.challengeId ? 0 : Math.abs(p.size) * (this.marks.get(p.symbol) ?? p.avgPrice));
    const total = positions.reduce((s, p) => s + notional(p), 0);
    const mine = positions.filter((p) => p.challengeId === c.challengeId).reduce((s, p) => s + notional(p), 0);
    // The leg's own existing exposure in this symbol (an increase keeps what is already held).
    const held = Math.abs(positions.find((p) => p.challengeId === c.challengeId && p.symbol === c.symbol)?.size ?? 0) * c.price;
    const limits: [string, number][] = [
      ["cap:per_trade", cfg.maxTradeNotionalUsd],
      ["cap:per_trader", cfg.maxTraderNotionalUsd - mine - held],
      ["cap:total", cfg.maxTotalNotionalUsd - total - held],
    ];
    let usd = leg.size * c.price;
    let reason: string | undefined;
    for (const [name, room] of limits) {
      if (usd > room + EPS) {
        usd = Math.max(0, room);
        reason = name;
      }
    }
    if (usd < cfg.minOrderNotionalUsd) return { size: 0, reason: reason ?? "below_min_notional" };
    return { size: usd / c.price, reason: reason ? `clipped:${reason}` : undefined };
  }

  private async execute(leg: Leg, c: SyncCtx): Promise<boolean> {
    const mode = this.m;
    const slip = this.config.maxSlippageBps / 10_000;
    const limitPrice = leg.side === "buy" ? c.price * (1 + slip) : c.price * (1 - slip);
    const rec = await this.record({
      challengeId: c.challengeId, wallet: c.wallet, symbol: c.symbol, side: leg.side, size: leg.size, price: c.price, limitPrice, book: "A", action: leg.action,
      status: mode === "dry_run" ? "dry_run" : "pending", reason: c.reason, triggerFillId: c.triggerFillId,
    });
    if (mode === "dry_run") {
      this.log(`DRY_RUN ${leg.action} ${leg.side} ${round(leg.size)} ${c.symbol} @<=${round(limitPrice)} for ${c.challengeId}${c.reason ? ` (${c.reason})` : ""}`);
    } else {
      try {
        const { signature } = await this.client!.placeMarketOrder({
          symbol: c.symbol, side: leg.side, size: leg.size, limitPrice, reduceOnly: leg.reduceOnly,
          collateralUsd: leg.reduceOnly ? 0 : (leg.size * c.price) / this.config.isolatedLeverage,
        });
        await this.store.updateOrder(rec.id, { status: "sent", signature, updatedAt: this.now() });
        this.log(`LIVE ${leg.action} ${leg.side} ${round(leg.size)} ${c.symbol} for ${c.challengeId} sig ${signature}`);
      } catch (e) {
        this.stats.failed++;
        await this.store.updateOrder(rec.id, { status: "failed", error: errMsg(e).slice(0, 500), updatedAt: this.now() });
        this.log(`LIVE order FAILED ${leg.side} ${round(leg.size)} ${c.symbol} for ${c.challengeId}: ${errMsg(e)}`);
        return false;
      }
    }
    this.stats.mirrored++;
    await this.applyFill(mode, c.challengeId, c.symbol, leg.side === "buy" ? leg.size : -leg.size, c.price);
    return true;
  }

  private async applyFill(mode: Mode, challengeId: string, symbol: string, delta: number, price: number): Promise<void> {
    const p = (await this.store.getPosition(mode, challengeId, symbol)) ?? { mode, challengeId, symbol, size: 0, avgPrice: price, updatedAt: 0 };
    let realized = 0;
    let size = p.size + delta;
    let avg = p.avgPrice;
    if (sign(p.size) !== 0 && sign(delta) !== sign(p.size)) {
      const closed = Math.min(Math.abs(delta), Math.abs(p.size));
      realized = (price - p.avgPrice) * closed * sign(p.size);
      if (Math.abs(delta) > Math.abs(p.size) + EPS) avg = price; // flipped
    } else {
      avg = sign(p.size) === 0 ? price : (p.avgPrice * Math.abs(p.size) + price * Math.abs(delta)) / (Math.abs(p.size) + Math.abs(delta));
    }
    if (Math.abs(size) < EPS) size = 0;
    await this.store.putPosition({ mode, challengeId, symbol, size, avgPrice: avg, updatedAt: this.now() });
    if (realized !== 0) {
      const key = `pnl:${mode}:${this.day()}`;
      const prev = Number((await this.store.getState(key)) ?? 0);
      await this.store.setState(key, String(prev + realized), this.now());
    }
  }

  private async record(r: {
    challengeId: string; wallet?: string; symbol: string; side?: "buy" | "sell"; size: number; price: number; limitPrice?: number;
    book: "A" | "B"; action: RouteAction; status: RoutingOrderRecord["status"]; reason?: string; triggerFillId?: string;
  }): Promise<RoutingOrderRecord> {
    const t = this.now();
    const rec: RoutingOrderRecord = {
      id: `rt_${randomUUID()}`, ts: t, mode: this.m, challengeId: r.challengeId, wallet: r.wallet, symbol: r.symbol, side: r.side, size: r.size,
      notional: r.size * r.price, refPrice: r.price, limitPrice: r.limitPrice, book: r.book, action: r.action, reason: r.reason, status: r.status,
      triggerFillId: r.triggerFillId, updatedAt: t,
    };
    if (r.status === "skipped") this.stats.skipped++;
    await this.store.insertOrder(rec);
    return rec;
  }

  // ------------------------------------------------------------------ risk

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private async refreshHalt(): Promise<void> {
    if (this.mode === "disabled") return;
    if ((await this.store.getState("halt:admin")) === "1") this.halt = "admin";
    else if ((await this.store.getState(`halt:daily_loss:${this.mode}`)) === this.day()) this.halt = "daily_loss";
    else this.halt = undefined;
  }

  /** Realized today plus unrealized on open routed positions (at the latest marks). */
  async dailyPnl(): Promise<number> {
    if (this.mode === "disabled") return 0;
    const realized = Number((await this.store.getState(`pnl:${this.mode}:${this.day()}`)) ?? 0);
    const unreal = (await this.store.listPositions(this.mode)).reduce((s, p) => s + ((this.marks.get(p.symbol) ?? p.avgPrice) - p.avgPrice) * p.size, 0);
    return realized + unreal;
  }

  private async checkDailyLoss(): Promise<void> {
    await this.refreshHalt();
    if (this.halt) return;
    const pnl = await this.dailyPnl();
    if (pnl <= -this.config.dailyLossLimitUsd) {
      await this.store.setState(`halt:daily_loss:${this.m}`, this.day(), this.now());
      this.halt = "daily_loss";
      this.log(`daily loss limit hit (${round(pnl)} USD): new exposure halted until tomorrow (UTC) or an admin resume`);
    }
  }

  // ------------------------------------------------------------------ admin

  async status(): Promise<RoutingStatus> {
    const positions = this.mode === "disabled" ? [] : (await this.store.listPositions(this.mode)).filter((p) => p.size !== 0);
    const byTrader: Record<string, number> = {};
    const bySymbol: Record<string, number> = {};
    let total = 0;
    for (const p of positions) {
      const usd = Math.abs(p.size) * (this.marks.get(p.symbol) ?? p.avgPrice);
      total += usd;
      byTrader[p.challengeId] = (byTrader[p.challengeId] ?? 0) + usd;
      bySymbol[p.symbol] = (bySymbol[p.symbol] ?? 0) + p.size;
    }
    await this.refreshHalt();
    return {
      mode: this.mode,
      reason: this.modeReason,
      halted: Boolean(this.halt),
      haltReason: this.halt,
      dryRun: this.config.dryRun,
      config: this.config,
      firmAuthority: this.client?.firmAuthority,
      delegate: this.client?.delegate,
      delegateKeyLoaded: Boolean(this.client),
      builderConfigured: this.builderConfigured,
      exposure: { totalNotionalUsd: total, byTrader, bySymbol },
      dailyPnlUsd: await this.dailyPnl(),
      positions,
      traders: await this.store.listTraders(),
      stats: { ...this.stats },
      lastReconcile: this.lastReconcile,
    };
  }

  listOrders(f: { challengeId?: string; limit?: number } = {}): Promise<RoutingOrderRecord[]> {
    return this.store.listOrders(f);
  }

  /**
   * Admin: select (or deselect) a funded account for A-book routing. The caller (HTTP layer) checks that the account is
   * a live, non-demo FUNDED account. Deselecting closes any routed position for that account.
   */
  async setTrader(challengeId: string, a: { enabled: boolean; multiplier?: number; note?: string; wallet?: string }, actor: string): Promise<RoutingTrader> {
    if (a.multiplier !== undefined && !(a.multiplier > 0 && a.multiplier <= 10)) throw new Error("multiplier must be in (0, 10]");
    const prev = await this.store.getTrader(challengeId);
    const t: RoutingTrader = {
      challengeId, wallet: a.wallet ?? prev?.wallet, enabled: a.enabled, multiplier: a.multiplier ?? prev?.multiplier, note: a.note ?? prev?.note,
      updatedAt: this.now(), updatedBy: actor,
    };
    await this.store.putTrader(t);
    if (!a.enabled && this.mode !== "disabled") {
      await this.enqueue(async () => {
        for (const p of (await this.store.listPositions(this.m)).filter((x) => x.challengeId === challengeId && x.size !== 0)) {
          await this.syncTo({ challengeId, wallet: t.wallet, symbol: p.symbol, target: 0, price: this.marks.get(p.symbol) ?? p.avgPrice, reason: "trader_deselected" });
        }
      });
    }
    return t;
  }

  /** Admin kill switch: stop all NEW exposure. Reductions and closes still mirror, so the firm is never stranded. */
  async haltRouting(actor: string): Promise<void> {
    if (this.mode === "disabled") return;
    await this.store.setState("halt:admin", "1", this.now());
    this.halt = "admin";
    this.log(`routing HALTED by ${actor}`);
  }

  /** Admin: clear the admin halt and today's daily-loss halt. Cannot turn routing on when ROUTING_ENABLED is false. */
  async resumeRouting(actor: string): Promise<void> {
    if (this.mode === "disabled") throw new Error(`routing is disabled: ${this.modeReason}`);
    await this.store.setState("halt:admin", "0", this.now());
    await this.store.setState(`halt:daily_loss:${this.mode}`, "", this.now());
    this.halt = undefined;
    this.log(`routing resumed by ${actor}`);
  }

  /** Admin: close every routed position (reduce-only), regardless of halts. */
  async flatten(actor: string): Promise<number> {
    if (this.mode === "disabled") return 0;
    return this.enqueue(async () => {
      let n = 0;
      for (const p of (await this.store.listPositions(this.m)).filter((x) => x.size !== 0)) {
        await this.syncTo({ challengeId: p.challengeId, symbol: p.symbol, target: 0, price: this.marks.get(p.symbol) ?? p.avgPrice, reason: `flatten:${actor}` });
        n++;
      }
      return n;
    });
  }

  /**
   * Reconcile: (1) re-derive every target from the traders' CURRENT simulated books (catches missed fills, deselected or
   * breached accounts), (2) in live mode compare the expected firm book with Phoenix's actual positions and record any
   * drift. Drift is reported, never traded automatically (it may be a manual intervention).
   */
  async reconcile(): Promise<RoutingStatus["lastReconcile"]> {
    if (this.mode === "disabled") return undefined;
    return this.enqueue(async () => {
      const mode = this.m;
      let resynced = 0;
      let error: string | undefined;
      try {
        if (this.traderBook) {
          const positions = await this.store.listPositions(mode);
          const traders = new Map((await this.store.listTraders()).map((t) => [t.challengeId, t]));
          const ids = new Set([...positions.filter((p) => p.size !== 0).map((p) => p.challengeId), ...[...traders.values()].filter((t) => t.enabled).map((t) => t.challengeId)]);
          for (const id of ids) {
            const book = await this.traderBook(id);
            const t = traders.get(id);
            const eligible = Boolean(t?.enabled) && book?.stage === "funded" && !book.demo && book.status === "active";
            const mult = t?.multiplier ?? this.config.sizeMultiplier;
            const symbols = new Set([...positions.filter((p) => p.challengeId === id && p.size !== 0).map((p) => p.symbol), ...(eligible ? Object.keys(book!.positions) : [])]);
            for (const symbol of symbols) {
              const bp = book?.positions[symbol];
              if (bp?.markPrice) this.marks.set(symbol, bp.markPrice);
              const target = eligible ? (bp?.size ?? 0) * mult : 0;
              const cur = positions.find((p) => p.challengeId === id && p.symbol === symbol);
              const price = bp?.markPrice ?? this.marks.get(symbol) ?? cur?.avgPrice ?? 0;
              if (Math.abs(target - (cur?.size ?? 0)) * price < this.config.minOrderNotionalUsd && !(target === 0 && (cur?.size ?? 0) !== 0)) continue;
              await this.syncTo({ challengeId: id, wallet: book?.wallet ?? t?.wallet, symbol, target, price, reason: eligible ? "reconcile" : book ? `reconcile:account_${book.status}` : "reconcile:account_missing" });
              resynced++;
            }
          }
        }
        const drift: DriftRow[] = [];
        if (mode === "live" && this.client) {
          const actual = await this.client.positions();
          const expected: Record<string, number> = {};
          for (const p of await this.store.listPositions(mode)) expected[p.symbol] = (expected[p.symbol] ?? 0) + p.size;
          for (const symbol of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
            const e = expected[symbol] ?? 0;
            const a = actual[symbol] ?? 0;
            const diffUsd = Math.abs(a - e) * (this.marks.get(symbol) ?? 0);
            if (diffUsd > this.config.driftToleranceUsd || (this.marks.get(symbol) === undefined && Math.abs(a - e) > EPS)) {
              drift.push({ symbol, expected: e, actual: a, diffUsd });
              await this.record({ challengeId: "firm", symbol, size: Math.abs(a - e), price: this.marks.get(symbol) ?? 0, book: "A", action: "drift", status: "drift", reason: `expected ${e} actual ${a}` });
              this.log(`DRIFT ${symbol}: expected ${e} actual ${a} on Phoenix`);
            }
          }
        }
        await this.checkDailyLoss();
        this.lastReconcile = { at: this.now(), drift, resynced, error };
      } catch (e) {
        error = errMsg(e);
        this.lastReconcile = { at: this.now(), drift: [], resynced, error };
      }
      return this.lastReconcile;
    });
  }
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
