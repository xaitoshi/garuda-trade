/** Base URL of the Garuda API. Default "/api" (Vite dev/preview proxy); set VITE_API_URL for a deployed API. */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

/** Solana RPC the browser uses to send the USDC transfer. Devnet only (the API refuses mainnet). */
export const SOLANA_RPC: string = (import.meta.env.VITE_SOLANA_RPC as string | undefined) ?? "https://api.devnet.solana.com";

/** Adds a local "Garuda Dev Wallet" (an in-browser throwaway key) next to Phantom/Solflare. Dev and screenshots only. */
export const DEV_WALLET: boolean = import.meta.env.VITE_DEV_WALLET === "1";

export const POLL = { stateMs: 2000, marketMs: 1500, chartMs: 30_000 } as const;

/**
 * Privy app id (public, it ships in the bundle). Set VITE_PRIVY_APP_ID to turn on "Sign in with email or wallet":
 * Privy then creates an embedded Solana wallet for email users. Empty: the app runs on plain wallet sign-in only.
 */
export const PRIVY_APP_ID: string = ((import.meta.env.VITE_PRIVY_APP_ID as string | undefined) ?? "").trim();

/** Screenshots only: render the Privy sign-in UI without an app id (the buttons are inert). Never set in a deployment. */
export const PRIVY_PREVIEW: boolean = import.meta.env.VITE_PRIVY_PREVIEW === "1";

/**
 * Garuda Beta Access (/early). The NFT and its USDC payment live on Solana MAINNET (the rest of the app is devnet).
 * EARLY_ART is the one file to swap for new artwork (keep the same name so the onchain metadata keeps resolving).
 */
export const EARLY_RPC: string = (import.meta.env.VITE_EARLY_RPC as string | undefined) ?? "https://api.mainnet-beta.solana.com";
export const EARLY_ART = "/early/garuda-beta-access.png?v=2";
/** Lighter page preview of the same art (720px WebP). Bump ?v= when the art changes so caches refetch. */
export const EARLY_ART_PREVIEW = "/early/garuda-beta-access-720.webp?v=2";
