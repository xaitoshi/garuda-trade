/**
 * Opt-in end-to-end test against a REAL cluster. Skipped unless one of:
 *   DEVNET=1            Solana devnet (RPC from DEVNET_RPC_URL or the public endpoint). The platform keypair at
 *                       .keys/platform.json must hold devnet SOL (the devnet faucet is rate limited: see README).
 *   LOCAL_VALIDATOR=1   a local solana-test-validator on 127.0.0.1:8899 with the mpl-core program cloned from devnet
 *                       (see README). NOT devnet: it proves the same code against the real programs without a faucet.
 * Nothing here ever touches mainnet (the chain code refuses mainnet RPC URLs).
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVNET_GENESIS_HASH,
  HttpRpc,
  MetaplexCoreKnights,
  SolanaUsdc,
  assertDevnetCluster,
  createTestMint,
  fundWallet,
  loadKeypairFile,
  loadOrCreateKeypairFile,
  mintTestTokens,
  newSigner,
  payUsdc,
  solBalance,
  tokenBalance,
  transferKnight,
  tryAirdrop,
  umiFor,
  usdToBaseUnits,
  type KnightNft,
  type MintKnightInput,
} from "@garuda/chain";
import { PurchaseService, ChallengeService, PaymentRequiredProvider } from "../src/index.js";
import { ReplayProvider, loadRecordedMarkets } from "@garuda/market-data";
import { passEvaluation } from "./helpers.js";

const mode = process.env.DEVNET === "1" ? "devnet" : process.env.LOCAL_VALIDATOR === "1" ? "local" : undefined;
const rpcUrl = mode === "devnet" ? (process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com") : (process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8899");
const KEYS = resolve(__dirname, "../../../.keys");

/** Wrapper that fails the next mint (to drive the refund path on a real chain). */
class FlakyKnights implements KnightNft {
  failMints = 0;
  constructor(private readonly inner: MetaplexCoreKnights) {}
  get collection() {
    return this.inner.collection;
  }
  get = (a: string) => this.inner.get(a);
  update: KnightNft["update"] = (i) => this.inner.update(i);
  listByOwner = (o: string) => this.inner.listByOwner(o);
  async mint(i: MintKnightInput) {
    if (this.failMints > 0) {
      this.failMints--;
      throw new Error("simulated mint failure");
    }
    return this.inner.mint(i);
  }
}

