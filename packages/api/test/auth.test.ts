import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { base58Decode, base58Encode } from "../src/base58.js";
import { AuthService, InMemoryAuthStore, buildApp, parseSignature, parseWallet, verifyWalletSignature } from "../src/index.js";
import { HOUR, makeRig } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

describe("base58", () => {
  it("round-trips, keeps leading zeros, and rejects bad characters", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 255, 254, 0, 9]);
    expect([...base58Decode(base58Encode(bytes))!]).toEqual([...bytes]);
    expect(base58Encode(Uint8Array.from([0, 0]))).toBe("11");
    expect(base58Decode("0OIl")).toBeUndefined();
    expect(base58Encode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV"); // known vector
  });
});

describe("wallet signature verification", () => {
  it("accepts a valid ed25519 signature (base58 or base64) and rejects forgeries", () => {
    const w = newWallet();
    const other = newWallet();
    expect(parseWallet(w.address)).toHaveLength(32);
    expect(verifyWalletSignature(w.address, "msg", w.signMessage("msg"))).toBe(true);
    expect(verifyWalletSignature(w.address, "msg", w.signMessage("msg", "base64"))).toBe(true);
    expect(verifyWalletSignature(w.address, "other", w.signMessage("msg"))).toBe(false);
    expect(verifyWalletSignature(other.address, "msg", w.signMessage("msg"))).toBe(false);
  });

  it("never throws on junk input", () => {
    const w = newWallet();
    expect(verifyWalletSignature("not-a-wallet", "m", "x")).toBe(false);
    expect(verifyWalletSignature(w.address, "m", "")).toBe(false);
    expect(verifyWalletSignature(w.address, "m", "!!!!")).toBe(false);
    expect(parseWallet("short")).toBeUndefined();
    expect(parseSignature("abc")).toBeUndefined();
  });
});

