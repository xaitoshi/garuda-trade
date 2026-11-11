import { describe, expect, it } from "vitest";
import { FakeKnights, FakeUsdc, usdToBaseUnits } from "@garuda/chain";
import { createTestDb } from "@garuda/db";
import { InMemoryOrderStore, PaymentRequiredProvider, PgOrderStore, PurchaseService, ServiceError, buildApp, type OrderStore } from "../src/index.js";
import { HOUR, breach, makeRig } from "./helpers.js";
import { bearer, newWallet, signIn } from "./http-helpers.js";

const A = "WalletA1111111111111111111111111111111111111";
const B = "WalletB1111111111111111111111111111111111111";

function shop(o: { store?: OrderStore; enforceGating?: boolean } = {}) {
  const knights = new FakeKnights();
  const usdc = new FakeUsdc();
  const rig = makeRig({ knights, enforceGating: o.enforceGating ?? false, requirePayment: true, payments: new PaymentRequiredProvider() });
  const purchases = new PurchaseService({ service: rig.svc, usdc, store: o.store, now: () => rig.clock.t });
  let n = 0;
  /** The payer "sends" the quoted amount (or a custom amount) and gets a signature. */
  const pay = (q: { reference: string; amountBaseUnits: string }, wallet = A, over: Partial<Parameters<FakeUsdc["addPayment"]>[0]> = {}) =>
    usdc.addPayment({ signature: `sig${++n}`.padEnd(88, "x"), wallet, reference: q.reference, amountBaseUnits: BigInt(q.amountBaseUnits), at: rig.clock.t, ...over });
  return { ...rig, knights, usdc, purchases, pay };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return `${e.status}:${e.code}`;
    throw e;
  }
  return "ok";
};

