/** Base URL of the Garuda API. Default "/api" (Vite dev/preview proxy); set VITE_API_URL for a deployed API. */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

/** Solana RPC the browser uses to send the USDC transfer. Devnet only (the API refuses mainnet). */
export const SOLANA_RPC: string = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? "https://api.devnet.solana.com";

/** Adds a local "Garuda Dev Wallet" (an in-browser throwaway key) next to Phantom/Solflare. Dev and screenshots only. */
export const DEV_WALLET: boolean = import.meta.env.VITE_DEV_WALLET === "1";

export const POLL = { stateMs: 2000, marketMs: 1500, chartMs: 30_000 } as const;
