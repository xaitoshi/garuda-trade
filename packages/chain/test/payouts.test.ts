import { describe, expect, it } from "vitest";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import type { Umi } from "@metaplex-foundation/umi";
import {
  FakePayoutExecutor,
  MainnetRefusedError,
  PayoutChainError,
  SolanaTreasuryPayout,
  SquadsPayoutExecutor,
  payoutReferenceKeypair,
  refundReferenceKeypair,
  type JsonRpc,
} from "../src/index.js";

const eddsa = createUmi("http://127.0.0.1:1").eddsa;
const MINT = eddsa.generateKeypair().publicKey;
const treasury = eddsa.generateKeypair();
const dest = eddsa.generateKeypair().publicKey;
const AMOUNT = 80_000_000n;

type Call = { method: string; params: unknown[] };

/** A scripted JSON-RPC: `handlers` answer by method; every call is recorded. */
function rpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const r: JsonRpc = {
    async call(method, params = []) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unscripted rpc ${method}`);
      return h(params);
    },
  };
  return { r, calls };
}

/** Replace the Umi RPC so sendAndConfirm "lands" without a network. Captures the transactions sent. */
function fakeSend(sent: Uint8Array[], opts: { failSend?: boolean } = {}) {
  return (umi: Umi) => {
    umi.rpc = {
      ...umi.rpc,
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }),
      sendTransaction: async (tx) => {
        if (opts.failSend) throw new Error("node is behind");
        sent.push(umi.transactions.serialize(tx));
        return umi.transactions.deserialize(umi.transactions.serialize(tx)).signatures[0]!;
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    };
  };
}

const balanceOf = (amount: bigint) => (): unknown => ({ value: { amount: amount.toString() } });
const tx = (movedTo: bigint, err: unknown = null) => () => ({
  meta: {
    err,
    preTokenBalances: [{ accountIndex: 3, mint: MINT, owner: dest, uiTokenAmount: { amount: "5" } }],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: dest, uiTokenAmount: { amount: (5n + movedTo).toString() } }],
  },
});

function exec(handlers: Record<string, (p: unknown[]) => unknown>, sent: Uint8Array[] = [], send: { failSend?: boolean } = {}) {
  const { r, calls } = rpc(handlers);
  const e = new SolanaTreasuryPayout({ rpcUrl: "https://api.devnet.solana.com", rpc: r, mint: MINT, treasury, configureUmi: fakeSend(sent, send) });
  return { e, calls, sent };
}

const req = { payoutId: "payout_1", destination: dest, amountBaseUnits: AMOUNT };

describe("SolanaTreasuryPayout (mocked RPC)", () => {
  it("devnet only", () => {
    expect(() => new SolanaTreasuryPayout({ rpcUrl: "https://api.mainnet-beta.solana.com", rpc: rpc({}).r, mint: MINT, treasury })).toThrow(MainnetRefusedError);
  });

  it("sends one transaction: create the trader's token account if missing, transfer, reference key attached", async () => {
    const { e, calls, sent } = exec({ getSignaturesForAddress: () => [], getTokenAccountBalance: balanceOf(1_000_000_000n) });
    const res = await e.submit(req);
    expect(res).toMatchObject({ kind: "paid", alreadySent: false });
    expect(sent).toHaveLength(1);
    const tx0 = e.umi.transactions.deserialize(sent[0]!);
    const keys = tx0.message.accounts;
    const ref = payoutReferenceKeypair(e.umi, treasury.secretKey, "payout_1").publicKey;
    expect(keys).toContain(ref);
    expect(keys).toContain(dest);
    expect(keys[0]).toBe(treasury.publicKey); // fee payer: the treasury, not the trader
    expect(tx0.message.instructions).toHaveLength(2); // createTokenIfMissing + transfer
    // the reference lookup happened before the balance check and the send
    expect(calls.map((c) => c.method)).toEqual(["getSignaturesForAddress", "getTokenAccountBalance"]);
    expect((calls[0]!.params[0] as string)).toBe(ref);
  });

  it("the payout reference is not the refund reference and is stable per payout", () => {
    const { e } = exec({});
    const a = payoutReferenceKeypair(e.umi, treasury.secretKey, "x").publicKey;
    expect(payoutReferenceKeypair(e.umi, treasury.secretKey, "x").publicKey).toBe(a);
    expect(payoutReferenceKeypair(e.umi, treasury.secretKey, "y").publicKey).not.toBe(a);
    expect(refundReferenceKeypair(e.umi, treasury.secretKey, "x").publicKey).not.toBe(a);
    expect(payoutReferenceKeypair(e.umi, eddsa.generateKeypair().secretKey, "x").publicKey).not.toBe(a);
  });

  it("does NOT send when the reference already has a successful matching transfer (retry after a lost response)", async () => {
    const { e, sent } = exec({
      getSignaturesForAddress: () => [{ signature: "failedSig", err: { InstructionError: [0, "x"] } }, { signature: "goodSig", err: null }],
      getTransaction: tx(AMOUNT),
    });
    expect(await e.submit(req)).toEqual({ kind: "paid", signature: "goodSig", alreadySent: true });
    expect(sent).toHaveLength(0);
    expect(await e.status(req)).toEqual({ kind: "paid", signature: "goodSig" });
  });

  it("a failed transaction under the reference does not count as paid: it sends", async () => {
    const { e, sent } = exec({ getSignaturesForAddress: () => [{ signature: "failedSig", err: { InstructionError: [0, "x"] } }], getTokenAccountBalance: balanceOf(AMOUNT) });
    expect(await e.submit(req)).toMatchObject({ kind: "paid", alreadySent: false });
    expect(sent).toHaveLength(1);
    expect(await exec({ getSignaturesForAddress: () => [] }).e.status(req)).toEqual({ kind: "none" });
  });

  it("a reference transfer that moved less than requested is a hard mismatch, never a quiet success", async () => {
    const { e, sent } = exec({ getSignaturesForAddress: () => [{ signature: "weird", err: null }], getTransaction: tx(1n) });
    await expect(e.submit(req)).rejects.toMatchObject({ code: "reference_mismatch", retryable: false });
    expect(sent).toHaveLength(0);
  });

  it("an unreadable found transaction is retryable, not paid", async () => {
    const { e, sent } = exec({ getSignaturesForAddress: () => [{ signature: "s", err: null }], getTransaction: () => null });
    await expect(e.submit(req)).rejects.toMatchObject({ code: "rpc_error", retryable: true });
    expect(sent).toHaveLength(0);
  });

  it("waits (retryable) when the treasury cannot cover the payout, and when its token account does not exist", async () => {
    const short = exec({ getSignaturesForAddress: () => [], getTokenAccountBalance: balanceOf(AMOUNT - 1n) });
    await expect(short.e.submit(req)).rejects.toMatchObject({ code: "treasury_insufficient", retryable: true });
    expect(short.sent).toHaveLength(0);
    const { RpcError } = await import("../src/index.js");
    const none = exec({
      getSignaturesForAddress: () => [],
      getTokenAccountBalance: () => {
        throw new RpcError("getTokenAccountBalance", -32602, "Invalid param: could not find account");
      },
    });
    await expect(none.e.submit(req)).rejects.toMatchObject({ code: "treasury_insufficient" });
  });

  it("an RPC outage on the lookup is retryable and sends nothing", async () => {
    const { e, sent } = exec({
      getSignaturesForAddress: () => {
        throw new Error("503");
      },
    });
    await expect(e.submit(req)).rejects.toMatchObject({ code: "rpc_error", retryable: true });
    expect(sent).toHaveLength(0);
  });

  it("a send that errors is retryable and the next attempt starts with the reference lookup", async () => {
    const { e, calls } = exec({ getSignaturesForAddress: () => [], getTokenAccountBalance: balanceOf(AMOUNT) }, [], { failSend: true });
    await expect(e.submit(req)).rejects.toMatchObject({ code: "send_failed", retryable: true });
    await expect(e.submit(req)).rejects.toMatchObject({ code: "send_failed" });
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("refuses a destination that is not an address, without touching the network", async () => {
    const { e, calls } = exec({});
    for (const bad of ["", "not-an-address", "0x1234", "1".repeat(50)]) {
      await expect(e.submit({ ...req, destination: bad })).rejects.toMatchObject({ code: "bad_destination", retryable: false });
    }
    await expect(e.submit({ ...req, amountBaseUnits: 0n })).rejects.toBeInstanceOf(PayoutChainError);
    expect(calls).toHaveLength(0);
  });
});

describe("SquadsPayoutExecutor (stub)", () => {
  it("is explicit that it is not implemented, and not retryable", async () => {
    const s = new SquadsPayoutExecutor(MINT);
    expect(s.name).toBe("squads");
    await expect(s.submit(req)).rejects.toMatchObject({ code: "squads_not_implemented", retryable: false });
    await expect(s.status(req)).rejects.toMatchObject({ code: "squads_not_implemented" });
  });
});

describe("FakePayoutExecutor honours the executor contract", () => {
  it("submit is idempotent per payout id", async () => {
    const f = new FakePayoutExecutor();
    const a = await f.submit(req);
    const b = await f.submit(req);
    expect(a).toMatchObject({ kind: "paid", alreadySent: false });
    expect(b).toMatchObject({ kind: "paid", alreadySent: true });
    expect(f.sent.size).toBe(1);
    expect(f.treasury).toBe(1_000_000_000_000n - AMOUNT);
  });
  it("proposal mode: pending until the signers execute", async () => {
    const f = new FakePayoutExecutor({ mode: "propose" });
    expect(await f.submit(req)).toMatchObject({ kind: "proposed" });
    expect(await f.status(req)).toMatchObject({ kind: "pending" });
    f.execute("payout_1");
    expect(await f.status(req)).toMatchObject({ kind: "paid" });
  });
});