describe("challenge purchase", () => {
  it("quotes the rulebook fee in exact USDC base units", async () => {
    const s = shop();
    const fees = { squire: 119, knight: 275, paladin: 499, ascended: 899 } as const;
    for (const [tier, usd] of Object.entries(fees)) {
      const q = await s.purchases.quoteChallenge({ wallet: A, tier: tier as keyof typeof fees });
      expect(q).toMatchObject({ amountUsd: usd, amountBaseUnits: String(usd * 1_000_000), mint: s.usdc.mint, treasury: s.usdc.treasury, cluster: "devnet" });
      expect(q.reference.length).toBeGreaterThan(30);
    }
  });

  it("pay, verify, mint, open: the whole path", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    const out = await s.purchases.confirm(q.orderId, { signature: sig, wallet: A });
    expect(out.status).toBe("fulfilled");
    const o = out.order;
    expect(o.knightId).toBeDefined();
    expect(await s.knights.get(o.knightId!)).toMatchObject({ owner: A, level: "squire", frozen: true });
    const ch = await s.svc.getState(o.challengeId!, { refresh: false });
    expect(ch).toMatchObject({ tier: "squire", wallet: A, knightId: o.knightId });
  });

  it("confirm is idempotent: a replay returns the same account and mints nothing new", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    const a = await s.purchases.confirm(q.orderId, { signature: sig });
    const b = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(b.order.challengeId).toBe(a.order.challengeId);
    expect(s.knights.mintCalls).toBe(1);
    expect(await s.svc.list({ wallet: A })).toHaveLength(1);
  });

  it("concurrent confirms open exactly one account", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    const outs = await Promise.all([1, 2, 3, 4].map(() => s.purchases.confirm(q.orderId, { signature: sig })));
    expect(new Set(outs.map((o) => o.order.challengeId)).size).toBe(1);
    expect(s.knights.mintCalls).toBe(1);
  });

  it("a transfer cannot pay for two orders (replay)", async () => {
    const s = shop();
    const q1 = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const q2 = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q1);
    await s.purchases.confirm(q1.orderId, { signature: sig });
    // the same signature offered for the second order: the reference does not match, and the signature is taken
    expect(await err(s.purchases.confirm(q2.orderId, { signature: sig }))).toBe("409:signature_reused");
  });

  it("a different signature for an already-paid order is refused", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    await s.purchases.confirm(q.orderId, { signature: s.pay(q) });
    const q2 = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const other = s.pay(q2);
    s.usdc.payments.get(other)!.reference = q.reference;
    expect(await err(s.purchases.confirm(q.orderId, { signature: other }))).toBe("409:order_already_paid");
  });

  it("rejects underpayment, a wrong payer, a wrong reference, a failed tx and an old tx; the order stays payable", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "knight" });
    const under = s.pay(q, A, { amountBaseUnits: usdToBaseUnits(274.99) });
    expect(await err(s.purchases.confirm(q.orderId, { signature: under }))).toBe("402:payment_underpaid");
    expect(await err(s.purchases.confirm(q.orderId, { signature: s.pay(q, B) }))).toBe("402:payment_payer_not_signer");
    expect(await err(s.purchases.confirm(q.orderId, { signature: s.pay({ ...q, reference: "someoneElsesReference1111111111111111111111" }) }))).toBe("402:payment_reference_missing");
    expect(await err(s.purchases.confirm(q.orderId, { signature: s.pay(q, A, { failed: true }) }))).toBe("402:payment_transaction_failed");
    expect(await err(s.purchases.confirm(q.orderId, { signature: s.pay(q, A, { at: s.clock.t - 3 * HOUR }) }))).toBe("402:payment_too_old");
    expect(s.knights.mintCalls).toBe(0);
    expect((await s.purchases.confirm(q.orderId, { signature: s.pay(q) })).status).toBe("fulfilled");
  });

  it("a transfer the RPC cannot see yet is pending (202), then confirms", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = "notyetvisible".padEnd(88, "z");
    expect((await s.purchases.confirm(q.orderId, { signature: sig })).status).toBe("pending");
    s.usdc.addPayment({ signature: sig, wallet: A, reference: q.reference, amountBaseUnits: BigInt(q.amountBaseUnits), at: s.clock.t });
    expect((await s.purchases.confirm(q.orderId, { signature: sig })).status).toBe("fulfilled");
  });

  it("another wallet cannot confirm someone else's order", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    expect(await err(s.purchases.confirm(q.orderId, { signature: s.pay(q), wallet: B }))).toBe("403:not_owner");
  });

  it("an expired quote is refused", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    s.clock.t += 31 * 60_000;
    expect(await err(s.purchases.confirm(q.orderId, { signature: sig }))).toBe("410:order_expired");
    expect((await s.purchases.get(q.orderId)).status).toBe("expired");
  });

  it("refunds when the mint fails after payment", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    s.knights.failMints = 1;
    const out = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(out.status).toBe("refunded");
    expect(out.order.failure).toMatch(/mint_failed/);
    expect(s.usdc.refunds.get(q.orderId)).toMatchObject({ amountBaseUnits: BigInt(q.amountBaseUnits) });
    expect(await s.svc.list({ wallet: A })).toHaveLength(0);
    // terminal: replaying the confirm never mints afterwards
    expect((await s.purchases.confirm(q.orderId, { signature: sig })).status).toBe("refunded");
    expect(s.knights.mintCalls).toBe(1);
  });

  it("refunds when the account cannot be opened after payment (cap hit between quote and pay)", async () => {
    const s = shop();
    // 20 x 10k = 200k evaluation aggregate cap
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    for (let i = 0; i < 20; i++) await s.svc.create({ tier: "squire", wallet: A }, { paid: { orderId: `x${i}`, ref: "r" } });
    const out = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(out.status).toBe("refunded");
  });

  it("a refund that fails to send is retried by reconcile, exactly once", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    s.knights.failMints = 1;
    s.usdc.failRefunds = 1;
    const out = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(out.status).toBe("refund_pending");
    expect((await s.purchases.get(q.orderId)).status).toBe("refund_failed");
    expect(await s.purchases.reconcile()).toMatchObject({ refunded: 1, stillOwed: 0 });
    expect(s.usdc.refunds.size).toBe(1);
    expect(await s.purchases.reconcile()).toMatchObject({ refunded: 0 });
  });

  it("reconcile finishes a paid order the process died on", async () => {
    const store = new InMemoryOrderStore();
    const s = shop({ store });
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const sig = s.pay(q);
    const o = (await store.get(q.orderId))!;
    await store.save({ ...o, status: "paid", signature: sig, payerTokenAccount: "ata", paidBaseUnits: o.amountBaseUnits });
    expect(await s.purchases.reconcile()).toMatchObject({ fulfilled: 1 });
    expect((await s.purchases.get(q.orderId)).status).toBe("fulfilled");
  });

  it("fails BEFORE payment when the buyer could not use the purchase (gated tier without the knight)", async () => {
    const s = shop({ enforceGating: true });
    expect(await err(s.purchases.quoteChallenge({ wallet: A, tier: "paladin" }))).toBe("403:tier_locked");
  });

  it("a Paladin purchase levels the knight the buyer holds instead of minting another", async () => {
    const s = shop({ enforceGating: true });
    const q1 = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const o1 = (await s.purchases.confirm(q1.orderId, { signature: s.pay(q1) })).order;
    // pass the squire evaluation
    await s.svc.placeOrder(o1.challengeId!, { symbol: "SOL", side: "buy", size: 960, type: "market" });
    s.market.setMove("SOL", 0.014);
    expect((await s.svc.tick(o1.challengeId!)).status).toBe("passed");
    s.market.setMove("SOL", 0);
    const q2 = await s.purchases.quoteChallenge({ wallet: A, tier: "paladin", knightAsset: o1.knightId });
    const o2 = (await s.purchases.confirm(q2.orderId, { signature: s.pay(q2) })).order;
    expect(o2.knightId).toBe(o1.knightId);
    expect(s.knights.mintCalls).toBe(1);
    expect(await s.knights.get(o1.knightId!)).toMatchObject({ tier: "paladin", frozen: true });
  });
});

