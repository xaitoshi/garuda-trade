import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { api, errorText, setApiToken, setUnauthorizedHandler } from "./api";
import type { Health, Rules } from "./types";
import { usePoll } from "./hooks";

const KEY = "garuda.session";

export interface SessionValue {
  /** Wallet address this session belongs to. */
  wallet: string | null;
  signedIn: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
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
}

function readStored(): Stored | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Stored | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Wallet sign-in (nonce, signMessage, verify) and the bearer token the API client sends. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [stored, setStored] = useState<Stored | null>(() => {
    const s = readStored();
    if (s) setApiToken(s.token);
    return s;
  });
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);

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

  const address = publicKey?.toBase58() ?? null;

  // A stored session only counts for the wallet that made it.
  useEffect(() => {
    if (stored && address && stored.wallet !== address) apply(null);
  }, [stored, address, apply]);

  const signIn = useCallback(async () => {
    if (!address || !signMessage) {
      setError(address ? "This wallet cannot sign messages" : "Connect a wallet first");
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      const { nonce, message } = await api.nonce(address);
      const sig = await signMessage(new TextEncoder().encode(message));
      const out = await api.verify(address, nonce, bs58.encode(sig));
      apply({ token: out.token, wallet: out.wallet, expiresAt: out.expiresAt });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSigningIn(false);
    }
  }, [address, signMessage, apply]);

  // Sign in once per connected wallet, as soon as the API says it wants a session.
  useEffect(() => {
    if (!connected || !address || stored?.wallet === address || signingIn) return;
    if (health.data && !health.data.authRequired) return;
    if (attempted.current === address) return;
    attempted.current = address;
    void signIn();
  }, [connected, address, stored, signingIn, health.data, signIn]);

  const signOut = useCallback(async () => {
    try {
      if (stored) await api.logout();
    } catch {
      /* the token is dropped locally either way */
    }
    apply(null);
    attempted.current = null;
    await disconnect().catch(() => undefined);
  }, [stored, apply, disconnect]);

  const open = health.data ? !health.data.authRequired : false;
  const value = useMemo<SessionValue>(
    () => ({
      wallet: stored?.wallet ?? address,
      signedIn: Boolean(stored && address && stored.wallet === address) || (open && Boolean(address)),
      signingIn,
      error,
      signIn,
      signOut,
      health: health.data,
      offline: Boolean(health.error) && !health.data,
      rules: rules.data,
    }),
    [stored, address, signingIn, error, signIn, signOut, health.data, health.error, rules.data, open],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
