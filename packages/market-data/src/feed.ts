import type { MarketDataProvider, MarketSnapshot } from "./types.js";

export type SnapshotHandler = (snap: MarketSnapshot) => void | Promise<void>;

export interface FeedStartOptions {
  /** Called on every cycle for the symbols to watch (only symbols with exposure need data). */
  symbols: () => string[];
  onSnapshot: SnapshotHandler;
  onError?: (symbol: string, err: unknown) => void;
}

export interface FeedHealth {
  running: boolean;
  /** Successful snapshots delivered. */
  delivered: number;
  /** Failed fetches. */
  errors: number;
  lastError?: string;
  /** ms epoch of the last delivered snapshot per symbol. */
  lastSeen: Record<string, number>;
}

/**
 * Where market updates come from. The risk worker only needs "call me with a snapshot whenever a watched symbol
 * moves". Today that is a poller over any MarketDataProvider; a Rise websocket subscription is a drop-in
 * replacement that implements the same interface.
 */
export interface MarketFeed {
  readonly name: string;
  start(opts: FeedStartOptions): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): FeedHealth;
}

export interface PollingFeedOptions {
  provider: MarketDataProvider;
  /** Poll period. The worst-case detection delay for a breach is about this plus the provider latency. */
  intervalMs?: number;
  now?: () => number;
  /** Test hook: replace setInterval/clearInterval. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

/** Polls a provider for every watched symbol on a fixed interval, in parallel across symbols. */
export class PollingFeed implements MarketFeed {
  readonly name: string;
  private readonly provider: MarketDataProvider;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: NonNullable<PollingFeedOptions["timers"]>;
  private opts?: FeedStartOptions;
  private handle: unknown;
  private busy = false;
  private delivered = 0;
  private errors = 0;
  private lastError?: string;
  private lastSeen = new Map<string, number>();

  constructor(o: PollingFeedOptions) {
    this.provider = o.provider;
    this.name = `poll:${o.provider.name}`;
    this.intervalMs = o.intervalMs ?? 1000;
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  }

  start(opts: FeedStartOptions): void {
    this.opts = opts;
    this.handle = this.timers.set(() => void this.pollOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
    this.opts = undefined;
  }

  /** One polling cycle. Overlapping cycles are skipped (a slow provider never piles up requests). */
  async pollOnce(): Promise<void> {
    const opts = this.opts;
    if (!opts || this.busy) return;
    this.busy = true;
    try {
      await Promise.all(
        opts.symbols().map(async (symbol) => {
          try {
            const snap = await this.provider.snapshot(symbol);
            this.lastSeen.set(symbol, this.now());
            this.delivered++;
            await opts.onSnapshot(snap);
          } catch (err) {
            this.errors++;
            this.lastError = err instanceof Error ? err.message : String(err);
            opts.onError?.(symbol, err);
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  health(): FeedHealth {
    return { running: this.handle !== undefined, delivered: this.delivered, errors: this.errors, lastError: this.lastError, lastSeen: Object.fromEntries(this.lastSeen) };
  }
}

/** Push-style feed for tests, scripted replays, and as the base for a websocket adapter: call `push` per update. */
export class ManualFeed implements MarketFeed {
  readonly name = "manual";
  private opts?: FeedStartOptions;
  private delivered = 0;
  private lastSeen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  start(opts: FeedStartOptions): void {
    this.opts = opts;
  }
  stop(): void {
    this.opts = undefined;
  }
  /** Deliver one snapshot; resolves when the consumer has fully processed it. No-op when not started. */
  async push(snap: MarketSnapshot): Promise<void> {
    if (!this.opts) return;
    this.delivered++;
    this.lastSeen.set(snap.symbol, this.now());
    await this.opts.onSnapshot(snap);
  }
  /** Symbols the consumer currently wants. */
  watched(): string[] {
    return this.opts?.symbols() ?? [];
  }
  health(): FeedHealth {
    return { running: this.opts !== undefined, delivered: this.delivered, errors: 0, lastSeen: Object.fromEntries(this.lastSeen) };
  }
}