describe("revive purchase", () => {
  async function wounded() {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const o = (await s.purchases.confirm(q.orderId, { signature: s.pay(q) })).order;
    await breach(s, o.challengeId!);
    s.clock.t += 25 * HOUR;
    return { s, o };
  }

  it("is 20% off the tier fee, paid through the same path, and relocks the knight", async () => {
    const { s, o } = await wounded();
    const q = await s.purchases.quoteRevive({ wallet: A, challengeId: o.challengeId! });
    expect(q).toMatchObject({ kind: "revive", listUsd: 119, discountPct: 20, amountUsd: 95.2, amountBaseUnits: "95200000" });
    const out = await s.purchases.confirm(q.orderId, { signature: s.pay(q) });
    expect(out.status).toBe("fulfilled");
    expect(out.order.challengeId).not.toBe(o.challengeId);
    expect(await s.knights.get(o.knightId!)).toMatchObject({ revives: 1, status: "active", frozen: true });
    const fresh = await s.svc.getState(out.order.challengeId!, { refresh: false });
    expect(fresh.reviveOf).toBe(o.challengeId);
    expect(out.order.amountUsd).toBe(95.2);
  });

  it("replaying the confirm never opens a second account", async () => {
    const { s, o } = await wounded();
    const q = await s.purchases.quoteRevive({ wallet: A, challengeId: o.challengeId! });
    const sig = s.pay(q);
    const a = await s.purchases.confirm(q.orderId, { signature: sig });
    const b = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(b.order.challengeId).toBe(a.order.challengeId);
    expect((await s.svc.list({ wallet: A })).length).toBe(2);
  });

  it("the legacy revive route now says payment_required instead of using the stub", async () => {
    const { s, o } = await wounded();
    expect(await err(s.svc.revive(o.challengeId!, { actorWallet: A }))).toBe("402:payment_required");
  });

  it("is refused before payment when not eligible (cooldown) or not the holder", async () => {
    const s = shop();
    const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
    const o = (await s.purchases.confirm(q.orderId, { signature: s.pay(q) })).order;
    await breach(s, o.challengeId!);
    expect(await err(s.purchases.quoteRevive({ wallet: A, challengeId: o.challengeId! }))).toBe("429:revive_cooldown");
    s.clock.t += 25 * HOUR;
    expect(await err(s.purchases.quoteRevive({ wallet: B, challengeId: o.challengeId! }))).toBe("403:not_owner");
  });

  it("refunds when the revive cannot be fulfilled (the knight was sold to someone else mid-order)", async () => {
    const { s, o } = await wounded();
    const q = await s.purchases.quoteRevive({ wallet: A, challengeId: o.challengeId! });
    const sig = s.pay(q);
    s.knights.transfer(o.knightId!, B);
    const out = await s.purchases.confirm(q.orderId, { signature: sig });
    expect(out.status).toBe("refunded");
    expect(out.order.failure).toMatch(/not_knight_owner/);
  });
});