describe.skipIf(!mode)(`chain e2e (${mode})`, () => {
  it(
    "collection, test USDC, pay, verify, mint, lock, level-up, unlock, transfer, refund",
    async () => {
      const authority = mode === "devnet" ? loadKeypairFile(resolve(KEYS, "platform.json")) : loadOrCreateKeypairFile(resolve(KEYS, "local-platform.json")).keypair;
      const knights0 = new MetaplexCoreKnights({ rpcUrl, authority, baseUrl: "http://localhost:8787" });
      const umi = knights0.umi;
      if (mode === "devnet") await assertDevnetCluster(new HttpRpc(rpcUrl));
      void DEVNET_GENESIS_HASH;

      // fund the platform key (devnet faucet may refuse: then say so loudly)
      if ((await solBalance(umi, authority.publicKey)) < 1) await tryAirdrop(umi, authority.publicKey, 2);
      const bal = await solBalance(umi, authority.publicKey);
      if (bal < 0.3) throw new Error(`platform key ${authority.publicKey} has ${bal} SOL on ${mode}: fund it (devnet faucet) and rerun`);

      const out: Record<string, unknown> = { mode, rpcUrl, platform: authority.publicKey };

      // collection + test USDC mint + treasury token account
      const col = await knights0.ensureCollection();
      out.collection = col.collection;
      const mintKp = newSigner(umi);
      const usdcMint = await createTestMint(umi, mintKp);
      out.usdcMint = usdcMint;
      const rpc = new HttpRpc(rpcUrl);
      const usdc = new SolanaUsdc({ rpcUrl, rpc, mint: usdcMint, treasury: authority });
      await usdc.ensureTreasuryAta();

      // a buyer wallet with SOL and USDC
      const buyerKp = newSigner(umi);
      const buyer = umiFor(rpcUrl, { publicKey: buyerKp.publicKey, secretKey: buyerKp.secretKey });
      await fundWallet(umi, buyerKp.publicKey, 0.1);
      await mintTestTokens(umi, usdcMint, buyerKp.publicKey, usdToBaseUnits(2000));
      out.buyer = buyerKp.publicKey;

      const flaky = new FlakyKnights(knights0);
      const market = new ReplayProvider(loadRecordedMarkets());
      const clock = { t: Date.now() };
      const svc = new ChallengeService({ market, now: () => clock.t, enforceGating: true, knights: flaky, requirePayment: true, payments: new PaymentRequiredProvider() });
      const shop = new PurchaseService({ service: svc, usdc });

      // ---- buy a Squire challenge
      const q = await shop.quoteChallenge({ wallet: buyerKp.publicKey, tier: "squire" });
      const paySig = await payUsdc(buyer, { mint: usdcMint, treasuryOwner: usdc.treasury, amountBaseUnits: BigInt(q.amountBaseUnits), reference: q.reference });
      out.payTx = paySig;
      const done = await shop.confirm(q.orderId, { signature: paySig, wallet: buyerKp.publicKey });
      expect(done.status).toBe("fulfilled");
      const asset = done.order.knightId!;
      out.knightAsset = asset;
      out.challengeId = done.order.challengeId;

      // replay: same account, no second mint
      const again = await shop.confirm(q.orderId, { signature: paySig });
      expect(again.order.knightId).toBe(asset);
      expect(await knights0.listByOwner(buyerKp.publicKey)).toHaveLength(1);

      // onchain facts
      let k = (await knights0.get(asset))!;
      expect(k).toMatchObject({ owner: buyerKp.publicKey, level: "squire", status: "active", wins: 0, revives: 0, frozen: true, genuine: true });
      expect(await tokenBalance(umi, usdcMint, usdc.treasury)).toBe(usdToBaseUnits(119));

      // locked: the owner cannot move it while the challenge is live
      await expect(transferKnight(buyer, asset, col.collection, authority.publicKey)).rejects.toThrow();
      expect((await knights0.get(asset))!.owner).toBe(buyerKp.publicKey);

      // the same transfer cannot pay twice
      const q2 = await shop.quoteChallenge({ wallet: buyerKp.publicKey, tier: "squire" });
      await expect(shop.confirm(q2.orderId, { signature: paySig })).rejects.toMatchObject({ code: expect.stringMatching(/signature_reused|reference_missing/) });

      // ---- pass the challenge: level up + unlock
      // Path to Funded: three days of closed profit, flat book, best-day rule met
      expect((await passEvaluation({ svc, market, clock }, done.order.challengeId!)).status).toBe("passed");
      k = (await knights0.get(asset))!;
      expect(k).toMatchObject({ level: "knight", wins: 1, status: "idle", frozen: false });
      expect(k.uri).toMatch(/knight\.json$/);
      out.afterPass = { level: k.level, wins: k.wins, frozen: k.frozen };

      // unlocked: now it can be sold
      const dest = newSigner(umi).publicKey;
      out.transferTx = await transferKnight(buyer, asset, col.collection, dest);
      expect((await knights0.get(asset))!.owner).toBe(dest);

      // ---- refund path: pay, mint fails, money goes back
      const before = await tokenBalance(umi, usdcMint, buyerKp.publicKey);
      const q3 = await shop.quoteChallenge({ wallet: buyerKp.publicKey, tier: "knight" });
      const paySig3 = await payUsdc(buyer, { mint: usdcMint, treasuryOwner: usdc.treasury, amountBaseUnits: BigInt(q3.amountBaseUnits), reference: q3.reference });
      flaky.failMints = 1;
      const r = await shop.confirm(q3.orderId, { signature: paySig3 });
      expect(r.status).toBe("refunded");
      out.refundPayTx = paySig3;
      out.refundTx = r.order.refundSignature;
      expect(await tokenBalance(umi, usdcMint, buyerKp.publicKey)).toBe(before);
      // refund is idempotent
      expect((await shop.confirm(q3.orderId, { signature: paySig3 })).order.refundSignature).toBe(r.order.refundSignature);

      console.log("E2E_RESULT " + JSON.stringify(out));
    },
    300_000,
  );
});
