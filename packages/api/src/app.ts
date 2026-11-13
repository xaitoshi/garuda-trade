import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ACCOUNT_CAPS,
  SCALING_RULES,
  scalingTable,
  CIRCUIT_BREAKER,
  COMMON_RULES,
  LEVERAGE_CAP_BY_CLASS,
  REVIVE_RULES,
  TIERS,
  TIER_IDS,
  type TierId,
  WHITELIST,
  assetClassOf,
  leverageCap,
} from "@garuda/risk-engine";
import { PHOENIX_FEES } from "@garuda/sim-engine";
import { CANDLE_TIMEFRAMES, type CandleTimeframe, type MarketSnapshot } from "@garuda/market-data";
import type { AuthService } from "./auth.js";
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitConfig } from "./rate-limit.js";
import { DEFAULT_ART_DIR, collectionMetadata, isKnightTierName, readArt, tierMetadata } from "@garuda/chain";
import { payoutView, type Payout, type PayoutService, type PayoutStatus } from "./payouts.js";
import type { PurchaseService } from "./purchases.js";
import { ChallengeService, ServiceError } from "./service.js";
import { MediaProxy, TweetLookup } from "./tweets.js";
import { InMemoryUploadStore, registerUploadRoutes, type UploadStore } from "./uploads.js";
import { registerEarlyRoutes, type EarlyAccessService } from "./early.js";

const tierEnum = z.enum(TIER_IDS as [string, ...string[]]);

const createBody = z.object({
  tier: tierEnum,
  stage: z.enum(["evaluation", "funded"]).optional(),
  knight: z.string().min(1).max(40).optional(),
  wallet: z.string().min(1).max(64).optional(),
  nftLevels: z.array(tierEnum).optional(),
  /** Knight NFT address the wallet holds (gated tiers and funded accounts). */
  knightAsset: z.string().min(32).max(44).optional(),
});

const purchaseChallengeBody = z.object({
  tier: tierEnum,
  knightAsset: z.string().min(32).max(44).optional(),
  wallet: z.string().min(1).max(64).optional(),
  /** Cosmetic name for the knight a paid challenge mints. */
  knightName: z.string().trim().min(1).max(24).optional(),
});
const purchaseReviveBody = z.object({ challengeId: z.string().min(1).max(64), wallet: z.string().min(1).max(64).optional() });
const confirmBody = z.object({ signature: z.string().min(64).max(100) });

const orderBody = z
  .object({
    symbol: z.string().min(1).max(20),
    side: z.enum(["buy", "sell"]),
    size: z.number().positive().finite(),
    type: z.enum(["market", "limit"]),
    limitPrice: z.number().positive().finite().optional(),
    reduceOnly: z.boolean().optional(),
    postOnly: z.boolean().optional(),
  })
  .refine((b) => b.type !== "limit" || b.limitPrice !== undefined, { message: "limitPrice is required for limit orders", path: ["limitPrice"] });

