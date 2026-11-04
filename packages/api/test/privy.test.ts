import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import type { FastifyInstance } from "fastify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, PrivyServerVerifier, buildApp, solanaWalletsOf, type PrivyVerifier, type PrivyWallet } from "../src/index.js";
import { ServiceError } from "../src/service.js";
import { makeRig, HOUR } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

const APP_ID = "test-app-id-not-a-real-privy-app";
const DID = "did:privy:cm_test_user_1";

/** A mocked Privy: tokens are "ok:<did>" or invalid, wallets come from a table. No network, no real keys. */
class FakePrivy implements PrivyVerifier {
  wallets = new Map<string, PrivyWallet[]>();
  async verifyAccessToken(token: string) {
    if (!token.startsWith("ok:")) throw new ServiceError(401, "invalid_privy_token", "bad token");
    return { userId: token.slice(3), expiresAt: Date.now() + HOUR };
  }
  async solanaWallets(userId: string) {
    return this.wallets.get(userId) ?? [];
  }
}

describe("Privy sign-in over HTTP (mocked verifier)", () => {
  let app: FastifyInstance;
  let privy: FakePrivy;
  let rig: ReturnType<typeof makeRig>;
  const embedded = newWallet();
  const external = newWallet();
  const longDid = "did:privy:cm_a_long_enough_user_identifier";
  const tok = `ok:${longDid}`;

  beforeEach(() => {
    privy = new FakePrivy();
    privy.wallets.set(longDid, [
      { address: embedded.address, embedded: true },
      { address: external.address, embedded: false },
    ]);
    rig = makeRig({ requireWalletForDemo: true });
    app = buildApp({ service: rig.svc, auth: new AuthService({ now: () => rig.clock.t, privy }), rateLimits: false });
  });

  const post = (payload: object) => app.inject({ method: "POST", url: "/auth/privy", payload });

  it("exchanges a valid Privy token for a session on the embedded wallet and /auth/me reflects it", async () => {
    const r = await post({ accessToken: tok });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.wallet).toBe(embedded.address);
    expect(s.embedded).toBe(true);
    expect(s.token).toMatch(/^gr_/);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: bearer(s.token) })).json().wallet).toBe(embedded.address);
  });

  it("signs in on the chosen external wallet when it is linked", async () => {
    const s = (await post({ accessToken: tok, wallet: external.address })).json();
    expect(s.wallet).toBe(external.address);
    expect(s.embedded).toBe(false);
  });

  it("refuses a wallet that is not linked to the Privy user (403) and a bad token (401)", async () => {
    const r = await post({ accessToken: tok, wallet: newWallet().address });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("wallet_not_linked");
    const bad = await post({ accessToken: "forged-token-value-forged-token" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("invalid_privy_token");
  });

  it("409 while the embedded wallet does not exist yet", async () => {
    const r = await post({ accessToken: "ok:did:privy:brand_new_user_no_wallet" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_solana_wallet");
  });

  it("a Privy session opens, owns and pays for accounts exactly like a wallet-signature session", async () => {
    const s = (await post({ accessToken: tok })).json();
    const created = await app.inject({ method: "POST", url: "/challenges", headers: bearer(s.token), payload: { tier: "knight" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().wallet).toBe(embedded.address);
    // another wallet cannot touch it
    const other = await signIn(app, newWallet());
    expect((await app.inject({ method: "GET", url: `/challenges/${created.json().id}`, headers: bearer(other) })).statusCode).toBe(403);
    // wallet spoofing is refused
    const spoof = await app.inject({ method: "POST", url: "/challenges", headers: bearer(s.token), payload: { tier: "knight", wallet: external.address } });
    expect(spoof.statusCode).toBe(403);
    expect(spoof.json().error).toBe("wallet_mismatch");
    // the session expires like any other
    rig.clock.t += 25 * HOUR;
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: bearer(s.token) })).statusCode).toBe(401);
  });

  it("the wallet sign-message path still works next to Privy, and /health reports both", async () => {
    const w = newWallet();
    const t = await signIn(app, w);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: bearer(t) })).json().wallet).toBe(w.address);
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(h.authRequired).toBe(true);
    expect(h.privyAuth).toBe(true);
  });

  it("rejects malformed bodies", async () => {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ accessToken: "short" })).statusCode).toBe(400);
  });
});

