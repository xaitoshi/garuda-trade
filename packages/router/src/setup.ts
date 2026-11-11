import { routingConfigFromEnv } from "./config.js";
import { RisePhoenixClient, parseKeypairSecret } from "./phoenix-client.js";
import { PhoenixRouter } from "./router.js";
import type { RoutingStore } from "./store.js";
import type { PhoenixTradingClient, TraderBook } from "./types.js";

/**
 * Build the router from the environment. ROUTING_ENABLED=false (the default) never reads the delegate key and returns a
 * router in "disabled" mode that ignores every fill. The key is removed from process.env once read.
 */
export async function createRouterFromEnv(
  env: Record<string, string | undefined>,
  deps: { store: RoutingStore; traderBook?: (id: string) => Promise<TraderBook | undefined>; log?: (m: string) => void; client?: PhoenixTradingClient },
): Promise<PhoenixRouter> {
  const config = routingConfigFromEnv(env);
  let client = deps.client;
  const secretRaw = env.PHOENIX_DELEGATE_KEYPAIR?.trim();
  delete env.PHOENIX_DELEGATE_KEYPAIR;
  const firm = env.PHOENIX_FIRM_AUTHORITY?.trim();
  const builderAuthority = env.PHOENIX_BUILDER_AUTHORITY?.trim() || undefined;
  if (config.enabled && !client && secretRaw && firm) {
    client = await RisePhoenixClient.create({
      apiUrl: env.PHOENIX_API_URL,
      rpcUrl: env.PHOENIX_TRADE_RPC_URL ?? env.PHOENIX_RPC_URL,
      wsUrl: env.PHOENIX_TRADE_WS_URL,
      firmAuthority: firm,
      pdaIndex: env.PHOENIX_FIRM_PDA_INDEX ? Number(env.PHOENIX_FIRM_PDA_INDEX) : 0,
      delegateSecret: parseKeypairSecret(secretRaw),
      builder: builderAuthority ? { authority: builderAuthority, pdaIndex: Number(env.PHOENIX_BUILDER_PDA_INDEX ?? 0), subaccountIndex: Number(env.PHOENIX_BUILDER_SUBACCOUNT_INDEX ?? 0) } : undefined,
    });
  }
  const router = new PhoenixRouter({ config, store: deps.store, client, traderBook: deps.traderBook, log: deps.log, builderConfigured: Boolean(builderAuthority) });
  await router.init();
  return router;
}
