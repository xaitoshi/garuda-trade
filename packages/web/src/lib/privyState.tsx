import { createContext, useContext } from "react";
import type { Transaction } from "@solana/web3.js";

/** A Solana wallet Privy has connected for the signed-in user (embedded for email logins, external otherwise). */
export interface PrivyWalletInfo {
  address: string;
  embedded: boolean;
}

/** What the rest of the app needs from Privy. Inactive (enabled=false) when VITE_PRIVY_APP_ID is not set. */
export interface PrivyState {
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  /** True once Privy has settled on the set of connected wallets (an embedded wallet may still be created on login). */
  walletsReady: boolean;
  wallets: PrivyWalletInfo[];
  email?: string;
  /** Opens the Privy modal: email, or connect Phantom/Solflare/Backpack. */
  login: () => void;
  logout: () => Promise<void>;
  /** Short-lived Privy access token for POST /auth/privy. */
  getAccessToken: () => Promise<string | null>;
  /** Sign with the given Privy wallet and send. Returns the base58 signature. */
  sendTransaction: (address: string, tx: Transaction, cluster: string) => Promise<string>;
}

export const INACTIVE_PRIVY: PrivyState = {
  enabled: false,
  ready: true,
  authenticated: false,
  walletsReady: true,
  wallets: [],
  login: () => undefined,
  logout: async () => undefined,
  getAccessToken: async () => null,
  sendTransaction: async () => {
    throw new Error("Privy is not configured");
  },
};

export const PrivyCtx = createContext<PrivyState>(INACTIVE_PRIVY);
export const usePrivyState = (): PrivyState => useContext(PrivyCtx);
