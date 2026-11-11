import type { RoutingMode } from "./types.js";

export interface RoutingConfig {
  /** Master switch from the environment. False unless ROUTING_ENABLED is exactly "true" or "1". */
  enabled: boolean;
  /** DRY_RUN logs the intended Phoenix orders without sending them. Defaults to TRUE: going live needs ROUTING_DRY_RUN=false. */
  dryRun: boolean;
  /** Firm size = trader size x multiplier (per-trader overrides allowed). */
  sizeMultiplier: number;
  maxTradeNotionalUsd: number;
  maxTraderNotionalUsd: number;
  maxTotalNotionalUsd: number;
  dailyLossLimitUsd: number;
  /** Upper-case Phoenix symbols, e.g. SOL, BTC, ETH. Only these are ever opened on Phoenix. */
  markets: string[];
  maxSlippageBps: number;
  /** Orders below this notional are not sent (dust). */
  minOrderNotionalUsd: number;
  /** Leverage used to size the USDC moved into an isolated subaccount on open (collateral = notional / leverage). */
  isolatedLeverage: number;
  reconcileMs: number;
  /** Reconciliation flags a drift when |phoenix - expected| x price exceeds this. */
  driftToleranceUsd: number;
}

const num = (env: Record<string, string | undefined>, key: string, def: number, check: (n: number) => boolean = (n) => n > 0): number => {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) throw new Error(`${key} must be a valid positive number (got "${raw}")`);
  return n;
};

export function routingConfigFromEnv(env: Record<string, string | undefined> = process.env): RoutingConfig {
  const flag = (v: string | undefined) => v?.trim().toLowerCase();
  return {
    enabled: flag(env.ROUTING_ENABLED) === "true" || flag(env.ROUTING_ENABLED) === "1",
    dryRun: !(flag(env.ROUTING_DRY_RUN) === "false" || flag(env.ROUTING_DRY_RUN) === "0"),
    sizeMultiplier: num(env, "ROUTING_SIZE_MULTIPLIER", 0.1, (n) => n > 0 && n <= 10),
    maxTradeNotionalUsd: num(env, "ROUTING_MAX_TRADE_NOTIONAL_USD", 500),
    maxTraderNotionalUsd: num(env, "ROUTING_MAX_TRADER_NOTIONAL_USD", 1_000),
    maxTotalNotionalUsd: num(env, "ROUTING_MAX_TOTAL_NOTIONAL_USD", 5_000),
    dailyLossLimitUsd: num(env, "ROUTING_DAILY_LOSS_LIMIT_USD", 250),
    markets: (env.ROUTING_MARKETS?.trim() || "SOL,BTC,ETH")
      .split(",")
      .map((s) => s.trim().toUpperCase().replace(/-?PERP$/, ""))
      .filter(Boolean),
    maxSlippageBps: num(env, "ROUTING_MAX_SLIPPAGE_BPS", 50, (n) => n > 0 && n <= 1_000),
    minOrderNotionalUsd: num(env, "ROUTING_MIN_ORDER_NOTIONAL_USD", 10),
    isolatedLeverage: num(env, "ROUTING_ISOLATED_LEVERAGE", 3, (n) => n >= 1 && n <= 20),
    reconcileMs: num(env, "ROUTING_RECONCILE_MS", 60_000, (n) => n >= 5_000),
    driftToleranceUsd: num(env, "ROUTING_DRIFT_TOLERANCE_USD", 25),
  };
}

/** Resolve the effective mode. Live needs the delegate key and the firm authority; without them live is refused. */
export function resolveMode(cfg: RoutingConfig, hasLiveClient: boolean): { mode: RoutingMode; reason?: string } {
  if (!cfg.enabled) return { mode: "disabled", reason: "ROUTING_ENABLED is not true" };
  if (cfg.dryRun) return { mode: "dry_run" };
  if (!hasLiveClient) return { mode: "disabled", reason: "live routing needs PHOENIX_DELEGATE_KEYPAIR and PHOENIX_FIRM_AUTHORITY" };
  return { mode: "live" };
}
