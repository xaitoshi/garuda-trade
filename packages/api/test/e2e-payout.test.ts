/**
 * Opt-in end-to-end payout test on Solana DEVNET. Skipped unless DEVNET=1 (pnpm test:payout:devnet).
 *
 * The platform key at .keys/platform.json is the treasury: it must hold devnet SOL (it pays network fees and the rent of
 * the trader's token account). The test creates its own throwaway USDC mint (the platform key is its mint authority), so
 * it never touches the real configured test USDC, then runs the whole payout path with the real executor:
 *   funded account with profit -> request -> auto-approve -> treasury sends USDC -> trader token balance -> replay.
 * The trader wallet starts with NO SOL and NO USDC token account, which is the common case for a real trader.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HttpRpc,
  SolanaTreasuryPayout,
  SolanaUsdc,
  assertDevnetCluster,
  createTestMint,
  loadKeypairFile,
  mintTestTokens,
  newSigner,
  solBalance,
  tokenBalance,
  tryAirdrop,
  umiFor,
  usdToBaseUnits,
} from "@garuda/chain";
import { ReplayProvider, loadRecordedMarkets } from "@garuda/market-data";
import { ChallengeService, PayoutService } from "../src/index.js";

const devnet = process.env.DEVNET === "1";
const rpcUrl = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const KEYS = resolve(__dirname, "../../../.keys");

describe.skipIf(!devnet)("payout e2e (devnet)", () => {
  it(
    "pays a funded account's profit in USDC from the treasury, once",
    async () => {
      const rpc = new HttpRpc(rpcUrl);
      await assertDevnetCluster(rpc);
      const authority = loadKeypairFile(resolve(KEYS, "platform.json"));
      const treasury = umiFor(rpcUrl, authority);
      if ((await solBalance(treasury, authority.publicKey)) < 0.5) await tryAirdrop(treasury, authority.publicKey, 1).catch(() => {});
      const bal = await solBalance(treasury, authority.publicKey);
      if (bal < 0.05) throw new Error(`platform key ${authority.publicKey} has ${bal} SOL on devnet: fund it and rerun`);

      const out: Record<string, unknown> = { cluster: "devnet", treasury: authority.publicKey };

      // fresh test USDC, and 1000 of it in the treasury token account
      const mintKp = newSigner(treasury);
      const mint = await createTestMint(treasury, mintKp);
      out.usdcMint = mint;
      const usdc = new SolanaUsdc({ rpcUrl, rpc, mint, treasury: authority });
      await usdc.ensureTreasuryAta();
      await mintTestTokens(treasury, mint, authority.publicKey, usdToBaseUnits(1000));

      // a funded account with a realised profit, on recorded books (no network needed for the market)
      const trader = newSigner(treasury).publicKey;
      out.trader = trader;
      expect(await solBalance(treasury, trader)).toBe(0);
      expect(await tokenBalance(treasury, mint, trader)).toBe(0n);
      const market = new ReplayProvider(loadRecordedMarkets());
      const svc = new ChallengeService({ market });
      const acct = await svc.create({ tier: "knight", stage: "funded", wallet: trader });
      const buy = await svc.placeOrder(acct.id, { symbol: "SOL", side: "buy", size: 10, type: "market" });
      expect(buy.accepted).toBe(true);
      market.setMove("SOL", 0.05);
      const sell = await svc.placeOrder(acct.id, { symbol: "SOL", side: "sell", size: 10, type: "market", reduceOnly: true });
      expect(sell.accepted).toBe(true);

      const executor = new SolanaTreasuryPayout({ rpcUrl, rpc, mint, treasury: authority });
      const payouts = new PayoutService({ service: svc, executor });
      const quote = await svc.payoutQuote(acct.id, trader);
      expect(quote.eligible).toBe(true);
      expect(quote.autoApprove).toBe(true);
      const wantBase = usdToBaseUnits(Math.floor(quote.traderShare * 100) / 100);
      out.quoteUsd = quote.traderShare;

      const treasuryBefore = await tokenBalance(treasury, mint, authority.publicKey);
      const key = `e2e-payout-${Date.now()}`;
      const req = await payouts.request(acct.id, { actorWallet: trader, idempotencyKey: key });
      expect(req.status).toBe("approved");
      expect(req.destination).toBe(trader);
      await payouts.idle();

      const done = await payouts.get(req.id);
      expect(done.status).toBe("paid");
      expect(done.signature).toBeTruthy();
      out.payoutId = done.id;
      out.payoutTx = done.signature;
      out.explorer = `https://explorer.solana.com/tx/${done.signature}?cluster=devnet`;
      out.amountUsd = done.amountUsd;

      // the money really moved: trader got exactly the quoted share (their token account was created by the treasury)
      expect(await tokenBalance(treasury, mint, trader)).toBe(wantBase);
      expect(await tokenBalance(treasury, mint, authority.publicKey)).toBe(treasuryBefore - wantBase);
      expect(await solBalance(treasury, trader)).toBe(0);

      // the account was swept and reset
      const after = await svc.getState(acct.id);
      expect(after.account.balance).toBeCloseTo(after.risk.startingBalance, 2);

      // replay: same key returns the same payout and moves nothing
      const replay = await payouts.request(acct.id, { actorWallet: trader, idempotencyKey: key });
      expect(replay).toMatchObject({ id: req.id, replayed: true, status: "paid", signature: done.signature });
      // and the executor itself refuses to pay twice for the same payout id, even if asked again directly
      const again = await executor.submit({ payoutId: req.id, destination: trader, amountBaseUnits: wantBase });
      expect(again).toMatchObject({ kind: "paid", signature: done.signature, alreadySent: true });
      expect(await tokenBalance(treasury, mint, trader)).toBe(wantBase);

      // nothing left to pay out
      await expect(payouts.request(acct.id, { actorWallet: trader })).rejects.toMatchObject({ code: "payout_not_eligible" });

      console.log("E2E_RESULT " + JSON.stringify(out));
    },
    300_000,
  );
});
