import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { api, ApiError, errorText, setApiToken, setUnauthorizedHandler } from "./api";
import type { Health, Rules } from "./types";
import { usePoll } from "./hooks";
import { usePrivyState } from "./privyState";

const KEY = "garuda.session";

/** Whatever pays the USDC checkout: the signed-in wallet, whether it is a Privy embedded wallet or a browser wallet. */
export interface PaySigner {
  publicKey: PublicKey | null;
  /** Sign and send. Returns the transaction signature (base58). Absent when the wallet cannot send. */
  send?: (tx: Transaction, connection: Connection, cluster: string) => Promise<string>;
}

export interface SessionValue {
  /** Wallet address this session belongs to. */
  wallet: string | null;
  /** A wallet is available (browser wallet connected, or a Privy wallet), signed in or not. */
  connected: boolean;
  /** A browser wallet (Phantom, Solflare...) is connected, so the signature fallback can run. */
  browserWallet: boolean;
  signedIn: boolean;
  signingIn: boolean;
  error: string | null;
  /** How this session was opened: Privy (email or wallet) or a plain wallet signature. */
  via: "privy" | "wallet" | null;
  /** Human label for the signed-in wallet. */
  walletLabel: string | null;
  /** Wallet signature sign-in for the connected browser wallet (the fallback path). */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Privy is configured (VITE_PRIVY_APP_ID): email or wallet sign-in is offered. */
  privyEnabled: boolean;
  /** Opens the Privy sign-in modal. No-op when Privy is not configured. */
  privyLogin: () => void;
  paySigner: PaySigner;
  health: Health | undefined;
  /** True when the API is unreachable. */
  offline: boolean;
  rules: Rules | undefined;
}

const Ctx = createContext<SessionValue | null>(null);
export const useSession = (): SessionValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
};

interface Stored {
  token: string;
  wallet: string;
  expiresAt: number;
  via?: "privy" | "wallet";
}

function readStored(): Stored | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Stored | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Privy may still be creating the embedded wallet right after login: the API answers 409 until it exists. */
const WALLET_RETRIES = 6;

