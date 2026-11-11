import { describe, expect, it } from "vitest";
import { createTestDb } from "@garuda/db";
import type { EarlyMinter, VerifyPaymentInput, VerifyPaymentResult } from "@garuda/chain";
import { EarlyAccessService, InMemoryEarlyStore, PgEarlyStore, buildApp, isSolanaAddress, normalizeEmail, type EarlyStore } from "../src/index.js";
import { makeRig } from "./helpers.js";
import { newWallet } from "./http-helpers.js";

const ADMIN = "a".repeat(32);
const TREASURY = newWallet().address;
const USDC = newWallet().address;
const sig = (n: number) => `${"5".repeat(80)}${String(n).padStart(4, "1").replace(/0/g, "2")}`.slice(0, 88);

class FakeMinter implements EarlyMinter {
  readonly cluster = "devnet" as const;
  readonly collection = newWallet().address;
  readonly authority = newWallet().address;
  minted = new Map<string, string>();
  fail = false;
  async mint(i: { claimId: string; owner: string }) {
    if (this.fail) throw new Error("rpc down");
    const asset = this.minted.get(i.claimId) ?? newWallet().address;
    if (this.assets.has(asset)) return { asset, alreadyMinted: true };
    this.minted.set(i.claimId, asset);
    this.assets.set(asset, i.owner);
    return { asset, signature: sig(this.minted.size), alreadyMinted: false };
  }
  assets = new Map<string, string>();
  /** Fake chain: "sending" the transaction (chain.pay) creates the asset. */
  async buildPaidMint(i: { claimId: string; owner: string; payer: string; reference: string }) {
    const asset = this.minted.get(i.claimId) ?? newWallet().address;
    this.minted.set(i.claimId, asset);
    this.pendingOwner.set(asset, i.owner);
    return { transaction: Buffer.from(`tx:${i.claimId}:${i.payer}`).toString("base64"), asset, blockhash: "bh", lastValidBlockHeight: 1 };
  }
  pendingOwner = new Map<string, string>();
  land(asset: string) {
    this.assets.set(asset, this.pendingOwner.get(asset)!);
  }
  async assetOwner(asset: string) {
    return this.assets.get(asset);
  }
  async balanceLamports() {
    return 200_000_000;
  }
}

/** A chain where a transfer is "visible" once its signature is registered with the expected payment fields. */
class FakeChain {
  txs = new Map<string, { reference: string; payer: string; amount: bigint }>();
  minter?: FakeMinter;
  /** The buyer's transaction lands: payment visible and (atomically) the asset exists. */
  pay(signature: string, reference: string, payer: string, amount: bigint, asset?: string) {
    this.txs.set(signature, { reference, payer, amount });
    if (asset) this.minter?.land(asset);
  }
  verify = async (i: VerifyPaymentInput): Promise<VerifyPaymentResult> => {
    const t = this.txs.get(i.signature);
    if (!t) return { status: "pending" };
    if (t.reference !== i.reference) return { status: "invalid", reason: "reference_missing" };
    if (t.payer !== i.wallet) return { status: "invalid", reason: "payer_not_signer" };
    if (t.amount < i.amountBaseUnits) return { status: "invalid", reason: "underpaid" };
    return { status: "confirmed", payerTokenAccount: newWallet().address, paidBaseUnits: t.amount, excessBaseUnits: t.amount - i.amountBaseUnits };
  };
}

function setup(o: { enabled?: boolean; store?: EarlyStore; limit?: number } = {}) {
  const clock = { t: Date.UTC(2026, 10, 11) };
  const minter = new FakeMinter();
  const chain = new FakeChain();
  chain.minter = minter;
  const early = new EarlyAccessService({
    store: o.store ?? new InMemoryEarlyStore(),
    enabled: o.enabled ?? false,
    priceUsd: 1.69,
    cluster: "devnet",
    minter: o.enabled ? minter : undefined,
    payment: o.enabled ? { mint: USDC, treasury: TREASURY, verify: chain.verify } : undefined,
    claimLimit: { limit: o.limit ?? 100, windowMs: 60_000 },
    now: () => clock.t,
  });
  const { svc } = makeRig();
  const app = buildApp({ service: svc, early, adminToken: ADMIN, rateLimits: false, now: () => clock.t });
  const claim = (wallet: string, email: string) => app.inject({ method: "POST", url: "/early/claim", payload: { wallet, email } });
  return { app, early, minter, chain, clock, claim };
}
const admin = { authorization: `Bearer ${ADMIN}` };

