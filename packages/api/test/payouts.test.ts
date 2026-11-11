import { describe, expect, it } from "vitest";
import { FakePayoutExecutor } from "@garuda/chain";
import { PayoutService, ServiceError, type Payout } from "../src/index.js";
import { DAY, HOUR, breach, passEvaluation } from "./helpers.js";
import { WALLET_A, WALLET_B, earn, fundedAccount, makePayoutRig } from "./payout-helpers.js";

const SMALL = { size: 10 }; // about $45 of profit, $36 to the trader: above the $20 minimum, under the $500 ceiling
const BIG = { size: 1000 }; // about $4,500 of profit: above the auto-approve ceiling

async function failsWith(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => undefined,
    (x) => x as ServiceError,
  );
  expect(e, `expected ${code}`).toBeInstanceOf(ServiceError);
  expect(e!.code).toBe(code);
  return e!;
}

const events = async (rig: ReturnType<typeof makePayoutRig>, id: string) => (await rig.store.events(id)).map((e) => e.type);

describe("payout request", () => {
  it("pays an auto-approved payout: sweep, executor send, ledger, balance reset", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, SMALL);
    const gross = bal - 10_000;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "req-0000001" });
    expect(out).toMatchObject({ status: "approved", destination: WALLET_A, needsApproval: false, split: 0.8 });
    expect(out.amountUsd).toBeCloseTo(Math.floor(gross * 0.8 * 100) / 100, 2);
    await rig.payouts.idle();

    const p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "paid", debited: true, autoApproved: true, executor: "fake-treasury", attempts: 1 });
    expect(p.signature).toBe(`fakesig_${p.id}`);
    expect(rig.exec.sent.get(p.id)).toMatchObject({ destination: WALLET_A, amountBaseUnits: BigInt(Math.round(p.amountUsd * 1e6)) });
    expect(await events(rig, p.id)).toEqual(["requested", "debited", "approved", "attempt", "paid"]);

    const st = await rig.svc.getState(f.id);
    expect(st.account.balance).toBe(10_000);
    expect(st.account.paidOut).toBeCloseTo(gross, 6);
    expect(st.status).toBe("active");
    expect(st.combatLog.some((c) => c.kind === "tribute")).toBe(true);
  });

  it("the share is rounded down to the cent and the firm keeps the rest of the swept profit", async () => {
    const rig = makePayoutRig({ deps: { payoutPolicy: { split: 0.9, minUsd: 20, autoMaxUsd: 500, bestDayMaxShare: 1 } } });
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    const p = await rig.payouts.get(out.id);
    expect(p.split).toBe(0.9);
    expect(p.amountUsd).toBe(Math.floor((bal - 10_000) * 0.9 * 100) / 100);
    expect(p.amountUsd + p.firmShareUsd).toBeCloseTo(bal - 10_000, 8);
    expect(Number.isInteger(Number(p.amountBaseUnits))).toBe(true);
    await rig.payouts.idle();
  });

  it("is idempotent per Idempotency-Key: the replay returns the first payout and sends nothing new", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const a = await rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "same-key-0001" });
    await rig.payouts.idle();
    const b = await rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "same-key-0001" });
    expect(b).toMatchObject({ id: a.id, replayed: true, status: "paid" });
    expect(rig.exec.submitCalls).toBe(1);
    expect((await rig.payouts.list({ challengeId: f.id })).length).toBe(1);
    // the same key on another account is refused, not replayed
    const g = await fundedAccount(rig, WALLET_A, "squire");
    await failsWith(rig.payouts.request(g.id, { actorWallet: WALLET_A, idempotencyKey: "same-key-0001" }), "idempotency_key_reused");
  });

  it("concurrent requests with the same key create exactly one payout", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const rs = await Promise.allSettled([1, 2, 3, 4].map(() => rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "race-key-0001" })));
    await rig.payouts.idle();
    const ok = rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(new Set(ok).size).toBe(1);
    expect((await rig.payouts.list({ challengeId: f.id })).length).toBe(1);
    expect(rig.exec.sent.size).toBe(1);
  });

  it("refuses a second request while one is open (409 payout_in_flight), including without a key", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, BIG);
    const a = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect(a.status).toBe("pending_approval");
    const e = await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_in_flight");
    expect(e.status).toBe(409);
    expect(e.detail).toMatchObject({ payoutId: a.id });
  });

  it("after a paid payout the account can earn and be paid again", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_not_eligible"); // nothing left
    await earn(rig, f.id, SMALL);
    const second = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    expect((await rig.payouts.get(second.id)).status).toBe("paid");
    expect((await rig.svc.getState(f.id)).account.paidOut).toBeGreaterThan(80);
  });

  it("enforces the rules: profit above the minimum, flat book, funded, not breached, not demo", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const none = await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_not_eligible");
    expect(none.detail).toMatchObject({ reason: "no_profit" });

    await earn(rig, f.id, { size: 1, move: 0.01 }); // well under $20 of share
    expect((await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_not_eligible")).detail).toMatchObject({ reason: "below_minimum" });

    await earn(rig, f.id, SMALL);
    await rig.svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect((await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_not_eligible")).detail).toMatchObject({ reason: "open_positions" });

    const e = await rig.svc.create({ tier: "knight", wallet: WALLET_A });
    await failsWith(rig.payouts.request(e.id, { actorWallet: WALLET_A }), "payouts_unavailable");
    const d = await rig.svc.create({ tier: "demo", wallet: WALLET_B });
    await failsWith(rig.payouts.request(d.id, { actorWallet: WALLET_B }), "payouts_unavailable");
    expect(rig.exec.submitCalls).toBe(0);
    expect(await rig.payouts.list()).toEqual([]);
  });

  it("a breached account has no payout, and a failed request leaves the balance alone", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, SMALL);
    await breach(rig, f.id, 1000);
    await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payouts_unavailable");
    expect(bal).toBeGreaterThan(10_000);
    expect(await rig.payouts.list()).toEqual([]);
  });

  it("the destination is the signed-in wallet and it must be a Solana address", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    await failsWith(rig.payouts.request(f.id, { actorWallet: "not-a-wallet" }), "bad_destination");
    await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A, idempotencyKey: "short" }), "bad_idempotency_key");
    // open dev mode (no signed-in wallet): falls back to the account's wallet
    const out = await rig.payouts.request(f.id, {});
    expect(out.destination).toBe(WALLET_A);
    await rig.payouts.idle();
  });

  it("a payout request counts as activity and wakes a dormant funded account", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    rig.clock.t += 91 * DAY;
    await rig.svc.sweepLifecycle();
    expect((await rig.svc.getState(f.id, { refresh: false })).lifecycle).toBe("dormant");
    await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    expect((await rig.svc.getState(f.id, { refresh: false })).lifecycle).toBe("active");
  });
});