/**
 * Sign-in for both paths. Privy (email or wallet): the Privy access token is exchanged at POST /auth/privy for a Garuda
 * session on the user's Solana wallet. Fallback: a browser wallet signs the nonce message (POST /auth/nonce + /auth/verify).
 * Either way the API client sends the resulting bearer token.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected: adapterConnected, disconnect, wallet: adapterWallet, sendTransaction: adapterSend } = useWallet();
  const privy = usePrivyState();
  const [stored, setStored] = useState<Stored | null>(() => {
    const s = readStored();
    if (s) setApiToken(s.token);
    return s;
  });
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);
  const privyAttempt = useRef<string | null>(null);

  const health = usePoll(() => api.health(), 20_000, "health");
  const rules = usePoll(() => api.rules(), 600_000, "rules");

  const apply = useCallback((s: Stored | null) => {
    setApiToken(s?.token);
    setStored(s);
    try {
      if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => apply(null));
    return () => setUnauthorizedHandler(undefined);
  }, [apply]);

  const adapterAddress = publicKey?.toBase58() ?? null;
  // Embedded wallet first: it is the one an email login created.
  const privyAddresses = privy.enabled && privy.authenticated ? [...privy.wallets].sort((a, b) => Number(b.embedded) - Number(a.embedded)).map((w) => w.address) : [];
  const privyKey = privy.authenticated ? privyAddresses.join(",") : "";

  // The active wallet: a Privy session is bound to a wallet Privy still holds; otherwise the browser wallet.
  const viaPrivy = stored?.via === "privy" && privyAddresses.includes(stored.wallet);
  const address = viaPrivy ? stored!.wallet : stored?.via === "privy" ? null : adapterAddress;

  // A stored session only counts for the wallet that made it.
  useEffect(() => {
    if (!stored) return;
    if (stored.via === "privy") {
      // Privy finished loading and no longer has this wallet (logged out elsewhere, or another account): drop it.
      if (privy.ready && privy.walletsReady && !privyAddresses.includes(stored.wallet)) apply(null);
    } else if (adapterAddress && stored.wallet !== adapterAddress) apply(null);
  }, [stored, adapterAddress, apply, privy.ready, privy.walletsReady, privyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Privy: as soon as the user is logged in and a Solana wallet exists, trade the Privy token for a Garuda session.
  useEffect(() => {
    if (!privy.enabled || !privy.ready || !privy.authenticated || !privy.walletsReady) return;
    if (health.data && !health.data.authRequired) return;
    if (stored?.via === "privy" && privyAddresses.includes(stored.wallet)) return;
    if (stored?.via === "wallet") return; // a browser-wallet session is already open; do not fight it
    if (privyAddresses.length === 0) return; // the embedded wallet is still being created: wallets change, we run again
    if (privyAttempt.current === privyKey) return;
    privyAttempt.current = privyKey;
    let cancelled = false;
    void (async () => {
      setSigningIn(true);
      setError(null);
      try {
        for (let i = 0; ; i++) {
          const accessToken = await privy.getAccessToken();
          if (!accessToken) throw new Error("Privy did not return an access token. Sign in again.");
          try {
            const out = await api.privyLogin(accessToken, privyAddresses[0]);
            if (!cancelled) apply({ token: out.token, wallet: out.wallet, expiresAt: out.expiresAt, via: "privy" });
            return;
          } catch (e) {
            if (e instanceof ApiError && e.code === "no_solana_wallet" && i < WALLET_RETRIES) {
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setSigningIn(false);
      }
    })();
    return () => {
      cancelled = true;
      privyAttempt.current = null;
    };
  }, [privy.enabled, privy.ready, privy.authenticated, privy.walletsReady, privyKey, stored, health.data, apply]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = useCallback(async () => {
    if (!adapterAddress || !signMessage) {
      setError(adapterAddress ? "This wallet cannot sign messages" : "Connect a wallet first");
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      const { nonce, message } = await api.nonce(adapterAddress);
      const sig = await signMessage(new TextEncoder().encode(message));
      const out = await api.verify(adapterAddress, nonce, bs58.encode(sig));
      apply({ token: out.token, wallet: out.wallet, expiresAt: out.expiresAt, via: "wallet" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSigningIn(false);
    }
  }, [adapterAddress, signMessage, apply]);

  // Browser wallet: sign in once per connected wallet, as soon as the API says it wants a session (unless Privy has it).
  useEffect(() => {
    if (!adapterConnected || !adapterAddress || stored?.wallet === adapterAddress || signingIn) return;
    if (stored?.via === "privy") return;
    if (health.data && !health.data.authRequired) return;
    if (attempted.current === adapterAddress) return;
    attempted.current = adapterAddress;
    void signIn();
  }, [adapterConnected, adapterAddress, stored, signingIn, health.data, signIn]);

  const signOut = useCallback(async () => {
    try {
      if (stored) await api.logout();
    } catch {
      /* the token is dropped locally either way */
    }
    apply(null);
    attempted.current = null;
    privyAttempt.current = null;
    if (privy.authenticated) await privy.logout().catch(() => undefined);
    await disconnect().catch(() => undefined);
  }, [stored, apply, disconnect, privy]);

  const open = health.data ? !health.data.authRequired : false;
  const anyAddress = viaPrivy ? stored!.wallet : adapterAddress ?? (privy.authenticated ? privyAddresses[0] ?? null : null);

  const paySigner = useMemo<PaySigner>(() => {
    if (viaPrivy && address) {
      return {
        publicKey: publicKeyOf(address),
        send: (tx, _c, cluster) => privy.sendTransaction(address, tx, cluster),
      };
    }
    return { publicKey, send: adapterSend ? (tx, c) => adapterSend(tx, c) : undefined };
  }, [viaPrivy, address, publicKey, adapterSend, privy]);

  const value = useMemo<SessionValue>(
    () => ({
      wallet: stored?.wallet ?? anyAddress,
      connected: Boolean(anyAddress),
      browserWallet: adapterConnected,
      signedIn: Boolean(stored && address && stored.wallet === address) || (open && Boolean(anyAddress)),
      signingIn,
      error,
      via: stored ? (viaPrivy ? "privy" : "wallet") : null,
      walletLabel: viaPrivy ? (privy.wallets.find((w) => w.address === address)?.embedded ? `Embedded wallet${privy.email ? ` · ${privy.email}` : ""}` : "Wallet via Privy") : adapterWallet?.adapter.name ?? null,
      signIn,
      signOut,
      privyEnabled: privy.enabled,
      privyLogin: privy.login,
      paySigner,
      health: health.data,
      // A health check that only timed out means a slow API, not a missing one: keep the app up while polling retries.
      offline: Boolean(health.error) && !(health.error instanceof ApiError && health.error.code === "timeout") && !health.data,
      rules: rules.data,
    }),
    [stored, anyAddress, adapterConnected, address, viaPrivy, signingIn, error, signIn, signOut, health.data, health.error, rules.data, open, privy, adapterWallet, paySigner],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function publicKeyOf(address: string): PublicKey | null {
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}
