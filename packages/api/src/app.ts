import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ACCOUNT_CAPS,
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
import type { AuthService } from "./auth.js";
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitConfig } from "./rate-limit.js";
import { ChallengeService, ServiceError } from "./service.js";

const tierEnum = z.enum(TIER_IDS as [string, ...string[]]);

const createBody = z.object({
  tier: tierEnum,
  stage: z.enum(["evaluation", "funded"]).optional(),
  knight: z.string().min(1).max(40).optional(),
  wallet: z.string().min(1).max(64).optional(),
  nftLevels: z.array(tierEnum).optional(),
});

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

const nonceBody = z.object({ wallet: z.string().min(32).max(44) });
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
  /** Served at GET /metrics (worker latency, feed health). */
  metrics?: () => unknown;
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

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path === "/health") return;
    limit(req, reply, limiters?.ip, req.ip, "ip");
    if (path.startsWith("/auth/")) limit(req, reply, limiters?.auth, req.ip, "auth");
  });

  // Sign-in required on everything that touches an account; /health, /rules, /metrics and /auth/* stay public.
  app.addHook("preHandler", async (req, reply) => {
    if (!auth) return;
    const path = req.url.split("?")[0]!;
    const isAccountRoute = path === "/challenges" || path.startsWith("/challenges/") || path === "/auth/me" || path === "/auth/logout";
    if (!isAccountRoute) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const session = await auth.authenticate(token);
    if (!session) throw new ServiceError(401, "unauthorized", "Sign in with your wallet first (POST /auth/nonce, then /auth/verify)");
    walletOf.set(req, session.wallet);
    limit(req, reply, limiters?.wallet, session.wallet, "wallet");
  });

  /** Ownership check on every :id route: 403 when the challenge belongs to another wallet. */
  const authorize = async (req: FastifyRequest, id: string) => {
    if (!auth) return;
    const owner = await svc.ownerOf(id); // 404 for unknown ids
    if (!owner || owner !== walletOf.get(req)) throw new ServiceError(403, "not_owner", "This challenge belongs to another wallet");
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
    ok: true,
    authRequired: Boolean(auth),
    simulated: true,
    marketData: svc.market.name,
    marketDataReachable: await svc.market.ping(),
    // Phase 1 never routes orders, so the builder code is unused. Reported only as a configured flag.
    builderCodeConfigured: opts.builderCodeConfigured ?? Boolean(process.env.PHOENIX_BUILDER_CODE),
  }));

  app.get("/rules", async () => ({
    common: COMMON_RULES,
    tiers: TIERS,
    fees: PHOENIX_FEES,
    revive: REVIVE_RULES,
    accountCaps: ACCOUNT_CAPS,
    circuitBreaker: CIRCUIT_BREAKER,
    leverageCapByClass: LEVERAGE_CAP_BY_CLASS,
    markets: WHITELIST.map((symbol) => ({ symbol, class: assetClass(symbol), maxLeverage: leverageCap(symbol) })),
  }));

  app.post("/auth/nonce", async (req) => {
    if (!auth) throw new ServiceError(404, "auth_disabled");
    return auth.issueNonce(nonceBody.parse(req.body).wallet);
  });

  app.post("/auth/verify", async (req) => {
    if (!auth) throw new ServiceError(404, "auth_disabled");
    return auth.verify(verifyBody.parse(req.body));
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
    await authorize(req, req.params.id);
    return svc.reviveInfo(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/revive", async (req, reply) => {
    await authorize(req, req.params.id);
    const key = req.headers["idempotency-key"];
    const res = await svc.revive(req.params.id, { idempotencyKey: typeof key === "string" && key.length > 0 ? key.slice(0, 120) : undefined });
    return reply.status(res.replayed ? 200 : 201).send(res);
  });

  app.post<{ Params: { id: string } }>("/challenges/:id/reactivate", async (req) => {
    await authorize(req, req.params.id);
    return svc.reactivate(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/challenges/:id/payout-quote", async (req) => {
    await authorize(req, req.params.id);
    return svc.payoutQuote(req.params.id);
  });

  return app;
}

function assetClass(symbol: string) {
  return assetClassOf(symbol);
}