describe("Privy is optional", () => {
  it("404 privy_disabled when no Privy config, and wallet sign-in is unaffected", async () => {
    const rig = makeRig();
    const app = buildApp({ service: rig.svc, auth: new AuthService({ now: () => rig.clock.t }), rateLimits: false });
    const r = await app.inject({ method: "POST", url: "/auth/privy", payload: { accessToken: "x".repeat(30) } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("privy_disabled");
    expect((await app.inject({ method: "GET", url: "/health" })).json().privyAuth).toBe(false);
    expect(await signIn(app, newWallet())).toMatch(/^gr_/);
  });

  it("the server verifier refuses to build without both the app id and secret", () => {
    expect(() => new PrivyServerVerifier({ appId: "", appSecret: "s" })).toThrow();
    expect(() => new PrivyServerVerifier({ appId: "a", appSecret: "" })).toThrow();
  });
});

describe("PrivyServerVerifier (real JWT verification with a local test key, mocked Privy REST)", () => {
  let key: KeyObject;
  let otherKey: KeyObject;
  const w = newWallet();
  const sign = (k: KeyObject, claims: JWTPayload = {}, o: { iss?: string; aud?: string; exp?: string | number; sub?: string | null } = {}) => {
    const jwt = new SignJWT({ sid: "s1", ...claims }).setProtectedHeader({ alg: "ES256", typ: "JWT" }).setIssuer(o.iss ?? "privy.io").setAudience(o.aud ?? APP_ID).setIssuedAt().setExpirationTime(o.exp ?? "1h");
    if (o.sub !== null) jwt.setSubject(o.sub ?? DID);
    return jwt.sign(k);
  };
  beforeAll(() => {
    key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  });
  /** What Privy's JWKS would give us: only the public half. */
  const verifyKey = () => createPublicKey(key);

  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return new Response(
      JSON.stringify({
        id: DID,
        linked_accounts: [
          { type: "email", address: "a@example.com" },
          { type: "wallet", chain_type: "ethereum", address: "0x0000000000000000000000000000000000000001", wallet_client_type: "privy" },
          { type: "wallet", chain_type: "solana", address: w.address, wallet_client_type: "phantom" },
          { type: "wallet", chain_type: "solana", address: "not-an-address", wallet_client_type: "privy" },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const verifier = async () => new PrivyServerVerifier({ appId: APP_ID, appSecret: "test-secret-placeholder", keyResolver: verifyKey(), fetch: fakeFetch });

  it("accepts a correctly signed token and returns the user id", async () => {
    const v = await verifier();
    const out = await v.verifyAccessToken(await sign(key));
    expect(out.userId).toBe(DID);
    expect(out.expiresAt).toBeGreaterThan(Date.now());
  });

  it.each([
    ["a token signed by another key", () => sign(otherKey)],
    ["the wrong audience (another Privy app)", () => sign(key, {}, { aud: "some-other-app" })],
    ["the wrong issuer", () => sign(key, {}, { iss: "evil.example" })],
    ["an expired token", () => sign(key, {}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["a token without a Privy user id", () => sign(key, {}, { sub: "someone" })],
    ["garbage", async () => "not.a.jwt"],
  ])("rejects %s", async (_n, make) => {
    const v = await verifier();
    await expect(v.verifyAccessToken(await make())).rejects.toMatchObject({ status: 401, code: "invalid_privy_token" });
  });

  it("reads the user's Solana wallets with the app secret (Basic auth) and ignores other chains", async () => {
    const v = await verifier();
    const wallets = await v.solanaWallets(DID);
    expect(wallets).toEqual([{ address: w.address, embedded: false }]);
    const c = calls.at(-1)!;
    expect(c.url).toBe(`https://auth.privy.io/api/v1/users/${encodeURIComponent(DID)}`);
    expect(c.headers["privy-app-id"]).toBe(APP_ID);
    expect(c.headers.authorization).toBe(`Basic ${Buffer.from(`${APP_ID}:test-secret-placeholder`).toString("base64")}`);
  });

  it("maps Privy REST failures to 502 privy_unavailable", async () => {
    const down = new PrivyServerVerifier({ appId: APP_ID, appSecret: "s", keyResolver: verifyKey(), fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await expect(down.solanaWallets(DID)).rejects.toMatchObject({ status: 502, code: "privy_unavailable" });
    const denied = new PrivyServerVerifier({ appId: APP_ID, appSecret: "s", keyResolver: verifyKey(), fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
    await expect(denied.solanaWallets(DID)).rejects.toMatchObject({ status: 502, code: "privy_unavailable" });
  });

  it("end to end: real verifier behind the HTTP route", async () => {
    const rig = makeRig({ requireWalletForDemo: true });
    const app = buildApp({ service: rig.svc, auth: new AuthService({ privy: await verifier() }), rateLimits: false });
    const r = await app.inject({ method: "POST", url: "/auth/privy", payload: { accessToken: await sign(key), wallet: w.address } });
    expect(r.statusCode).toBe(200);
    expect(r.json().wallet).toBe(w.address);
    const forged = await app.inject({ method: "POST", url: "/auth/privy", payload: { accessToken: await sign(otherKey) } });
    expect(forged.statusCode).toBe(401);
  });
});

describe("solanaWalletsOf", () => {
  it("dedupes, drops non-Solana and invalid addresses, lists embedded first", () => {
    const a = newWallet().address;
    const b = newWallet().address;
    expect(
      solanaWalletsOf([
        { type: "wallet", chain_type: "solana", address: a, wallet_client_type: "solflare" },
        { type: "wallet", chain_type: "solana", address: a },
        { type: "wallet", chain_type: "solana", address: b, wallet_client_type: "privy" },
        { type: "wallet", chain_type: "ethereum", address: "0xabc" },
        { type: "email", address: "x@y.z" },
      ]),
    ).toEqual([
      { address: b, embedded: true },
      { address: a, embedded: false },
    ]);
  });
});