describe("PgOrderStore", () => {
  it("persists orders, enforces the unique signature, and the flow works on it", async () => {
    const t = await createTestDb();
    try {
      const store = new PgOrderStore(t.db);
      const s = shop({ store });
      const q = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
      const sig = s.pay(q);
      expect((await s.purchases.confirm(q.orderId, { signature: sig })).status).toBe("fulfilled");
      const back = (await store.get(q.orderId))!;
      expect(back).toMatchObject({ status: "fulfilled", signature: sig, wallet: A });
      expect((await store.findBySignature(sig))!.id).toBe(q.orderId);
      const q2 = await s.purchases.quoteChallenge({ wallet: A, tier: "squire" });
      const o2 = (await store.get(q2.orderId))!;
      await expect(store.save({ ...o2, signature: sig })).rejects.toThrow("signature_taken");
      expect((await store.list({ wallet: A })).length).toBe(2);
      expect((await store.list({ status: ["pending"] })).length).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe("HTTP", () => {
  async function api() {
    const s = shop();
    const app = buildApp({ service: s.svc, purchases: s.purchases, auth: undefined, rateLimits: false, nft: { baseUrl: "http://localhost:8787", artDir: new URL("../../../art/knights", import.meta.url).pathname } });
    return { s, app };
  }

  it("quote, pay, confirm over HTTP (open mode)", async () => {
    const { s, app } = await api();
    const qr = await app.inject({ method: "POST", url: "/purchases/challenge", payload: { tier: "squire", wallet: A } });
    expect(qr.statusCode).toBe(201);
    const q = qr.json();
    const sig = s.pay(q);
    const cr = await app.inject({ method: "POST", url: `/purchases/${q.orderId}/confirm`, payload: { signature: sig } });
    expect(cr.statusCode).toBe(200);
    expect(cr.json().status).toBe("fulfilled");
    const kn = await app.inject({ method: "GET", url: `/knights?wallet=${A}` });
    expect(kn.json().knights).toHaveLength(1);
    const one = await app.inject({ method: "GET", url: `/knights/${cr.json().order.knightId}` });
    expect(one.json()).toMatchObject({ level: "squire", frozen: true });
  });

  it("202 while the transfer is not visible yet", async () => {
    const { app } = await api();
    const q = (await app.inject({ method: "POST", url: "/purchases/challenge", payload: { tier: "squire", wallet: A } })).json();
    const r = await app.inject({ method: "POST", url: `/purchases/${q.orderId}/confirm`, payload: { signature: "q".repeat(88) } });
    expect(r.statusCode).toBe(202);
  });

  it("direct POST /challenges for a paid tier is 402 with a pointer to /purchases", async () => {
    const { app } = await api();
    const r = await app.inject({ method: "POST", url: "/challenges", payload: { tier: "squire", wallet: A } });
    expect(r.statusCode).toBe(402);
    expect(r.json().detail.quote).toBe("/purchases/challenge");
    expect((await app.inject({ method: "POST", url: "/challenges", payload: { tier: "demo", wallet: A } })).statusCode).toBe(201);
  });

  it("serves metadata JSON and PNGs for the onchain URIs, and nothing else", async () => {
    const { app } = await api();
    const meta = await app.inject({ method: "GET", url: "/nft/metadata/paladin.json" });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ symbol: "KNIGHT", image: "http://localhost:8787/nft/images/knight-3.png" });
    const img = await app.inject({ method: "GET", url: "/nft/images/knight-1.png" });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    expect((await app.inject({ method: "GET", url: "/nft/images/..%2Fsecret.png" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/nft/metadata/king.json" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/nft/collection.json" })).json().name).toBe("Garuda Knights");
  });

  it("with sign-in: purchases need a session, are bound to the wallet, and revive rights follow the knight", async () => {
    const knights = new FakeKnights();
    const usdc = new FakeUsdc();
    const rig = makeRig({ knights, requirePayment: true, payments: new PaymentRequiredProvider() });
    const { AuthService, InMemoryAuthStore } = await import("../src/index.js");
    const auth = new AuthService({ store: new InMemoryAuthStore(), now: () => rig.clock.t, domain: "garuda.test" } as never);
    const purchases = new PurchaseService({ service: rig.svc, usdc, now: () => rig.clock.t });
    const app = buildApp({ service: rig.svc, purchases, auth, rateLimits: false });
    expect((await app.inject({ method: "POST", url: "/purchases/challenge", payload: { tier: "squire" } })).statusCode).toBe(401);
    const w = newWallet();
    const tok0 = await signIn(app, w);
    const bad = await app.inject({ method: "POST", url: "/purchases/challenge", headers: bearer(tok0), payload: { tier: "squire", wallet: A } });
    expect(bad.statusCode).toBe(403);
    const q = (await app.inject({ method: "POST", url: "/purchases/challenge", headers: bearer(tok0), payload: { tier: "squire" } })).json();
    usdc.addPayment({ signature: "s".repeat(88), wallet: w.address, reference: q.reference, amountBaseUnits: BigInt(q.amountBaseUnits), at: rig.clock.t });
    const done = await app.inject({ method: "POST", url: `/purchases/${q.orderId}/confirm`, headers: bearer(tok0), payload: { signature: "s".repeat(88) } });
    expect(done.json().status).toBe("fulfilled");
    const chId = done.json().order.challengeId;
    await breach(rig, chId);
    rig.clock.t += 25 * HOUR;
    const tok = await signIn(app, w); // sessions last 24h: sign in again
    // sold: the new holder (not the seller) may quote the revive
    const w2 = newWallet();
    const tok2 = await signIn(app, w2);
    knights.transfer(done.json().order.knightId, w2.address);
    expect((await app.inject({ method: "POST", url: "/purchases/revive", headers: bearer(tok), payload: { challengeId: chId } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/challenges/${chId}/revive`, headers: bearer(tok) })).statusCode).toBe(403);
    const rq = await app.inject({ method: "POST", url: "/purchases/revive", headers: bearer(tok2), payload: { challengeId: chId } });
    expect(rq.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/challenges/${chId}/revive`, headers: bearer(tok2) })).statusCode).toBe(200);
  });
});