describe("the sweep does not trip the risk rules", () => {
  it("a payout after a profitable day is not a daily loss, and a real loss afterwards still breaches", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, BIG); // +$4.5k, SOD still 25k today
    rig.clock.t += DAY; // next UTC day: SOD becomes about 29.5k, floor about 28.6k
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.approve(out.id);
    await rig.payouts.idle();
    const st = await rig.svc.getState(f.id);
    expect(st.status).toBe("active");
    expect(st.account.balance).toBe(10_000);
    expect(st.risk.status).toBe("active");
    // static drawdown floor unchanged: 94% of 25k
    expect(st.risk.drawdownFloor).toBe(9_400);
    expect(st.risk.startOfDayBalance).toBe(10_000);
    // and a real loss still counts
    expect((await breach(rig, f.id, 1000)).status).toBe("wounded");
  });
});

describe("approval threshold and admin", () => {
  it("an amount above GARUDA_PAYOUT_AUTO_MAX waits for an admin; approval sends it", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, BIG);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect(out).toMatchObject({ status: "pending_approval", needsApproval: true });
    await rig.payouts.idle();
    expect(rig.exec.submitCalls).toBe(0);
    // already swept: the money is reserved while it waits
    expect((await rig.svc.getState(f.id)).account.balance).toBe(10_000);

    rig.clock.t += HOUR;
    await rig.payouts.reconcile();
    expect(rig.exec.submitCalls).toBe(0); // reconcile never approves anything

    const a = await rig.payouts.approve(out.id, "alice");
    expect(a).toMatchObject({ status: "approved", approvedBy: "alice" });
    await rig.payouts.idle();
    const p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "paid", approvedBy: "alice", autoApproved: false });
    expect(await events(rig, out.id)).toEqual(["requested", "debited", "approved", "attempt", "paid"]);
    // approving again changes nothing
    await rig.payouts.approve(out.id);
    expect(rig.exec.submitCalls).toBe(1);
  });

  it("the ceiling is inclusive and configurable, 0 sends everything to review", async () => {
    const strict = makePayoutRig({ deps: { payoutPolicy: { split: 0.8, minUsd: 20, autoMaxUsd: 0, bestDayMaxShare: 1 } } });
    const f = await fundedAccount(strict);
    await earn(strict, f.id, SMALL);
    expect((await strict.payouts.request(f.id, { actorWallet: WALLET_A })).status).toBe("pending_approval");

    const loose = makePayoutRig({ deps: { payoutPolicy: { split: 0.8, minUsd: 20, autoMaxUsd: 10_000, bestDayMaxShare: 1 } } });
    const g = await fundedAccount(loose);
    await earn(loose, g.id, BIG);
    expect((await loose.payouts.request(g.id, { actorWallet: WALLET_A })).status).toBe("approved");
    await loose.payouts.idle();
  });

  it("reject returns the profit to the account (reversal entry) and frees the account to request again", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, BIG);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await failsWith(rig.payouts.reject(out.id, "  "), "reason_required");
    const r = await rig.payouts.reject(out.id, "under review", "alice");
    expect(r).toMatchObject({ status: "rejected", rejectedReason: "under review", rejectedBy: "alice" });
    expect(await events(rig, out.id)).toEqual(["requested", "debited", "rejected", "reversed"]);
    const st = await rig.svc.getState(f.id);
    expect(st.account.balance).toBeCloseTo(bal, 6);
    expect(st.account.paidOut).toBeCloseTo(0, 6);
    expect(rig.exec.submitCalls).toBe(0);
    // idempotent
    await rig.payouts.reject(out.id, "again");
    expect((await rig.svc.getState(f.id)).account.balance).toBeCloseTo(bal, 6);
    // and the trader may ask again
    const again = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect(again.status).toBe("pending_approval");
    await failsWith(rig.payouts.approve(out.id), "payout_not_approvable");
  });

  it("a paid payout cannot be rejected", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    await failsWith(rig.payouts.reject(out.id, "too late"), "already_paid");
  });

  it("unknown payout ids are 404", async () => {
    const rig = makePayoutRig();
    await failsWith(rig.payouts.approve("po_nope"), "payout_not_found");
    await failsWith(rig.payouts.reject("po_nope", "x"), "payout_not_found");
    await failsWith(rig.payouts.get("po_nope"), "payout_not_found");
  });
});

