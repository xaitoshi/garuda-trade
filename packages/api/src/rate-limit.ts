export interface Limit {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until the current window ends (the Retry-After when blocked). */
  resetMs: number;
}

/**
 * Fixed-window counter per key. In-process only: with several API replicas each has its own counters, so the
 * effective limit is multiplied by the replica count (a shared Redis counter is the planned upgrade).
 */
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  private lastPrune = 0;

  constructor(
    private readonly cfg: Limit,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateDecision {
    const t = this.now();
    this.prune(t);
    const { limit, windowMs } = this.cfg;
    let b = this.buckets.get(key);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, count: 0 };
      this.buckets.set(key, b);
    }
    const resetMs = Math.max(0, b.start + windowMs - t);
    if (b.count >= limit) return { allowed: false, limit, remaining: 0, resetMs };
    b.count += 1;
    return { allowed: true, limit, remaining: limit - b.count, resetMs };
  }

  private prune(t: number): void {
    if (t - this.lastPrune < this.cfg.windowMs) return;
    this.lastPrune = t;
    for (const [k, b] of this.buckets) if (t - b.start >= this.cfg.windowMs) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

export interface RateLimitConfig {
  /** Every request, by client IP. */
  ip: Limit;
  /** Authenticated requests, by wallet (so rotating IPs does not lift a wallet's limit). */
  wallet: Limit;
  /** /auth/* by IP: nonce and verify attempts are the brute-force surface. */
  auth: Limit;
  /** POST /challenges/:id/orders by wallet. */
  orders: Limit;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  ip: { limit: 300, windowMs: 60_000 },
  wallet: { limit: 120, windowMs: 60_000 },
  auth: { limit: 20, windowMs: 60_000 },
  orders: { limit: 30, windowMs: 10_000 },
};
