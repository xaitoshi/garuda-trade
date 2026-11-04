import type { ChallengeService, MarketUpdateResult } from "@garuda/api";
import type { MarketFeed, MarketSnapshot } from "@garuda/market-data";

export interface RiskWorkerOptions {
  service: ChallengeService;
  feed: MarketFeed;
  now?: () => number;
  /** A watched symbol with no update for this long gets its feed halted (new exposure refused). Default 10s, the circuit-breaker stale limit. */
  staleAfterMs?: number;
  /** How often to look for stale feeds. Default 1s. */
  staleCheckMs?: number;
  /** How often to run the dormancy/archive sweep. Default 1h. */
  lifecycleEveryMs?: number;
  /** Latency samples kept for percentiles. Default 2000. */
  latencyWindow?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  onError?: (err: unknown, ctx: string) => void;
  /** Called after each processed update that produced risk events (breach, fill, warning). */
  onResults?: (snap: MarketSnapshot, results: MarketUpdateResult[]) => void;
}

export interface LatencyStats {
  samples: number;
  p50: number;
  p99: number;
  max: number;
}

export interface WorkerMetrics {
  running: boolean;
  feed: string;
  updates: number;
  /** Updates where the handler threw. */
  errors: number;
  /** Challenges that moved to a breached/failed state because of a streamed update. */
  breachesCaught: number;
  /** Resting orders filled by a streamed update. */
  restingFills: number;
  /** ms from the snapshot being assembled (fetchedAt) to the risk evaluation being persisted. */
  latencyMs: LatencyStats;
  haltedSymbols: string[];
  watchedSymbols: string[];
  /** ms since the last update, per watched symbol (undefined = never seen yet). */
  ageMs: Record<string, number | undefined>;
  lifecycleSweeps: number;
  liveChallenges: number;
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
};

/**
 * Streaming risk worker. Subscribes (via a MarketFeed) to every symbol that has a live position or resting order,
 * and applies each update straight to the affected challenges: marks, funding, resting-order fills with the
 * fill-time leverage re-check, and the full risk evaluation. So a breach is caught when the price moves, not when
 * the trader or the UI next calls the API.
 *
 * Safety nets: a stale-feed kill switch (no update for staleAfterMs halts new exposure in that symbol until data
 * returns), and a periodic dormancy/archive sweep for funded accounts.
 */
export class RiskWorker {
  private readonly svc: ChallengeService;
  private readonly feed: MarketFeed;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly staleCheckMs: number;
  private readonly lifecycleEveryMs: number;
  private readonly window: number;
  private readonly timers: NonNullable<RiskWorkerOptions["timers"]>;
  private readonly onError: (err: unknown, ctx: string) => void;
  private readonly onResults?: RiskWorkerOptions["onResults"];

  private running = false;
  private handles: unknown[] = [];
  private lastSeen = new Map<string, number>();
  private watchedSince = new Map<string, number>();
  private latencies: number[] = [];
  private updates = 0;
  private errors = 0;
  private breaches = 0;
  private restingFills = 0;
  private sweeps = 0;

  constructor(o: RiskWorkerOptions) {
    this.svc = o.service;
    this.feed = o.feed;
    this.now = o.now ?? Date.now;
    this.staleAfterMs = o.staleAfterMs ?? 10_000;
    this.staleCheckMs = o.staleCheckMs ?? 1000;
    this.lifecycleEveryMs = o.lifecycleEveryMs ?? 3_600_000;
    this.window = o.latencyWindow ?? 2000;
    this.timers = o.timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
    this.onError = o.onError ?? (() => {});
    this.onResults = o.onResults;
  }

  /** Load live challenges, start the feed and the timers. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.svc.warm();
    await this.svc.sweepLifecycle().then(() => this.sweeps++).catch((e) => this.onError(e, "lifecycle"));
    await this.feed.start({
      symbols: () => this.watched(),
      onSnapshot: async (snap) => {
        await this.handle(snap);
      },
      onError: (symbol, err) => this.onError(err, `feed:${symbol}`),
    });
    this.handles.push(this.timers.set(() => this.checkStale(), this.staleCheckMs));
    this.handles.push(this.timers.set(() => void this.sweepLifecycle(), this.lifecycleEveryMs));
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const h of this.handles) this.timers.clear(h);
    this.handles = [];
    await this.feed.stop();
  }

  /** Symbols to subscribe to; also starts the staleness clock for newly watched ones. */
  watched(): string[] {
    const t = this.now();
    const syms = this.svc.activeSymbols();
    const live = new Set(syms);
    for (const s of syms) if (!this.watchedSince.has(s)) this.watchedSince.set(s, t);
    for (const s of [...this.watchedSince.keys()]) {
      if (!live.has(s)) {
        // No exposure left: forget it, and lift any halt so it cannot linger.
        this.watchedSince.delete(s);
        this.lastSeen.delete(s);
        if (this.svc.haltedFeeds().includes(s)) this.svc.setFeedHalted(s, false);
      }
    }
    return syms;
  }

  /** Process one snapshot. Never throws: an error here must not kill the stream. */
  async handle(snap: MarketSnapshot): Promise<MarketUpdateResult[]> {
    this.lastSeen.set(snap.symbol, this.now());
    if (this.svc.haltedFeeds().includes(snap.symbol)) this.svc.setFeedHalted(snap.symbol, false);
    try {
      const results = await this.svc.onMarketUpdate(snap);
      this.updates++;
      this.record(this.now() - snap.fetchedAt);
      for (const r of results) {
        if (r.status === "wounded") this.breaches++;
        this.restingFills += r.fills.length;
      }
      if (results.some((r) => r.events.length > 0 || r.fills.length > 0)) this.onResults?.(snap, results);
      return results;
    } catch (err) {
      this.errors++;
      this.onError(err, `update:${snap.symbol}`);
      return [];
    }
  }

  /** Halt new exposure in any watched symbol whose data has gone quiet. Public so tests (and ops) can force a check. */
  checkStale(): string[] {
    const t = this.now();
    const halted: string[] = [];
    for (const s of this.watched()) {
      const since = this.lastSeen.get(s) ?? this.watchedSince.get(s) ?? t;
      if (t - since > this.staleAfterMs) {
        if (!this.svc.haltedFeeds().includes(s)) this.svc.setFeedHalted(s, true);
        halted.push(s);
      }
    }
    return halted;
  }

  async sweepLifecycle(): Promise<{ id: string; from: string; to: string; at: number }[]> {
    try {
      const changes = await this.svc.sweepLifecycle(this.now());
      this.sweeps++;
      return changes;
    } catch (err) {
      this.onError(err, "lifecycle");
      return [];
    }
  }

  private record(ms: number): void {
    this.latencies.push(Math.max(0, ms));
    if (this.latencies.length > this.window) this.latencies.shift();
  }

  metrics(): WorkerMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const t = this.now();
    const watched = this.svc.activeSymbols();
    return {
      running: this.running,
      feed: this.feed.name,
      updates: this.updates,
      errors: this.errors,
      breachesCaught: this.breaches,
      restingFills: this.restingFills,
      latencyMs: { samples: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] ?? 0 },
      haltedSymbols: this.svc.haltedFeeds(),
      watchedSymbols: watched,
      ageMs: Object.fromEntries(watched.map((s) => [s, this.lastSeen.has(s) ? t - this.lastSeen.get(s)! : undefined])),
      lifecycleSweeps: this.sweeps,
      liveChallenges: this.svc.liveChallengeIds().length,
    };
  }
}