describe("validation", () => {
  it("accepts real Solana pubkeys only", () => {
    expect(isSolanaAddress(newWallet().address)).toBe(true);
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress("0OIl11111111111111111111111111111")).toBe(false);
    expect(isSolanaAddress("abc")).toBe(false);
    expect(isSolanaAddress("2".repeat(50))).toBe(false);
  });
  it("normalises and validates emails", () => {
    expect(normalizeEmail("  Knight@Garuda.Markets ")).toBe("knight@garuda.markets");
    for (const bad of ["no-at", "a@b", "a@b.c", "a b@c.com", "@x.com", "a@.com"]) expect(normalizeEmail(bad)).toBeUndefined();
  });
  it("rejects bad input over HTTP", async () => {
    const { claim } = setup();
    expect((await claim("nope", "a@garuda.markets")).json().error).toBe("invalid_wallet");
    expect((await claim(newWallet().address, "nope")).json().error).toBe("invalid_email");
  });
});

describe("waitlist mode (minting disabled)", () => {
  it("records a waitlist entry, takes no payment, and never returns emails publicly", async () => {
    const { claim, app } = setup();
    const w = newWallet().address;
    const r = await claim(w, "Early@Garuda.markets");
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "waitlist", alreadyOnList: false });
    expect(r.body).not.toContain("early@garuda.markets");
    const again = await claim(w, "early@garuda.markets");
    expect(again.json()).toMatchObject({ status: "waitlist", alreadyOnList: true });
    const st = (await app.inject({ method: "GET", url: "/early/status" })).json();
    expect(st).toMatchObject({ enabled: false, minted: 0, priceUsd: 1.69, waitlist: 1 });
    expect(JSON.stringify(st)).not.toContain("@");
    const confirm = await app.inject({ method: "POST", url: `/early/claim/${r.json().claimId}/confirm`, payload: { signature: sig(1) } });
    expect(confirm.json().error).toBe("minting_disabled");
    expect((await app.inject({ method: "POST", url: "/admin/early/mint-pending", headers: admin })).json().error).toBe("minting_disabled");
  });

  it("one claim per wallet and per email", async () => {
    const { claim } = setup();
    const w = newWallet().address;
    await claim(w, "one@garuda.markets");
    expect((await claim(w, "two@garuda.markets")).json().error).toBe("wallet_taken");
    expect((await claim(newWallet().address, "ONE@garuda.markets")).json().error).toBe("email_taken");
  });

  it("rate limits claims per IP", async () => {
    const { claim } = setup({ limit: 2 });
    expect((await claim(newWallet().address, "a1@garuda.markets")).statusCode).toBe(201);
    expect((await claim(newWallet().address, "a2@garuda.markets")).statusCode).toBe(201);
    const r = await claim(newWallet().address, "a3@garuda.markets");
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("admin routes need the token; admin can list (with emails) and delete unpaid rows", async () => {
    const { claim, app } = setup();
    const r = (await claim(newWallet().address, "ops@garuda.markets")).json();
    expect((await app.inject({ method: "GET", url: "/admin/early/claims" })).statusCode).toBe(401);
    const list = (await app.inject({ method: "GET", url: "/admin/early/claims", headers: admin })).json();
    expect(list.claims[0].email).toBe("ops@garuda.markets");
    expect((await app.inject({ method: "DELETE", url: `/admin/early/claims/${r.claimId}`, headers: admin })).json()).toEqual({ deleted: r.claimId });
    expect((await app.inject({ method: "GET", url: "/early/status" })).json().waitlist).toBe(0);
  });
});