describe("retries and reconcile", () => {
  it("a retryable failure backs off exponentially and then pays, never sending twice", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    rig.exec.failNext = 2;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    let p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "approved", attempts: 1, lastErrorCode: "rpc_error" });
    expect(p.nextAttemptAt).toBe(rig.clock.t + 30_000);
    expect((await rig.payouts.list({ wallet: WALLET_A }))[0]).toBeDefined();

    // too early: nothing happens
    rig.clock.t += 10_000;
    await rig.payouts.reconcile();
    expect(rig.exec.submitCalls).toBe(1);

    rig.clock.t += 21_000;
    await rig.payouts.reconcile();
    p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "approved", attempts: 2 });
    expect(p.nextAttemptAt).toBe(rig.clock.t + 60_000); // doubled

    rig.clock.t += 61_000;
    const r = await rig.payouts.reconcile();
    expect(r.paid).toBe(1);
    p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "paid", attempts: 3, lastError: undefined });
    expect(rig.exec.sent.size).toBe(1);
    expect(await events(rig, out.id)).toEqual(["requested", "debited", "approved", "attempt", "attempt_failed", "attempt", "attempt_failed", "attempt", "paid"]);
  });

  it("gives up after max attempts and parks as failed; admin retry pays it", async () => {
    const rig = makePayoutRig({ payouts: { retry: { maxAttempts: 3, baseMs: 1000, maxMs: 5000 } } });
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    rig.exec.failNext = 99;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    for (let i = 0; i < 5; i++) {
      rig.clock.t += 10_000;
      await rig.payouts.reconcile();
    }
    const p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "failed", attempts: 3 });
    expect((await events(rig, out.id)).slice(-2)).toEqual(["attempt_failed", "gave_up"]);
    expect(rig.errors.some((e) => e.includes("needs an admin"))).toBe(true);
    // still reserved, still one open payout, no more automatic tries
    expect((await rig.svc.getState(f.id)).account.balance).toBe(10_000);
    await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_A }), "payout_in_flight");
    const calls = rig.exec.submitCalls;
    rig.clock.t += DAY;
    await rig.payouts.reconcile();
    expect(rig.exec.submitCalls).toBe(calls);

    rig.exec.failNext = 0;
    await rig.payouts.retryNow(out.id, "alice");
    await rig.payouts.idle();
    expect((await rig.payouts.get(out.id)).status).toBe("paid");
    await failsWith(rig.payouts.retryNow(out.id), "payout_not_retryable");
  });

  it("a non-retryable error parks the payout immediately; admin can reject and get the profit back", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, SMALL);
    rig.exec.failHardNext = 1;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    expect(await rig.payouts.get(out.id)).toMatchObject({ status: "failed", attempts: 1, lastErrorCode: "bad_destination" });
    await rig.payouts.reject(out.id, "destination is not usable");
    expect((await rig.svc.getState(f.id)).account.balance).toBeCloseTo(bal, 6);
    expect(rig.exec.sent.size).toBe(0);
  });

  it("a treasury short of USDC waits without using up attempts, then pays after a top-up", async () => {
    const rig = makePayoutRig({ payouts: { retry: { maxAttempts: 2 } } });
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    rig.exec.treasury = 0n;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    for (let i = 0; i < 6; i++) {
      rig.clock.t += 61_000;
      await rig.payouts.reconcile();
    }
    let p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "approved", attempts: 0, lastErrorCode: "treasury_insufficient" });
    expect(payoutDelayed(p)).toBe(true);
    rig.exec.treasury = 10_000_000_000n;
    rig.clock.t += 61_000;
    await rig.payouts.reconcile();
    p = await rig.payouts.get(out.id);
    expect(p.status).toBe("paid");
  });

  it("a lost response: the transfer landed but the call threw. The retry finds it and does not pay again", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    rig.exec.loseResponseNext = 1;
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    let p = await rig.payouts.get(out.id);
    expect(p.status).toBe("approved");
    expect(rig.exec.sent.size).toBe(1);
    // a send error waits out the blockhash lease (180s), not just the 30s backoff
    expect(p.nextAttemptAt).toBe(rig.clock.t + 180_000);
    rig.clock.t += 30_000;
    await rig.payouts.reconcile();
    expect(rig.exec.submitCalls).toBe(1);
    rig.clock.t += 151_000;
    await rig.payouts.reconcile();
    p = await rig.payouts.get(out.id);
    expect(p.status).toBe("paid");
    expect(rig.exec.sent.size).toBe(1);
    expect(rig.exec.treasury).toBe(1_000_000_000_000n - BigInt(p.amountBaseUnits)); // charged once
  });

  it("a crash mid-send: the stale `sending` payout is resolved by lookup, after the lease, without a second transfer", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    // simulate the crash: the transfer is on chain, the payout row still says `sending`
    const p = await rig.payouts.get(out.id);
    const crashed: Payout = { ...p, status: "sending", signature: undefined, paidAt: undefined, sendingSince: rig.clock.t };
    await rig.store.update(crashed);
    const before = rig.exec.submitCalls;
    rig.clock.t += 60_000;
    await rig.payouts.reconcile();
    expect((await rig.payouts.get(out.id)).status).toBe("sending"); // inside the lease: left alone
    rig.clock.t += 130_000;
    await rig.payouts.reconcile();
    const after = await rig.payouts.get(out.id);
    expect(after).toMatchObject({ status: "paid", signature: `fakesig_${out.id}` });
    expect(rig.exec.submitCalls).toBe(before); // found by status(), never re-submitted
  });

  it("a crash mid-send where nothing landed: re-sent after the lease", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    rig.exec.sent.clear();
    const p = await rig.payouts.get(out.id);
    await rig.store.update({ ...p, status: "sending", signature: undefined, paidAt: undefined, sendingSince: rig.clock.t });
    rig.clock.t += 200_000;
    await rig.payouts.reconcile();
    expect((await rig.payouts.get(out.id)).status).toBe("paid");
    expect(rig.exec.sent.size).toBe(1);
  });

  it("a crash between the payout record and the sweep: reconcile finishes the debit exactly once, then pays", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    const bal = await earn(rig, f.id, SMALL);
    // what a crash leaves behind: the record exists (debited false), the account is untouched
    const quote = await rig.svc.payoutQuote(f.id, WALLET_A);
    const t = rig.clock.t;
    const amountUsd = Math.floor(quote.traderShare * 100) / 100;
    await rig.store.create(
      {
        id: "po_crash0000000000000001",
        challengeId: f.id,
        wallet: WALLET_A,
        status: "approved",
        sweepUsd: quote.grossProfit,
        amountUsd,
        amountBaseUnits: String(Math.round(amountUsd * 1e6)),
        firmShareUsd: quote.grossProfit - amountUsd,
        split: 0.8,
        autoMaxUsd: 500,
        autoApproved: true,
        debited: false,
        executor: "fake-treasury",
        attempts: 0,
        createdAt: t,
        updatedAt: t,
      },
      { type: "requested", ts: t, data: {} },
    );
    expect((await rig.svc.getState(f.id)).account.balance).toBeCloseTo(bal, 8);
    await rig.payouts.reconcile();
    await rig.payouts.reconcile();
    const p = await rig.payouts.get("po_crash0000000000000001");
    expect(p).toMatchObject({ status: "paid", debited: true });
    const st = await rig.svc.getState(f.id);
    expect(st.account.balance).toBe(10_000);
    expect(st.account.paidOut).toBeCloseTo(quote.grossProfit, 8);
    expect(await events(rig, p.id)).toEqual(["requested", "debited", "attempt", "paid"]);
  });

  it("a crash between sweep and debited-mark: the sweep is not applied twice", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    const p = await rig.payouts.get(out.id);
    await rig.store.update({ ...p, status: "approved", debited: false, signature: undefined, paidAt: undefined, attempts: 0, nextAttemptAt: undefined });
    rig.exec.sent.clear();
    await rig.payouts.reconcile();
    expect((await rig.payouts.get(out.id)).status).toBe("paid");
    expect((await rig.svc.getState(f.id)).account.paidOut).toBeCloseTo(p.sweepUsd, 8);
  });

  it("an unrecoverable debit (the profit traded away before the crash was recovered) rejects the payout without a reversal", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const quote = await rig.svc.payoutQuote(f.id, WALLET_A);
    const t = rig.clock.t;
    await rig.store.create(
      { id: "po_gone00000000000000001", challengeId: f.id, wallet: WALLET_A, status: "approved", sweepUsd: quote.grossProfit, amountUsd: 36, amountBaseUnits: "36000000", firmShareUsd: 9, split: 0.8, autoMaxUsd: 500, autoApproved: true, debited: false, executor: "fake-treasury", attempts: 0, createdAt: t, updatedAt: t },
      { type: "requested", ts: t, data: {} },
    );
    await rig.svc.placeOrder(f.id, { symbol: "SOL", side: "buy", size: 20, type: "market" });
    rig.market.setMove("SOL", -0.03);
    await rig.svc.placeOrder(f.id, { symbol: "SOL", side: "sell", size: 20, type: "market", reduceOnly: true });
    await rig.payouts.reconcile();
    expect(await rig.payouts.get("po_gone00000000000000001")).toMatchObject({ status: "rejected", rejectedBy: "system" });
    expect(rig.exec.submitCalls).toBe(0);
    expect((await rig.svc.getState(f.id)).account.paidOut).toBe(0);
  });
});

