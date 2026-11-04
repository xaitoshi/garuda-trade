/** Garuda M3/M4 run on Solana DEVNET only. Everything that talks to an RPC goes through this guard. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const MAINNET_HINTS = ["mainnet", "api.mainnet-beta", "solana-mainnet", "mainnet.helius", "mainnet.rpcpool"];

export class MainnetRefusedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MainnetRefusedError";
  }
}

/** Cheap synchronous check on the URL: refuse anything that looks like mainnet. */
export function assertDevnetUrl(url: string): void {
  const u = url.toLowerCase();
  if (MAINNET_HINTS.some((h) => u.includes(h))) throw new MainnetRefusedError(`Refusing RPC endpoint ${url}: Garuda chain code is devnet only`);
}

/** Authoritative check: the endpoint's genesis hash must be devnet's. Call once at startup. */
export async function assertDevnetCluster(rpc: { call(method: string, params?: unknown[]): Promise<unknown> }): Promise<void> {
  const h = (await rpc.call("getGenesisHash", [])) as string;
  if (h !== DEVNET_GENESIS_HASH) throw new MainnetRefusedError(`RPC genesis hash ${h} is not devnet (${DEVNET_GENESIS_HASH}); refusing to run`);
}