describe("paid mint (minting enabled, mocked chain)", () => {
  it("returns ONE buyer-paid tx for $1.69 USDC to the treasury, verifies it, and records the mint", async () => {
    const { claim, app, chain, minter } = setup({ enabled: true });
    const w = newWallet().address;
    const payer = newWallet().address; // connected wallet pays; NFT goes to w
    const q = await app.inject({ method: "POST", url: "/early/claim", payload: { wallet: w, email: "buyer@garuda.markets", payer } });
    expect(q.statusCode).toBe(201);
    const p = q.json().payment;
    expect(p).toMatchObject({ amountUsd: 1.69, amountBaseUnits: "1690000", treasury: TREASURY, mint: USDC, wallet: w, payer });
    expect(typeof p.transaction).toBe("string");
    expect(q.body).not.toContain("buyer@garuda.markets");
    const url = `/early/claim/${p.claimId}/confirm`;
    // not visible yet
    expect((await app.inject({ method: "POST", url, payload: { signature: sig(1) } })).statusCode).toBe(202);
    // wrong reference / underpaid / wrong payer are refused
    chain.pay(sig(2), "wrongref", payer, 1_690_000n);
    expect((await app.inject({ method: "POST", url, payload: { signature: sig(2) } })).json().error).toBe("payment_reference_missing");
    chain.pay(sig(3), p.reference, payer, 1_000_000n);
    expect((await app.inject({ method: "POST", url, payload: { signature: sig(3) } })).json().error).toBe("payment_underpaid");
    chain.pay(sig(9), p.reference, newWallet().address, 1_690_000n);
    expect((await app.inject({ method: "POST", url, payload: { signature: sig(9) } })).json().error).toBe("payment_payer_not_signer");
    chain.pay(sig(4), p.reference, payer, 1_690_000n, p.asset);
    const ok = await app.inject({ method: "POST", url, payload: { signature: sig(4) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "minted", asset: p.asset, signature: sig(4), alreadyMinted: false });
    expect(ok.json().explorer).toContain(sig(4));
    // replay is idempotent; a second claim cannot reuse the payment
    expect((await app.inject({ method: "POST", url, payload: { signature: sig(4) } })).json()).toMatchObject({ status: "minted", alreadyMinted: true });
    const q2 = (await claim(newWallet().address, "second@garuda.markets")).json().payment;
    const reuse = await app.inject({ method: "POST", url: `/early/claim/${q2.claimId}/confirm`, payload: { signature: sig(4) } });
    expect(reuse.json().error).toBe("signature_reused");
    // one per wallet
    expect((await claim(w, "buyer@garuda.markets")).json()).toMatchObject({ status: "minted", alreadyMinted: true });
    expect((await claim(w, "other@garuda.markets")).json().error).toBe("wallet_taken");
    expect((await app.inject({ method: "GET", url: "/early/status" })).json()).toMatchObject({ enabled: true, minted: 1 });
    expect(minter.assets.get(p.asset)).toBe(w);
  });

  it("claiming again refreshes the tx for the same claim and asset; waitlisters can buy once minting opens", async () => {
    const store = new InMemoryEarlyStore();
    const off = setup({ store });
    const w = newWallet().address;
    const wl = (await off.claim(w, "wl@garuda.markets")).json();
    expect(wl.status).toBe("waitlist");
    const on = setup({ store, enabled: true });
    const a = (await on.claim(w, "wl@garuda.markets")).json().payment;
    const b = (await on.claim(w, "wl@garuda.markets")).json().payment;
    expect(a.claimId).toBe(wl.claimId);
    expect(b.claimId).toBe(a.claimId);
    expect(b.asset).toBe(a.asset);
    expect(b.reference).toBe(a.reference);
  });

  it("paid but asset not visible stays paid, and mint-pending records or finishes it", async () => {
    const { claim, app, chain } = setup({ enabled: true });
    const w = newWallet().address;
    const p = (await claim(w, "retry@garuda.markets")).json().payment;
    chain.pay(sig(5), p.reference, w, 1_690_000n); // asset not visible yet
    expect((await app.inject({ method: "POST", url: `/early/claim/${p.claimId}/confirm`, payload: { signature: sig(5) } })).json().status).toBe("paid");
    const r = (await app.inject({ method: "POST", url: "/admin/early/mint-pending", headers: admin })).json();
    expect(r).toMatchObject({ attempted: 1, minted: 1 });
    expect((await app.inject({ method: "DELETE", url: `/admin/early/claims/${p.claimId}`, headers: admin })).statusCode).toBe(409);
  });

  it("no supply cap: many claims mint, one per wallet and one per email; expired quotes release their email", async () => {
    const { claim, chain, app, clock } = setup({ enabled: true });
    const minted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = (await claim(newWallet().address, `many${i}@garuda.markets`)).json().payment;
      chain.pay(sig(31 + i), p.reference, p.wallet, 1_690_000n, p.asset);
      const r = (await app.inject({ method: "POST", url: `/early/claim/${p.claimId}/confirm`, payload: { signature: sig(31 + i) } })).json();
      expect(r.status, JSON.stringify(r)).toBe("minted");
      minted.push(p.wallet);
    }
    expect((await claim(minted[0]!, "other@garuda.markets")).json().error).toBe("wallet_taken");
    expect((await claim(newWallet().address, "many1@garuda.markets")).json().error).toBe("email_taken");
    await claim(newWallet().address, "hold@garuda.markets");
    clock.t += 6 * 60_000; // quote expired: the expired quote no longer holds its email
    expect((await claim(newWallet().address, "hold@garuda.markets")).json().payment).toBeTruthy();
    const st = (await app.inject({ method: "GET", url: "/early/status" })).json();
    expect(st).toMatchObject({ minted: 5 });
    expect(st).not.toHaveProperty("cap");
    expect(st).not.toHaveProperty("soldOut");
  });

  it("refuses to enable without a minter and payment config", () => {
    expect(() => new EarlyAccessService({ store: new InMemoryEarlyStore(), enabled: true, priceUsd: 1.69, cluster: "mainnet-beta" })).toThrow(/needs/);
  });
});

