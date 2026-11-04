import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { buildPaymentTx, payQuote } from "../src/lib/pay";
import { privyChain, wireTransaction } from "../src/lib/privyTx";
import type { PaySigner } from "../src/lib/session";
import type { PaymentInstructions } from "../src/lib/types";

const k = () => Keypair.generate().publicKey;
const quote = (): PaymentInstructions =>
  ({
    orderId: "ord_1",
    mint: k().toBase58(),
    treasury: k().toBase58(),
    reference: k().toBase58(),
    amountBaseUnits: "25000000",
    amountUsd: 25,
    decimals: 6,
    cluster: "devnet",
  }) as unknown as PaymentInstructions;

const connection = (balance: string | Error) =>
  ({
    getTokenAccountBalance: vi.fn(async () => {
      if (balance instanceof Error) throw balance;
      return { value: { amount: balance } };
    }),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100 })),
    confirmTransaction: vi.fn(async () => ({ value: {} })),
  }) as unknown as Connection;

describe("USDC checkout with an embedded (Privy) wallet signer", () => {
  it("pays the same transferChecked through the signer's send(), with the quote's cluster", async () => {
    const payer = k();
    const q = quote();
    const send = vi.fn(async (_tx: Transaction, _c: Connection, _cluster: string) => "5".repeat(88));
    const signer: PaySigner = { publicKey: payer, send };
    const steps: string[] = [];
    const sig = await payQuote(q, { signer, connection: connection("30000000"), stub: false }, (s) => steps.push(s));
    expect(sig).toBe("5".repeat(88));
    expect(steps).toEqual(["wallet", "confirming"]);
    const [tx, , cluster] = send.mock.calls[0]!;
    expect(cluster).toBe("devnet");
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(tx.recentBlockhash).toBeTruthy();
    // the transfer is exactly what the API verifies: transferChecked of the quoted amount, reference attached read-only
    const ix = tx.instructions[0]!;
    expect(ix.keys.at(-1)!.pubkey.toBase58()).toBe(q.reference);
    expect(ix.keys.at(-1)!.isSigner).toBe(false);
    expect(ix.data.readBigUInt64LE(1)).toBe(25_000_000n);
  });

  it("refuses with a readable message when the embedded wallet has too little USDC", async () => {
    const signer: PaySigner = { publicKey: k(), send: vi.fn() };
    await expect(payQuote(quote(), { signer, connection: connection("1000"), stub: false })).rejects.toThrow(/Not enough USDC: this needs \$25\.00 on devnet/);
    expect(signer.send).not.toHaveBeenCalled();
  });

  it("tells the user which address to fund when the wallet has no USDC account yet", async () => {
    const payer = k();
    const signer: PaySigner = { publicKey: payer, send: vi.fn() };
    await expect(payQuote(quote(), { signer, connection: connection(new Error("could not find account")), stub: false })).rejects.toThrow(payer.toBase58());
  });

  it("needs a wallet that can send", async () => {
    await expect(payQuote(quote(), { signer: { publicKey: null }, connection: connection("0"), stub: false })).rejects.toThrow(/Connect a wallet/);
    await expect(payQuote(quote(), { signer: { publicKey: k() }, connection: connection("0"), stub: false })).rejects.toThrow(/Connect a wallet/);
  });
});

describe("Privy transaction plumbing", () => {
  it("serializes the payment with empty signature slots so the embedded wallet can sign it", () => {
    const payer = k();
    const tx = buildPaymentTx(quote(), payer);
    tx.feePayer = payer;
    tx.recentBlockhash = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
    const bytes = wireTransaction(tx);
    const back = Transaction.from(bytes);
    expect(back.instructions).toHaveLength(1);
    expect(back.feePayer?.equals(payer)).toBe(true);
    expect(back.signatures[0]!.signature).toBeNull(); // unsigned: Privy signs with the wallet key
  });

  it("maps Garuda clusters to Privy chain ids", () => {
    expect(privyChain("devnet")).toBe("solana:devnet");
    expect(privyChain("testnet")).toBe("solana:testnet");
    expect(privyChain("mainnet-beta")).toBe("solana:mainnet");
    expect(privyChain("weird")).toBe("solana:devnet");
  });
});
