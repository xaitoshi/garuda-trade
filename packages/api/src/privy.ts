import type { KeyObject } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWK } from "jose";

type VerifyKey = JWTVerifyGetKey | CryptoKey | KeyObject | JWK | Uint8Array;
import { ServiceError } from "./service.js";
import { parseWallet } from "./auth.js";

/** A Solana wallet linked to a Privy user: an embedded wallet Privy created (email login) or an external one (Phantom...). */
export interface PrivyWallet {
  address: string;
  embedded: boolean;
}

/** What the API needs from Privy. Production uses PrivyServerVerifier; tests inject a fake. */
export interface PrivyVerifier {
  /** Verify a Privy access token (signature, issuer, audience, expiry). Throws ServiceError 401 when it is not valid. */
  verifyAccessToken(token: string): Promise<{ userId: string; expiresAt: number }>;
  /** Solana wallets linked to the user (needs the app secret). Throws ServiceError 502 when Privy cannot be reached. */
  solanaWallets(userId: string): Promise<PrivyWallet[]>;
}

export interface PrivyServerOptions {
  appId: string;
  /** PRIVY_APP_SECRET. Used only to read the user's linked accounts (Basic auth), never sent to the browser. */
  appSecret: string;
  /** Default https://auth.privy.io/api/v1/apps/<appId>/jwks.json */
  jwksUrl?: string;
  /** Default https://auth.privy.io/api/v1/users (REST user lookup). */
  usersUrl?: string;
  /** Tests: resolve the verification key locally instead of fetching Privy's JWKS. */
  keyResolver?: VerifyKey;
  fetch?: typeof fetch;
}

interface LinkedAccount {
  type?: string;
  chain_type?: string;
  address?: string;
  wallet_client_type?: string;
  connector_type?: string;
  id?: string;
}

/** Privy access tokens are ES256 JWTs: iss "privy.io", aud = the app id, sub = the user's DID. */
export class PrivyServerVerifier implements PrivyVerifier {
  private readonly keys: VerifyKey;
  private readonly doFetch: typeof fetch;
  private readonly usersUrl: string;

  constructor(private readonly opts: PrivyServerOptions) {
    if (!opts.appId || !opts.appSecret) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are both required");
    this.keys = opts.keyResolver ?? createRemoteJWKSet(new URL(opts.jwksUrl ?? `https://auth.privy.io/api/v1/apps/${opts.appId}/jwks.json`));
    this.doFetch = opts.fetch ?? fetch;
    this.usersUrl = (opts.usersUrl ?? "https://auth.privy.io/api/v1/users").replace(/\/$/, "");
  }

  async verifyAccessToken(token: string): Promise<{ userId: string; expiresAt: number }> {
    try {
      const { payload } = await jwtVerify(token, this.keys as JWTVerifyGetKey, { issuer: "privy.io", audience: this.opts.appId, algorithms: ["ES256"] });
      if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) throw new Error("no Privy user id");
      return { userId: payload.sub, expiresAt: (payload.exp ?? 0) * 1000 };
    } catch {
      throw new ServiceError(401, "invalid_privy_token", "The Privy access token is invalid or expired. Sign in again.");
    }
  }

  async solanaWallets(userId: string): Promise<PrivyWallet[]> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.usersUrl}/${encodeURIComponent(userId)}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${this.opts.appId}:${this.opts.appSecret}`).toString("base64")}`,
          "privy-app-id": this.opts.appId,
        },
      });
    } catch {
      throw new ServiceError(502, "privy_unavailable", "Cannot reach Privy to read the account's wallets");
    }
    if (!res.ok) throw new ServiceError(502, "privy_unavailable", `Privy refused the wallet lookup (${res.status}). Check PRIVY_APP_SECRET.`);
    const body = (await res.json().catch(() => ({}))) as { linked_accounts?: LinkedAccount[] };
    return solanaWalletsOf(body.linked_accounts ?? []);
  }
}

/** Solana wallet accounts out of a Privy user's linked_accounts, deduplicated, embedded wallets first. */
export function solanaWalletsOf(accounts: LinkedAccount[]): PrivyWallet[] {
  const seen = new Set<string>();
  const out: PrivyWallet[] = [];
  for (const a of accounts) {
    if (a.type !== "wallet" || a.chain_type !== "solana" || !a.address || !parseWallet(a.address) || seen.has(a.address)) continue;
    seen.add(a.address);
    out.push({ address: a.address, embedded: a.wallet_client_type === "privy" || a.connector_type === "embedded" });
  }
  return out.sort((x, y) => Number(y.embedded) - Number(x.embedded));
}