describe("PgEarlyStore", () => {
  it("enforces one claim per wallet and per email in the database", async () => {
    const t = await createTestDb();
    try {
      const { claim, app } = setup({ store: new PgEarlyStore(t.db) });
      const w = newWallet().address;
      expect((await claim(w, "pg@garuda.markets")).statusCode).toBe(201);
      expect((await claim(w, "pg2@garuda.markets")).json().error).toBe("wallet_taken");
      expect((await claim(newWallet().address, "PG@garuda.markets")).json().error).toBe("email_taken");
      // direct insert of a duplicate email trips the UNIQUE constraint itself
      const store = new PgEarlyStore(t.db);
      await expect(store.insert({ id: "x", wallet: newWallet().address, email: "pg@garuda.markets", status: "waitlist", createdAt: 1, updatedAt: 1 })).rejects.toThrow(/email_taken/);
      expect((await app.inject({ method: "GET", url: "/early/status" })).json().waitlist).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("paid flow round-trips through Postgres", async () => {
    const t = await createTestDb();
    try {
      const { claim, app, chain } = setup({ store: new PgEarlyStore(t.db), enabled: true });
      const w = newWallet().address;
      const p = (await claim(w, "pgpay@garuda.markets")).json().payment;
      chain.pay(sig(8), p.reference, w, 1_690_000n, p.asset);
      expect((await app.inject({ method: "POST", url: `/early/claim/${p.claimId}/confirm`, payload: { signature: sig(8) } })).json().status).toBe("minted");
      const rows = await new PgEarlyStore(t.db).list();
      expect(rows[0]).toMatchObject({ status: "minted", paymentSignature: sig(8), wallet: w, email: "pgpay@garuda.markets" });
    } finally {
      await t.close();
    }
  });
});