const payoutDelayed = (p: Payout) => p.status === "approved" && p.lastError !== undefined;

describe("proposal executors (the Squads path)", () => {
  it("submitted until the signers execute it, then paid; reject is refused while a proposal is outstanding", async () => {
    const exec = new FakePayoutExecutor({ name: "fake-squads", mode: "propose" });
    const rig = makePayoutRig({ exec });
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    let p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "submitted", proposalId: `fakeprop_${out.id}`, executor: "fake-squads" });

    await failsWith(rig.payouts.reject(out.id, "no"), "proposal_outstanding");
    rig.clock.t += 20_000;
    await rig.payouts.reconcile();
    expect((await rig.payouts.get(out.id)).status).toBe("submitted");
    expect(exec.submitCalls).toBe(1); // polling does not re-propose

    exec.execute(out.id);
    rig.clock.t += 20_000;
    await rig.payouts.reconcile();
    p = await rig.payouts.get(out.id);
    expect(p).toMatchObject({ status: "paid", signature: `fakeexec_${out.id}` });
    expect(await events(rig, out.id)).toEqual(["requested", "debited", "approved", "attempt", "submitted", "paid"]);
  });

  it("a proposal the signers rejected parks the payout for the admin", async () => {
    const exec = new FakePayoutExecutor({ mode: "propose" });
    const rig = makePayoutRig({ exec });
    const f = await fundedAccount(rig);
    await earn(rig, f.id, SMALL);
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    exec.rejectProposal(out.id);
    rig.clock.t += 20_000;
    await rig.payouts.reconcile();
    expect((await rig.payouts.get(out.id)).status).toBe("failed");
  });
});