describe("AuthService", () => {
  it("issues a single-use nonce and a session, and logs out", async () => {
    let t = 1_000_000;
    const auth = new AuthService({ now: () => t, domain: "garuda.test" });
    const w = newWallet();
    const n = await auth.issueNonce(w.address);
    expect(n.message).toContain(n.nonce);
    expect(n.message).toContain(w.address);
    expect(n.message).toContain("garuda.test");
    const s = await auth.verify({ wallet: w.address, nonce: n.nonce, signature: w.signMessage(n.message) });
    expect((await auth.authenticate(s.token))?.wallet).toBe(w.address);
    await expect(auth.verify({ wallet: w.address, nonce: n.nonce, signature: w.signMessage(n.message) })).rejects.toMatchObject({ code: "invalid_nonce" });
    await auth.logout(s.token);
    expect(await auth.authenticate(s.token)).toBeUndefined();
    t += 1;
  });

  it("stores only a hash of the session token", async () => {
    const store = new InMemoryAuthStore();
    const auth = new AuthService({ store });
    const w = newWallet();
    const n = await auth.issueNonce(w.address);
    const s = await auth.verify({ wallet: w.address, nonce: n.nonce, signature: w.signMessage(n.message) });
    expect(await store.getSession(s.token, Date.now())).toBeUndefined(); // the raw token is not a key
  });

  it("expires nonces and sessions", async () => {
    let t = 1_000_000;
    const auth = new AuthService({ now: () => t, nonceTtlMs: 60_000, sessionTtlMs: HOUR });
    const w = newWallet();
    const n1 = await auth.issueNonce(w.address);
    t += 61_000;
    await expect(auth.verify({ wallet: w.address, nonce: n1.nonce, signature: w.signMessage(n1.message) })).rejects.toMatchObject({ code: "invalid_nonce" });
    const n2 = await auth.issueNonce(w.address);
    const s = await auth.verify({ wallet: w.address, nonce: n2.nonce, signature: w.signMessage(n2.message) });
    t += HOUR + 1;
    expect(await auth.authenticate(s.token)).toBeUndefined();
  });

  it("burns the nonce even when the signature is wrong", async () => {
    const auth = new AuthService();
    const w = newWallet();
    const attacker = newWallet();
    const n = await auth.issueNonce(w.address);
    await expect(auth.verify({ wallet: w.address, nonce: n.nonce, signature: attacker.signMessage(n.message) })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(auth.verify({ wallet: w.address, nonce: n.nonce, signature: w.signMessage(n.message) })).rejects.toMatchObject({ code: "invalid_nonce" });
  });

  it("a nonce issued to one wallet cannot be used by another", async () => {
    const auth = new AuthService();
    const a = newWallet();
    const b = newWallet();
    const n = await auth.issueNonce(a.address);
    await expect(auth.verify({ wallet: b.address, nonce: n.nonce, signature: b.signMessage(n.message) })).rejects.toMatchObject({ code: "invalid_nonce" });
  });

  it("rejects an invalid wallet address", async () => {
    await expect(new AuthService().issueNonce("nope")).rejects.toMatchObject({ code: "invalid_wallet" });
  });
});

describe("HTTP: sign-in and ownership", () => {
  let app: FastifyInstance;
  let rig: ReturnType<typeof makeRig>;
  beforeEach(() => {
    rig = makeRig({ requireWalletForDemo: true });
    app = buildApp({ service: rig.svc, auth: new AuthService({ now: () => rig.clock.t }), rateLimits: false });
  });

  it("requires a session on every account route, but not on health or rules", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/rules" })).statusCode).toBe(200);
    for (const [method, url] of [["GET", "/challenges"], ["POST", "/challenges"], ["GET", "/challenges/x"], ["POST", "/challenges/x/orders"], ["GET", "/auth/me"]] as const) {
      const r = await app.inject({ method, url, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      expect(r.json().error).toBe("unauthorized");
    }
    expect((await app.inject({ method: "GET", url: "/challenges", headers: bearer("gr_bogus") })).statusCode).toBe(401);
  });

  it("full flow: nonce, sign, verify, create an account under the signed-in wallet", async () => {
    const w = newWallet();
    const token = await signIn(app, w);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: bearer(token) })).json().wallet).toBe(w.address);
    const created = await app.inject({ method: "POST", url: "/challenges", headers: bearer(token), payload: { tier: "knight", knight: "Sir Auth" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().wallet).toBe(w.address);
    const order = await app.inject({ method: "POST", url: `/challenges/${created.json().id}/orders`, headers: bearer(token), payload: { symbol: "SOL", side: "buy", size: 10, type: "market" } });
    expect(order.statusCode).toBe(201);
  });

  it("rejects a bad signature and a replayed nonce over HTTP", async () => {
    const w = newWallet();
    const evil = newWallet();
    const n = (await app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet: w.address } })).json();
    const bad = await app.inject({ method: "POST", url: "/auth/verify", payload: { wallet: w.address, nonce: n.nonce, signature: evil.signMessage(n.message) } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("invalid_signature");
    const n2 = (await app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet: w.address } })).json();
    const sig = w.signMessage(n2.message);
    expect((await app.inject({ method: "POST", url: "/auth/verify", payload: { wallet: w.address, nonce: n2.nonce, signature: sig } })).statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/auth/verify", payload: { wallet: w.address, nonce: n2.nonce, signature: sig } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_nonce");
  });

  it("an expired session is refused", async () => {
    const w = newWallet();
    const token = await signIn(app, w);
    rig.clock.t += 25 * HOUR;
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: bearer(token) })).statusCode).toBe(401);
  });

  it("logout revokes the token", async () => {
    const token = await signIn(app, newWallet());
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/challenges", headers: bearer(token) })).statusCode).toBe(401);
  });

  it("a wallet cannot read, trade or list another wallet's account (403), and cannot open accounts for others", async () => {
    const alice = newWallet();
    const bob = newWallet();
    const ta = await signIn(app, alice);
    const tb = await signIn(app, bob);
    const c = (await app.inject({ method: "POST", url: "/challenges", headers: bearer(ta), payload: { tier: "knight" } })).json();
    const attempts = [
      ["GET", `/challenges/${c.id}`],
      ["GET", `/challenges/${c.id}/combat-log`],
      ["POST", `/challenges/${c.id}/orders`],
      ["POST", `/challenges/${c.id}/tick`],
      ["GET", `/challenges/${c.id}/revive`],
      ["POST", `/challenges/${c.id}/revive`],
      ["POST", `/challenges/${c.id}/reactivate`],
      ["GET", `/challenges/${c.id}/payout-quote`],
    ] as const;
    for (const [method, url] of attempts) {
      const r = await app.inject({ method, url, headers: bearer(tb), payload: { symbol: "SOL", side: "buy", size: 1, type: "market" } });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe("not_owner");
    }
    expect((await app.inject({ method: "GET", url: "/challenges", headers: bearer(tb) })).json().challenges).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/challenges", headers: bearer(ta) })).json().challenges).toHaveLength(1);
    const spoof = await app.inject({ method: "POST", url: "/challenges", headers: bearer(tb), payload: { tier: "knight", wallet: alice.address } });
    expect(spoof.statusCode).toBe(403);
    expect(spoof.json().error).toBe("wallet_mismatch");
    // unknown ids stay 404 for a signed-in user
    expect((await app.inject({ method: "GET", url: "/challenges/nope", headers: bearer(tb) })).statusCode).toBe(404);
  });

  it("applies account caps and demo rules through the API", async () => {
    const w = newWallet();
    const t = await signIn(app, w);
    const make = (tier: string, stage?: string) => app.inject({ method: "POST", url: "/challenges", headers: bearer(t), payload: { tier, stage } });
    expect((await make("ascended")).statusCode).toBe(201);
    expect((await make("ascended")).statusCode).toBe(201);
    const capped = await make("squire");
    expect(capped.statusCode).toBe(403);
    expect(capped.json().error).toBe("evaluation_cap_exceeded");
    expect((await make("demo")).statusCode).toBe(201);
    const second = await make("demo");
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("demo_exists");
  });
});

