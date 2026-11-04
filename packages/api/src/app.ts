import Fastify, { type FastifyInstance } from "fastify";
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

export interface AppOptions {
  service: ChallengeService;
  builderCodeConfigured?: boolean;
  logger?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const svc = opts.service;

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

  app.get("/health", async () => ({
    ok: true,
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

  app.post("/challenges", async (req, reply) => {
    const body = createBody.parse(req.body);
    const state = svc.create({ ...body, tier: body.tier as TierId, nftLevels: body.nftLevels as TierId[] | undefined });
    return reply.status(201).send(state);
  });

  app.get("/challenges", async () => ({ challenges: svc.list() }));

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/challenges/:id", async (req) =>
    svc.getState(req.params.id, { refresh: req.query.refresh !== "false" }),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/challenges/:id/combat-log", async (req) => ({
    entries: svc.getCombatLog(req.params.id, Math.min(500, Number(req.query.limit ?? 100) || 100)),
  }));

  app.post<{ Params: { id: string } }>("/challenges/:id/orders", async (req, reply) => {
    const body = orderBody.parse(req.body);
    const res = await svc.placeOrder(req.params.id, body);
    return reply.status(res.accepted ? 201 : 422).send(res);
  });

  app.delete<{ Params: { id: string; orderId: string } }>("/challenges/:id/orders/:orderId", async (req) => ({
    order: await svc.cancelOrder(req.params.id, req.params.orderId),
  }));

  app.post<{ Params: { id: string } }>("/challenges/:id/tick", async (req) => svc.getState(req.params.id));

  return app;
}

function assetClass(symbol: string) {
  return assetClassOf(symbol);
}
