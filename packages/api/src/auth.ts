import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import type { Db } from "@garuda/db";
import { base58Decode } from "./base58.js";
import { ServiceError } from "./service.js";
import type { PrivyVerifier } from "./privy.js";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; append the 32-byte key to get a key Node can import. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A Solana address is the base58 of a 32-byte Ed25519 public key. */
export function parseWallet(wallet: string): Buffer | undefined {
  if (wallet.length < 32 || wallet.length > 44) return undefined;
  const b = base58Decode(wallet);
  return b && b.length === 32 ? Buffer.from(b) : undefined;
}

/** Signature as base58 (what most Solana wallets show) or base64 (what signMessage returns once encoded). 64 bytes. */
export function parseSignature(sig: string): Buffer | undefined {
  const s = sig.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) {
    const b = base58Decode(s);
    if (b?.length === 64) return Buffer.from(b);
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 64) return b;
  }
  return undefined;
}

/** Verify an Ed25519 signature over a UTF-8 message with a Solana wallet address. Never throws. */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  const pub = parseWallet(wallet);
  const sig = parseSignature(signature);
  if (!pub || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export interface NonceRecord {
  nonce: string;
  wallet: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionRecord {
  tokenHash: string;
  wallet: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthStore {
  saveNonce(n: NonceRecord): Promise<void>;
  /** Atomically mark a nonce used and return it, only if it exists, matches the wallet, is unused and unexpired. */
  consumeNonce(nonce: string, wallet: string, now: number): Promise<NonceRecord | undefined>;
  saveSession(s: SessionRecord): Promise<void>;
  /** Unrevoked, unexpired session by token hash. */
  getSession(tokenHash: string, now: number): Promise<SessionRecord | undefined>;
  revokeSession(tokenHash: string, now: number): Promise<void>;
}

export class InMemoryAuthStore implements AuthStore {
  private nonces = new Map<string, NonceRecord & { usedAt?: number }>();
  private sessions = new Map<string, SessionRecord & { revokedAt?: number }>();
  async saveNonce(n: NonceRecord) {
    this.nonces.set(n.nonce, { ...n });
  }
  async consumeNonce(nonce: string, wallet: string, now: number) {
    const n = this.nonces.get(nonce);
    if (!n || n.wallet !== wallet || n.usedAt !== undefined || n.expiresAt <= now) return undefined;
    n.usedAt = now;
    return n;
  }
  async saveSession(s: SessionRecord) {
    this.sessions.set(s.tokenHash, { ...s });
  }
  async getSession(tokenHash: string, now: number) {
    const s = this.sessions.get(tokenHash);
    return s && s.revokedAt === undefined && s.expiresAt > now ? s : undefined;
  }
  async revokeSession(tokenHash: string, now: number) {
    const s = this.sessions.get(tokenHash);
    if (s) s.revokedAt = now;
  }
}

export class PgAuthStore implements AuthStore {
  constructor(private readonly db: Db) {}
  async saveNonce(n: NonceRecord) {
    await this.db.query("INSERT INTO auth_nonces (nonce, wallet, message, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5)", [n.nonce, n.wallet, n.message, n.issuedAt, n.expiresAt]);
  }
  async consumeNonce(nonce: string, wallet: string, now: number) {
    const r = await this.db.query<Record<string, unknown>>(
      "UPDATE auth_nonces SET used_at = $1 WHERE nonce = $2 AND wallet = $3 AND used_at IS NULL AND expires_at > $1 RETURNING nonce, wallet, message, issued_at, expires_at",
      [now, nonce, wallet],
    );
    const row = r.rows[0];
    return row
      ? { nonce: String(row.nonce), wallet: String(row.wallet), message: String(row.message), issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at) }
      : undefined;
  }
  async saveSession(s: SessionRecord) {
    await this.db.query("INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES ($1, $2, $3, $4)", [s.tokenHash, s.wallet, s.createdAt, s.expiresAt]);
  }
  async getSession(tokenHash: string, now: number) {
    const r = await this.db.query<Record<string, unknown>>("SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2", [tokenHash, now]);
    const row = r.rows[0];
    return row ? { tokenHash: String(row.token_hash), wallet: String(row.wallet), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) } : undefined;
  }
  async revokeSession(tokenHash: string, now: number) {
    await this.db.query("UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2", [now, tokenHash]);
  }
}

export interface AuthOptions {
  store?: AuthStore;
  now?: () => number;
  /** Shown to the user in the signed message; wallets display it so users can see where they are signing in. */
  domain?: string;
  /**
   * Browser origins allowed to sign in (normally GARUDA_CORS_ORIGIN). Wallets (Phantom, Solflare) refuse a sign-in message
   * whose domain is not the requesting page's host, so the message domain is the request Origin's host when the Origin is
   * listed here ("*" allows any origin). Unlisted or missing Origin falls back to `domain`.
   */
  allowedOrigins?: readonly string[] | "*";
  nonceTtlMs?: number;
  sessionTtlMs?: number;
  /** Privy sign-in (email with an embedded wallet, or an external wallet connected through Privy). Off when omitted. */
  privy?: PrivyVerifier;
}

export interface NonceChallenge {
  wallet: string;
  nonce: string;
  /** Exact UTF-8 text the wallet must sign (signMessage). */
  message: string;
  issuedAt: number;
  expiresAt: number;
}

export interface Session {
  token: string;
  wallet: string;
  expiresAt: number;
}

/** "https://Host:443/" -> "https://host"; undefined when not an http(s) origin. */
export function normalizeOrigin(o: string): string | undefined {
  try {
    const u = new URL(o.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Sign-in with Solana (sign-message). Flow:
 *   1. POST /auth/nonce  {wallet}            -> server issues a single-use nonce and the exact message to sign
 *   2. wallet signs the message (Ed25519, signMessage; no transaction, no fee)
 *   3. POST /auth/verify {wallet, nonce, signature} -> server verifies, burns the nonce, returns a session token
 *   4. Authorization: Bearer <token> on every account route
 * The nonce is burned even when the signature is wrong, so a failed attempt cannot be retried against the same nonce.
 */
export class AuthService {
  readonly store: AuthStore;
  private readonly now: () => number;
  readonly domain: string;
  private readonly nonceTtlMs: number;
  private readonly sessionTtlMs: number;
  readonly privy?: PrivyVerifier;
  private readonly allowedOrigins: readonly string[] | "*";

  constructor(opts: AuthOptions = {}) {
    this.store = opts.store ?? new InMemoryAuthStore();
    this.now = opts.now ?? Date.now;
    this.domain = opts.domain ?? "garuda";
    this.nonceTtlMs = opts.nonceTtlMs ?? 5 * 60_000;
    this.sessionTtlMs = opts.sessionTtlMs ?? 24 * 3_600_000;
    this.privy = opts.privy;
    this.allowedOrigins = opts.allowedOrigins === "*" ? "*" : (opts.allowedOrigins ?? []).map(normalizeOrigin).filter((o): o is string => !!o);
  }

  /** The domain to put in the sign-in message for a request from `origin` (host[:port] of an allowed origin, else the default). */
  domainFor(origin: string | undefined): string {
    const o = origin ? normalizeOrigin(origin) : undefined;
    if (!o) return this.domain;
    if (this.allowedOrigins !== "*" && !this.allowedOrigins.includes(o)) return this.domain;
    return new URL(o).host;
  }

  /**
   * Sign in with Privy. The browser sends its Privy access token; the server verifies it (signature, issuer, audience,
   * expiry), reads the user's linked Solana wallets, and opens an ordinary Garuda session on one of them:
   *   - `wallet` given: it must be one of the user's linked Solana wallets (403 wallet_not_linked otherwise)
   *   - `wallet` omitted: the user's embedded wallet, else their first external one
   * No wallet yet (embedded wallet still being created) is 409 no_solana_wallet: the client retries.
   */
  async privySignIn(input: { accessToken: string; wallet?: string }): Promise<Session & { userId: string; embedded: boolean }> {
    if (!this.privy) throw new ServiceError(404, "privy_disabled", "Privy sign-in is not configured on this server");
    const { userId } = await this.privy.verifyAccessToken(input.accessToken);
    const wallets = await this.privy.solanaWallets(userId);
    if (wallets.length === 0) throw new ServiceError(409, "no_solana_wallet", "This account has no Solana wallet yet. Wait for the embedded wallet to be created, or connect one.");
    const chosen = input.wallet ? wallets.find((w) => w.address === input.wallet) : wallets[0];
    if (!chosen) throw new ServiceError(403, "wallet_not_linked", "That wallet is not linked to this Privy account");
    const now = this.now();
    const token = `gr_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + this.sessionTtlMs;
    await this.store.saveSession({ tokenHash: sha256(token), wallet: chosen.address, createdAt: now, expiresAt });
    return { token, wallet: chosen.address, expiresAt, userId, embedded: chosen.embedded };
  }

  async issueNonce(wallet: string, origin?: string): Promise<NonceChallenge> {
    if (!parseWallet(wallet)) throw new ServiceError(400, "invalid_wallet", "Not a valid Solana address");
    const issuedAt = this.now();
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = issuedAt + this.nonceTtlMs;
    const message = [
      `${this.domainFor(origin)} wants you to sign in with your Solana account:`,
      wallet,
      "",
      "Sign in to Garuda. This does not send a transaction or cost anything.",
      "",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issuedAt).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    await this.store.saveNonce({ nonce, wallet, message, issuedAt, expiresAt });
    return { wallet, nonce, message, issuedAt, expiresAt };
  }

  async verify(input: { wallet: string; nonce: string; signature: string }): Promise<Session> {
    const now = this.now();
    const rec = await this.store.consumeNonce(input.nonce, input.wallet, now);
    if (!rec) throw new ServiceError(401, "invalid_nonce", "Nonce is unknown, expired, already used, or for another wallet");
    if (!verifyWalletSignature(input.wallet, rec.message, input.signature)) throw new ServiceError(401, "invalid_signature", "Signature does not match the wallet and message");
    const token = `gr_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + this.sessionTtlMs;
    await this.store.saveSession({ tokenHash: sha256(token), wallet: input.wallet, createdAt: now, expiresAt });
    return { token, wallet: input.wallet, expiresAt };
  }

  /** The wallet behind a bearer token, or undefined when missing, unknown, expired or logged out. */
  async authenticate(token: string | undefined): Promise<{ wallet: string; expiresAt: number } | undefined> {
    if (!token) return undefined;
    const s = await this.store.getSession(sha256(token), this.now());
    return s ? { wallet: s.wallet, expiresAt: s.expiresAt } : undefined;
  }

  async logout(token: string): Promise<void> {
    await this.store.revokeSession(sha256(token), this.now());
  }
}