describe("sign-in message domain follows the requesting web origin", () => {
  const allowed = ["https://garuda-grok-bot.vercel.app", "http://localhost:5173"];

  it("uses the host of an allowed Origin, falls back to the default for unlisted or missing ones", async () => {
    const auth = new AuthService({ allowedOrigins: allowed });
    const w = newWallet();
    expect((await auth.issueNonce(w.address, "https://garuda-grok-bot.vercel.app")).message.split("\n")[0]).toBe("garuda-grok-bot.vercel.app wants you to sign in with your Solana account:");
    expect((await auth.issueNonce(w.address, "http://localhost:5173")).message.split("\n")[0]).toBe("localhost:5173 wants you to sign in with your Solana account:");
    expect((await auth.issueNonce(w.address, "https://evil.example")).message.split("\n")[0]).toBe("garuda wants you to sign in with your Solana account:");
    expect((await auth.issueNonce(w.address)).message.split("\n")[0]).toBe("garuda wants you to sign in with your Solana account:");
    expect(new AuthService({ allowedOrigins: "*" }).domainFor("https://any.app")).toBe("any.app");
  });

  it("over HTTP: /auth/nonce reads the Origin header and the signed message verifies", async () => {
    const rig = makeRig();
    const app = buildApp({ service: rig.svc, auth: new AuthService({ allowedOrigins: allowed }), rateLimits: false });
    const w = newWallet();
    const r = await app.inject({ method: "POST", url: "/auth/nonce", headers: { origin: "https://garuda-grok-bot.vercel.app" }, payload: { wallet: w.address } });
    const { nonce, message } = r.json() as { nonce: string; message: string };
    expect(message.startsWith("garuda-grok-bot.vercel.app wants you to sign in")).toBe(true);
    const v = await app.inject({ method: "POST", url: "/auth/verify", payload: { wallet: w.address, nonce, signature: w.signMessage(message) } });
    expect(v.statusCode).toBe(200);
    await app.close();
  });
});