describe("knights chain", () => {
  it("with knights on, only the wallet that holds the knight can request, and it is paid to that wallet", async () => {
    const { FakeKnights } = await import("@garuda/chain");
    const knights = new FakeKnights();
    const rig = makePayoutRig({ deps: { knights, enforceGating: true } });
    // an evaluation passed on a knight, then the funded account on the same knight
    const ev = await rig.svc.create({ tier: "knight", wallet: WALLET_A });
    const passed = await passEvaluation(rig, ev.id);
    expect(passed.status).toBe("passed");
    const f = await rig.svc.create({ tier: "knight", stage: "funded", wallet: WALLET_A, knightAsset: ev.knightId });
    await earn(rig, f.id, SMALL);
    await failsWith(rig.payouts.request(f.id, { actorWallet: WALLET_B }), "not_knight_owner");
    const out = await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    await rig.payouts.idle();
    expect((await rig.payouts.get(out.id)).status).toBe("paid");
  });
});

describe("PayoutService construction", () => {
  it("reports a summary for /health", async () => {
    const rig = makePayoutRig();
    const f = await fundedAccount(rig);
    await earn(rig, f.id, BIG);
    await rig.payouts.request(f.id, { actorWallet: WALLET_A });
    expect(await rig.payouts.summary()).toMatchObject({ executor: "fake-treasury", split: 0.8, minUsd: 20, autoMaxUsd: 500, open: 1, pendingApproval: 1, failed: 0 });
    expect(rig.payouts).toBeInstanceOf(PayoutService);
  });
});