const payoutStatusEnum = z.enum(["pending_approval", "approved", "sending", "submitted", "paid", "rejected", "failed"]);
const rejectPayoutBody = z.object({ reason: z.string().trim().min(1).max(500) });
const claimStatusQuery = z.enum(["kyc_pending", "under_review", "approved", "rejected"]).optional();
const kycBody = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(1).max(500).optional() });
const routingTraderBody = z.object({
  enabled: z.boolean(),
  multiplier: z.number().positive().max(10).optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * Phase 2 Phoenix routing (packages/router), as seen by the admin API. Structural, so @garuda/api does not depend on the
 * router package. There is deliberately NO route that turns routing on: ROUTING_ENABLED in the environment is the master
 * switch, and ROUTING_DRY_RUN=false is a second, separate step.
 */
export interface RoutingAdmin {
  healthLabel(): string;
  status(): Promise<unknown>;
  listOrders(f?: { challengeId?: string; limit?: number }): Promise<unknown[]>;
  setTrader(challengeId: string, a: { enabled: boolean; multiplier?: number; note?: string; wallet?: string }, actor: string): Promise<unknown>;
  haltRouting(actor: string): Promise<void>;
  resumeRouting(actor: string): Promise<void>;
  flatten(actor: string): Promise<number>;
  reconcile(): Promise<unknown>;
}

/** The admin token must be long enough to be unguessable: refuse a weak one at startup instead of running with it. */
export const MIN_ADMIN_TOKEN_LENGTH = 24;

const nonceBody = z.object({ wallet: z.string().min(32).max(44) });
const privyBody = z.object({ accessToken: z.string().min(20).max(8192), wallet: z.string().min(32).max(44).optional() });
const verifyBody = z.object({ wallet: z.string().min(32).max(44), nonce: z.string().min(8).max(64), signature: z.string().min(64).max(128) });

export interface AppOptions {
  service: ChallengeService;
  builderCodeConfigured?: boolean;
  logger?: boolean;
  /**
   * Wallet sign-in. When provided, every /challenges route needs `Authorization: Bearer <session token>` and only
   * the owning wallet can read or act on a challenge. When omitted the API is OPEN (tests, local demos).
   */
  auth?: AuthService;
  /** Per-IP, per-wallet, auth and order rate limits. Default DEFAULT_RATE_LIMITS; `false` disables. */
  rateLimits?: RateLimitConfig | false;
  /** Clock for the rate limiter (tests). */
  now?: () => number;
  /** Honour X-Forwarded-For (set when running behind a trusted proxy / load balancer, otherwise IPs are spoofable). */
  trustProxy?: boolean;
  /** Extra fields merged into /health (storage kind, worker state...). */
  health?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** USDC checkout (M4). Enables the /purchases routes. */
  purchases?: PurchaseService;
  /** USDC payouts (M8). Enables the /payouts routes. */
  payouts?: PayoutService;
  /**
   * Bearer token for the /admin routes (approve, reject and retry payouts). Without one the admin routes do not exist
   * (404). At least 24 characters; generate with `openssl rand -hex 32`.
   */
  adminToken?: string;
  /** Where the knight metadata JSON and PNGs are served from (the /nft routes). baseUrl must match what was written onchain. */
  nft?: { baseUrl: string; artDir?: string };
  /** Served at GET /metrics (worker latency, feed health). */
  metrics?: () => unknown;
  /**
   * Browser origins allowed to call the API (CORS), e.g. ["https://app.garuda.example"]; "*" allows any origin
   * (public read-only data and bearer-token auth only, no cookies). Default: none (same-origin or a dev proxy).
   */
  corsOrigins?: string[] | "*";
  /** How long a public /markets/:symbol snapshot is shared between callers. Default 750 ms. */
  marketCacheMs?: number;
  /** Public tweet lookup behind GET /social/tweets/:id (the /calledit page). Default: X's public embed endpoint. */
  tweets?: TweetLookup;
  /** Post photo proxy behind GET /social/media (the /calledit page). Default: fetches pbs.twimg.com. */
  media?: MediaProxy;
  /** /calledit image uploads (POST /social/uploads). Default: in memory. */
  uploads?: UploadStore;
  /** Phase 2 Phoenix order routing. Absent = routing disabled (the /admin/routing routes answer 404). */
  routing?: RoutingAdmin;
  /** Garuda Beta Access (/early). Absent = the /early routes do not exist. */
  early?: EarlyAccessService;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });
  const svc = opts.service;
  const auth = opts.auth;
  const now = opts.now ?? Date.now;
  const rl = opts.rateLimits === false ? undefined : (opts.rateLimits ?? DEFAULT_RATE_LIMITS);
  const limiters = rl && {
    ip: new RateLimiter(rl.ip, now),
    wallet: new RateLimiter(rl.wallet, now),
    auth: new RateLimiter(rl.auth, now),
    orders: new RateLimiter(rl.orders, now),
  };
  const walletOf = new WeakMap<FastifyRequest, string>();
  if (opts.adminToken !== undefined && opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`GARUDA_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }
  const adminDigest = opts.adminToken ? createHash("sha256").update(opts.adminToken).digest() : undefined;

  const limit = (req: FastifyRequest, reply: { header(k: string, v: string | number): unknown }, l: RateLimiter | undefined, key: string, scope: string) => {
    if (!l) return;
    const d = l.check(key);
    reply.header("X-RateLimit-Limit", d.limit);
    reply.header("X-RateLimit-Remaining", d.remaining);
    if (!d.allowed) {
      const retry = Math.max(1, Math.ceil(d.resetMs / 1000));
      reply.header("Retry-After", retry);
      throw new ServiceError(429, "rate_limited", `Too many requests (${scope})`, { scope, retryAfterSeconds: retry });
    }
    void req;
  };

  const corsOk = (origin: string | undefined) => origin !== undefined && (opts.corsOrigins === "*" || (opts.corsOrigins ?? []).includes(origin));
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (corsOk(origin)) {
      reply.header("Access-Control-Allow-Origin", opts.corsOrigins === "*" ? "*" : origin!);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Expose-Headers", "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining");
      if (req.method === "OPTIONS") {
        reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
        reply.header("Access-Control-Max-Age", 600);
        return reply.status(204).send();
      }
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path === "/health" || req.method === "OPTIONS") return;
    limit(req, reply, limiters?.ip, req.ip, "ip");
    if (path.startsWith("/auth/")) limit(req, reply, limiters?.auth, req.ip, "auth");
    if (path.startsWith("/admin/")) limit(req, reply, limiters?.auth, `admin:${req.ip}`, "admin");
  });

  // Admin routes: invisible (404) unless a token is configured; otherwise one constant-time bearer check.
  app.addHook("preHandler", async (req) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/admin/")) return;
    if (!adminDigest) throw new ServiceError(404, "not_found", "Not found");
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const given = createHash("sha256").update(token).digest();
    if (!timingSafeEqual(given, adminDigest)) throw new ServiceError(401, "admin_unauthorized", "Admin token required");
  });

  // Sign-in required on everything that touches an account; /health, /rules, /metrics and /auth/* stay public.
  app.addHook("preHandler", async (req, reply) => {
    if (!auth) return;
    const path = req.url.split("?")[0]!;
    const isAccountRoute = path === "/challenges" || path.startsWith("/challenges/") || path === "/purchases" || path.startsWith("/purchases/") || path === "/payouts" || path.startsWith("/payouts/") || path === "/knights" || path.startsWith("/knights/") || path === "/auth/me" || path === "/auth/logout";
    if (!isAccountRoute) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const session = await auth.authenticate(token);
    if (!session) throw new ServiceError(401, "unauthorized", "Sign in first: Privy (POST /auth/privy) or wallet signature (POST /auth/nonce, then /auth/verify)");
    walletOf.set(req, session.wallet);
    limit(req, reply, limiters?.wallet, session.wallet, "wallet");
  });

  /** Ownership check on every :id route: 403 when the challenge belongs to another wallet. */
  const authorize = async (req: FastifyRequest, id: string, o: { rightsFollowKnight?: boolean } = {}) => {
    if (!auth) return;
    const owner = await svc.ownerOf(id); // 404 for unknown ids
    // Revive of a Wounded knight belongs to whoever holds the knight onchain now (the seller loses it).
    if (o.rightsFollowKnight) {
      if (await svc.canAct(id, walletOf.get(req))) return;
    } else if (owner && owner === walletOf.get(req)) return;
    throw new ServiceError(403, "not_owner", "This challenge belongs to another wallet");
  };

  /** Wallet for a purchase: the signed-in one, or the body's in open mode. */
  const buyer = (req: FastifyRequest, bodyWallet?: string): string => {
    if (auth) {
      const me = walletOf.get(req)!;
      if (bodyWallet && bodyWallet !== me) throw new ServiceError(403, "wallet_mismatch", "wallet does not match the signed-in wallet");
      return me;
    }
    if (!bodyWallet) throw new ServiceError(400, "wallet_required", "wallet is required");
    return bodyWallet;
  };
  const payouts = () => {
    if (!opts.payouts) throw new ServiceError(404, "payouts_disabled", "Payouts are not configured on this server");
    return opts.payouts;
  };
  const purchases = () => {
    if (!opts.purchases) throw new ServiceError(404, "payments_disabled", "USDC checkout is not configured on this server");
    return opts.purchases;
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid_request", issues: err.issues });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: (err as Error).message });
  });

  app.get("/metrics", async () => opts.metrics?.() ?? {});

  app.get("/health", async () => ({
    ...(await opts.health?.()),
    ...(opts.payouts ? { payouts: await opts.payouts.summary().catch(() => undefined) } : {}),
    ok: true,
    authRequired: Boolean(auth),
    privyAuth: Boolean(auth?.privy),
    simulated: true,
    marketData: svc.market.name,
    marketDataReachable: await svc.market.ping(),
    // Phase 1 never routes orders, so the builder code is unused. Reported only as a configured flag.
    builderCodeConfigured: opts.builderCodeConfigured ?? Boolean(process.env.PHOENIX_BUILDER_CODE),
    // Phase 2 A-book routing to Phoenix: "disabled" unless ROUTING_ENABLED=true ("dry_run", "live", or "<mode>:halted").
    routing: opts.routing?.healthLabel() ?? "disabled",
  }));

  app.get("/rules", async () => ({
    // The configured payout split and minimum, not the rulebook constant, so the UI shows what will actually be paid.
    common: { ...COMMON_RULES, profitSplit: svc.payoutPolicy.split, minPayoutUsd: svc.payoutPolicy.minUsd },
    payouts: { split: svc.payoutPolicy.split, minUsd: svc.payoutPolicy.minUsd, autoApproveUpToUsd: svc.payoutPolicy.autoMaxUsd, enabled: Boolean(opts.payouts) },
    tiers: TIERS,
    fees: PHOENIX_FEES,
    revive: REVIVE_RULES,
    pathToFunded: {
      targetCounts: "closed_balance",
      mustBeFlat: true,
      minTradingDays: COMMON_RULES.minTradingDays,
      bestDayMaxShare: COMMON_RULES.bestDayMaxShare,
      claimRequired: true,
      kyc: svc.kycMode,
      riskReview: svc.fundedReview,
      riskReviewTarget: "about 1 business day",
      payoutWaitingPeriodDays: 0,
    },
    // Funded scaling (rulebook section 16): every tier open to buy; funded accounts level up on one flat rule.
    scaling: {
      tiersOpenToAll: true,
      levelUpProfitPct: SCALING_RULES.levelUpProfitPct,
      levelUpProfitBasis: "realized_since_last_level_up_including_paid_out",
      levelUpPayouts: SCALING_RULES.levelUpPayouts,
      appliedWhen: "flat",
      graduation: "Lv.3 of Squire, Knight or Paladin levels up into Lv.1 of the next tier",
      limitsResetToNewSize: true,
      profitSplit: svc.payoutPolicy.split,
      resetOnBreach: true,
      ascendedStepUsd: SCALING_RULES.ascendedStepUsd,
      ascendedMaxUsd: SCALING_RULES.ascendedMaxUsd,
      table: scalingTable(),
    },
    accountCaps: ACCOUNT_CAPS,
    circuitBreaker: CIRCUIT_BREAKER,
    leverageCapByClass: LEVERAGE_CAP_BY_CLASS,
    markets: WHITELIST.map((symbol) => ({ symbol, class: assetClass(symbol), maxLeverage: leverageCap(symbol) })),
  }));

  // ------------------------------------------------------------ public market data (read-only)

  const marketCacheMs = opts.marketCacheMs ?? 750;
  const snapCache = new Map<string, { at: number; p: Promise<MarketSnapshot> }>();
  const marketSymbol = (raw: string): string => {
    const symbol = raw.trim().toUpperCase().replace(/-?PERP$/, "");
    if (!(WHITELIST as readonly string[]).includes(symbol)) throw new ServiceError(404, "unknown_market", `${raw} is not a Garuda market`);
    return symbol;
  };
  const cachedSnapshot = (symbol: string): Promise<MarketSnapshot> => {
    const t = now();
    const hit = snapCache.get(symbol);
    if (hit && t - hit.at < marketCacheMs) return hit.p;
    const p = svc.market.snapshot(symbol);
    snapCache.set(symbol, { at: t, p });
    p.catch(() => snapCache.delete(symbol));
    return p;
  };

  /** Live book (top levels), mark and funding for one market: what the terminal draws. Public. */
  app.get<{ Params: { symbol: string }; Querystring: { depth?: string } }>("/markets/:symbol", async (req) => {
    const symbol = marketSymbol(req.params.symbol);
    const depth = Math.min(50, Math.max(1, Number(req.query.depth ?? 12) || 12));
    let snap: MarketSnapshot;
    try {
      snap = await cachedSnapshot(symbol);
    } catch (e) {
      throw new ServiceError(502, "market_unavailable", `No market data for ${symbol}: ${(e as Error).message}`);
    }
    const bestBid = snap.book.bids[0]?.[0];
    const bestAsk = snap.book.asks[0]?.[0];
    return {
      symbol,
      display: `${symbol}-PERP`,
      class: assetClassOf(symbol),
      maxLeverage: leverageCap(symbol),
      mark: snap.markPrice,
      bestBid,
      bestAsk,
      mid: bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : snap.markPrice,
      fundingRateHourly: snap.fundingRateHourly,
      tradable: snap.tradable,
      tradableReason: snap.tradableReason,
      source: snap.source,
      fetchedAt: snap.fetchedAt,
      slot: snap.slot,
      book: { bids: snap.book.bids.slice(0, depth), asks: snap.book.asks.slice(0, depth) },
    };
  });

  /** Public post lookup for /calledit: text, author and avatar from X's embed endpoint, plus the id-derived time. */
  const tweets = opts.tweets ?? new TweetLookup();
  app.get<{ Params: { id: string } }>("/social/tweets/:id", async (req, reply) => {
    const id = req.params.id;
    if (!/^\d{5,20}$/.test(id)) throw new ServiceError(400, "invalid_tweet_id", "id must be a numeric post id");
    reply.header("Cache-Control", "public, max-age=600");
    return tweets.get(id);
  });

  /** Post photos, served from the API so they load on every network and can be drawn onto the card canvas. */
  const media = opts.media ?? new MediaProxy();
  app.get<{ Querystring: { u?: string } }>("/social/media", async (req, reply) => {
    const u = String(req.query.u ?? "");
    const img = await media.get(u);
    if (!img) throw new ServiceError(404, "media_unavailable", "That image is not available");
    reply.header("Content-Type", img.type);
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    return reply.send(img.body);
  });

  registerUploadRoutes(app, opts.uploads ?? new InMemoryUploadStore(), { now: opts.now });

  /** OHLCV for the chart. `source` says whether it is real Phoenix history or a synthetic offline stand-in. Public. */
  app.get<{ Params: { symbol: string }; Querystring: { tf?: string; limit?: string } }>("/markets/:symbol/candles", async (req) => {
    const symbol = marketSymbol(req.params.symbol);
    const tf = (req.query.tf ?? "1h") as CandleTimeframe;
    if (!(CANDLE_TIMEFRAMES as readonly string[]).includes(tf)) throw new ServiceError(400, "invalid_timeframe", `tf must be one of ${CANDLE_TIMEFRAMES.join(", ")}`);
    const limit = Math.min(500, Math.max(10, Number(req.query.limit ?? 120) || 120));
    if (!svc.market.candles) return { symbol, timeframe: tf, source: "none", candles: [] };
    try {
      const r = await svc.market.candles(symbol, tf, limit);
      return { symbol, timeframe: tf, source: r.source, candles: r.candles };
    } catch (e) {
      throw new ServiceError(502, "market_unavailable", `No candles for ${symbol}: ${(e as Error).message}`);
    }
  });

  /** Recent public trades (the tape). `source` says whether it is real Phoenix fills or a synthetic offline stand-in. Public. */
  const tradeCache = new Map<string, { at: number; body: unknown }>();
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>("/markets/:symbol/trades", async (req) => {
    const symbol = marketSymbol(req.params.symbol);
    const limit = Math.min(100, Math.max(5, Number(req.query.limit ?? 40) || 40));
    if (!svc.market.recentTrades) return { symbol, source: "none", trades: [] };
    const key = `${symbol}:${limit}`;
    const hit = tradeCache.get(key);
    if (hit && now() - hit.at < 1500) return hit.body;
    try {
      const r = await svc.market.recentTrades(symbol, limit);
      const body = { symbol, source: r.source, trades: r.trades };
      tradeCache.set(key, { at: now(), body });
      return body;
    } catch (e) {
      throw new ServiceError(502, "market_unavailable", `No trades for ${symbol}: ${(e as Error).message}`);
    }
  });

  app.post("/auth/nonce", async (req) => {
    if (!auth) throw new ServiceError(404, "auth_disabled");
    return auth.issueNonce(nonceBody.parse(req.body).wallet, typeof req.headers.origin === "string" ? req.headers.origin : undefined);
  });

  app.post("/auth/verify", async (req) => {
    if (!auth) throw new ServiceError(404, "auth_disabled");
    return auth.verify(verifyBody.parse(req.body));
  });

  app.post("/auth/privy", async (req) => {
    if (!auth) throw new ServiceError(404, "auth_disabled");
    return auth.privySignIn(privyBody.parse(req.body));
  });

  app.post("/auth/logout", async (req) => {
    await auth!.logout(req.headers.authorization!.slice(7).trim());
    return { ok: true };
  });

  app.get("/auth/me", async (req) => ({ wallet: walletOf.get(req) }));

  app.post("/challenges", async (req, reply) => {
    const body = createBody.parse(req.body);
    let wallet = body.wallet;
    if (auth) {
      // The account belongs to the signed-in wallet; a client cannot open accounts under someone else's address.
      const me = walletOf.get(req);
      if (wallet && wallet !== me) throw new ServiceError(403, "wallet_mismatch", "wallet does not match the signed-in wallet");
      wallet = me;
    }
    const state = await svc.create({ ...body, wallet, tier: body.tier as TierId, nftLevels: body.nftLevels as TierId[] | undefined });
    return reply.status(201).send(state);
  });

  app.get("/challenges", async (req) => ({ challenges: await svc.list(auth ? { wallet: walletOf.get(req) } : {}) }));

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/challenges/:id", async (req) => {
    await authorize(req, req.params.id);
    return svc.getState(req.params.id, { refresh: req.query.refresh !== "false" });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/challenges/:id/combat-log", async (req) => {
    await authorize(req, req.params.id);
    return { entries: await svc.getCombatLog(req.params.id, Math.min(500, Number(req.query.limit ?? 100) || 100)) };
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/orders", async (req, reply) => {
    await authorize(req, req.params.id);
    limit(req, reply, limiters?.orders, walletOf.get(req) ?? req.ip, "orders");
    const body = orderBody.parse(req.body);
    const res = await svc.placeOrder(req.params.id, body);
    return reply.status(res.accepted ? 201 : 422).send(res);
  });

  app.delete<{ Params: { id: string; orderId: string } }>("/challenges/:id/orders/:orderId", async (req) => {
    await authorize(req, req.params.id);
    return { order: await svc.cancelOrder(req.params.id, req.params.orderId) };
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/tick", async (req) => {
    await authorize(req, req.params.id);
    return svc.getState(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/challenges/:id/revive", async (req) => {
    await authorize(req, req.params.id, { rightsFollowKnight: true });
    return svc.reviveInfo(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/revive", async (req, reply) => {
    await authorize(req, req.params.id, { rightsFollowKnight: true });
    const key = req.headers["idempotency-key"];
    const res = await svc.revive(req.params.id, {
      idempotencyKey: typeof key === "string" && key.length > 0 ? key.slice(0, 120) : undefined,
      actorWallet: auth ? walletOf.get(req) : undefined,
    });
    return reply.status(res.replayed ? 200 : 201).send(res);
  });

  /** Path to Funded step 5: claim the funded account on a passed challenge (then KYC, then the risk review). */
  app.post<{ Params: { id: string } }>("/challenges/:id/claim", async (req, reply) => {
    await authorize(req, req.params.id);
    const state = await svc.claimFunded(req.params.id, { actorWallet: auth ? walletOf.get(req) : undefined });
    return reply.status(200).send(state);
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/reactivate", async (req) => {
    await authorize(req, req.params.id);
    return svc.reactivate(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/challenges/:id/payout-quote", async (req) => {
    await authorize(req, req.params.id);
    return svc.payoutQuote(req.params.id, auth ? walletOf.get(req) : undefined);
  });

  // ------------------------------------------------------------ M8: payouts

  /** Request a payout of the account's full profit to the signed-in wallet. Send an Idempotency-Key so a retry cannot pay twice. */
  app.post<{ Params: { id: string } }>("/challenges/:id/payouts", async (req, reply) => {
    await authorize(req, req.params.id);
    const key = req.headers["idempotency-key"];
    const res = await payouts().request(req.params.id, { actorWallet: auth ? walletOf.get(req) : undefined, idempotencyKey: Array.isArray(key) ? key[0] : key });
    return reply.status(res.replayed ? 200 : 201).send(res);
  });

  app.get<{ Params: { id: string } }>("/challenges/:id/payouts", async (req) => {
    await authorize(req, req.params.id);
    return { payouts: (await payouts().list({ challengeId: req.params.id })).map((p) => payoutView(p)) };
  });

  /** The signed-in wallet's payout history, newest first. */
  app.get<{ Querystring: { wallet?: string } }>("/payouts", async (req) => {
    const wallet = auth ? walletOf.get(req) : req.query.wallet;
    return { payouts: (await payouts().list(wallet ? { wallet } : {})).map((p) => payoutView(p)) };
  });

  app.get<{ Params: { id: string } }>("/payouts/:id", async (req) => {
    const p = await payouts().get(req.params.id);
    if (auth && p.wallet !== walletOf.get(req)) throw new ServiceError(403, "not_owner", "This payout belongs to another wallet");
    return payoutView(p);
  });

  // ------------------------------------------------------------ M8: payout admin (GARUDA_ADMIN_TOKEN)

  const actorOf = (req: FastifyRequest): string => {
    const h = req.headers["x-admin-actor"];
    const v = (Array.isArray(h) ? h[0] : h)?.trim().replace(/[^\w .@-]/g, "").slice(0, 64);
    return v || "admin";
  };

  app.get<{ Querystring: { status?: string; wallet?: string; challengeId?: string; limit?: string } }>("/admin/payouts", async (req) => {
    const status = req.query.status ? (req.query.status.split(",").map((x) => payoutStatusEnum.parse(x.trim())) as PayoutStatus[]) : undefined;
    const list = await payouts().list({ status, wallet: req.query.wallet, challengeId: req.query.challengeId, limit: Number(req.query.limit) || undefined });
    return { payouts: list, summary: await payouts().summary() };
  });

  app.get<{ Params: { id: string } }>("/admin/payouts/:id", async (req) => ({ payout: await payouts().get(req.params.id), events: await payouts().store.events(req.params.id) }));

  const adminResult = async (p: Payout) => ({ payout: p, events: await payouts().store.events(p.id) });

  app.post<{ Params: { id: string } }>("/admin/payouts/:id/approve", async (req) => adminResult(await payouts().approve(req.params.id, actorOf(req))));

  app.post<{ Params: { id: string } }>("/admin/payouts/:id/reject", async (req) => adminResult(await payouts().reject(req.params.id, rejectPayoutBody.parse(req.body ?? {}).reason, actorOf(req))));

  app.post<{ Params: { id: string } }>("/admin/payouts/:id/retry", async (req) => adminResult(await payouts().retryNow(req.params.id, actorOf(req))));

  // ------------------------------------------------------------ Path to Funded admin (GARUDA_ADMIN_TOKEN)
  // KYC is a manual ops step until a vendor (e.g. Sumsub) is integrated. TODO: replace /kyc with the vendor webhook.

  app.get<{ Querystring: { status?: string } }>("/admin/claims", async (req) => {
    const st = claimStatusQuery.parse(req.query.status ?? undefined);
    return { claims: await svc.listClaims(st) };
  });

  app.post<{ Params: { id: string } }>("/admin/claims/:id/kyc", async (req) => {
    const b = kycBody.parse(req.body ?? {});
    return svc.setClaimKyc(req.params.id, { decision: b.decision, reason: b.reason, actor: actorOf(req) });
  });

  app.post<{ Params: { id: string } }>("/admin/claims/:id/approve", async (req) => svc.reviewClaim(req.params.id, { decision: "approve", actor: actorOf(req) }));

  app.post<{ Params: { id: string } }>("/admin/claims/:id/reject", async (req) =>
    svc.reviewClaim(req.params.id, { decision: "reject", reason: rejectPayoutBody.parse(req.body ?? {}).reason, actor: actorOf(req) }),
  );

  // ------------------------------------------------------------ Phase 2: Phoenix routing admin (GARUDA_ADMIN_TOKEN)

  const routing = () => opts.routing ?? (() => { throw new ServiceError(404, "not_found", "Not found"); })();
  app.get("/admin/routing", async () => routing().status());
  app.get<{ Querystring: { challengeId?: string; limit?: string } }>("/admin/routing/orders", async (req) => ({
    orders: await routing().listOrders({ challengeId: req.query.challengeId || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }),
  }));
  /** Select or deselect a FUNDED account for A-book routing (per-trader opt-in). Evaluation and demo accounts are refused. */
  app.put<{ Params: { challengeId: string } }>("/admin/routing/traders/:challengeId", async (req) => {
    const r = routing();
    const b = routingTraderBody.parse(req.body ?? {});
    const st = await svc.getState(req.params.challengeId, { refresh: false });
    if (b.enabled && (st.stage !== "funded" || st.demo || st.status !== "active")) {
      throw new ServiceError(409, "not_routable", "Only live, non-demo FUNDED accounts can be selected for routing");
    }
    return { trader: await r.setTrader(req.params.challengeId, { ...b, wallet: st.wallet }, actorOf(req)) };
  });
  app.post("/admin/routing/halt", async (req) => {
    await routing().haltRouting(actorOf(req));
    return routing().status();
  });
  app.post("/admin/routing/resume", async (req) => {
    try {
      await routing().resumeRouting(actorOf(req));
    } catch (e) {
      throw new ServiceError(409, "routing_disabled", e instanceof Error ? e.message : String(e));
    }
    return routing().status();
  });
  app.post("/admin/routing/flatten", async (req) => ({ closed: await routing().flatten(actorOf(req)) }));
  app.post("/admin/routing/reconcile", async () => ({ reconcile: await routing().reconcile() }));

  // ------------------------------------------------------------ M4: USDC checkout

  app.post("/purchases/challenge", async (req, reply) => {
    const body = purchaseChallengeBody.parse(req.body);
    return reply.status(201).send(await purchases().quoteChallenge({ wallet: buyer(req, body.wallet), tier: body.tier as TierId, knightAsset: body.knightAsset, knightName: body.knightName }));
  });

  app.post("/purchases/revive", async (req, reply) => {
    const body = purchaseReviveBody.parse(req.body);
    return reply.status(201).send(await purchases().quoteRevive({ wallet: buyer(req, body.wallet), challengeId: body.challengeId }));
  });

  app.get("/purchases", async (req) => ({ orders: await purchases().list(buyer(req, (req.query as { wallet?: string }).wallet)) }));

  app.get<{ Params: { id: string } }>("/purchases/:id", async (req) => purchases().get(req.params.id, auth ? walletOf.get(req) : undefined));

  /** 200 fulfilled (or replayed), 202 transfer not visible yet (retry), 200 refunded / refund_pending with the reason in order.failure. */
  app.post<{ Params: { id: string } }>("/purchases/:id/confirm", async (req, reply) => {
    const body = confirmBody.parse(req.body);
    const out = await purchases().confirm(req.params.id, { signature: body.signature, wallet: auth ? walletOf.get(req) : undefined });
    return reply.status(out.status === "pending" ? 202 : 200).send(out);
  });

  // --------------------------------------------------------------- M3: knights

  app.get("/knights", async (req) => {
    if (!svc.knights) throw new ServiceError(404, "nft_disabled", "Knight NFTs are not configured on this server");
    return { knights: await svc.knights.listByOwner(buyer(req, (req.query as { wallet?: string }).wallet)) };
  });

  app.get<{ Params: { asset: string } }>("/knights/:asset", async (req) => {
    if (!svc.knights) throw new ServiceError(404, "nft_disabled", "Knight NFTs are not configured on this server");
    const k = await svc.knights.get(req.params.asset);
    if (!k || !k.genuine) throw new ServiceError(404, "knight_not_found", "No Garuda knight at that address");
    return k;
  });

  // Public, static: the metadata JSON and PNGs the onchain URIs point at. Devnet hosting; swap for a CDN later.
  if (opts.nft) {
    const nft = opts.nft;
    const dir = nft.artDir ?? DEFAULT_ART_DIR;
    app.get("/nft/collection.json", async () => collectionMetadata(nft.baseUrl));
    app.get<{ Params: { file: string } }>("/nft/metadata/:file", async (req) => {
      const tier = req.params.file.replace(/\.json$/, "");
      if (!isKnightTierName(tier) || !req.params.file.endsWith(".json")) throw new ServiceError(404, "not_found");
      return tierMetadata(nft.baseUrl, tier);
    });
    app.get<{ Params: { file: string } }>("/nft/images/:file", async (req, reply) => {
      const bytes = readArt(dir, req.params.file);
      if (!bytes) throw new ServiceError(404, "not_found");
      return reply.header("content-type", "image/png").header("cache-control", "public, max-age=3600").send(bytes);
    });
  }

  if (opts.early) registerEarlyRoutes(app, opts.early, now);

  return app;
}

function assetClass(symbol: string) {
  return assetClassOf(symbol);
}
