import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { api, ApiError } from "./api";
import type { PaySigner } from "./session";
import type { ConfirmOutcome, PaymentInstructions } from "./types";

/**
 * Build the USDC payment the API verifies: one `transferChecked` from the buyer to the treasury, with the order's
 * `reference` account attached read-only so the server can find the transaction.
 */
export function buildPaymentTx(q: PaymentInstructions, payer: PublicKey): Transaction {
  const mint = new PublicKey(q.mint);
  const treasury = new PublicKey(q.treasury);
  const from = getAssociatedTokenAddressSync(mint, payer);
  const to = getAssociatedTokenAddressSync(mint, treasury, true);
  const ix = createTransferCheckedInstruction(from, mint, to, payer, BigInt(q.amountBaseUnits), q.decimals);
  ix.keys.push({ pubkey: new PublicKey(q.reference), isSigner: false, isWritable: false });
  return new Transaction().add(ix);
}

export interface PayContext {
  /** The signed-in wallet: a Privy embedded wallet or a browser wallet. Both pay the same transferChecked. */
  signer: PaySigner;
  connection: Connection;
  /** The stub server has no chain: it registers a simulated transfer instead of the wallet sending one. */
  stub: boolean;
}

export type PayStep = "wallet" | "sending" | "confirming";

/** Pay a quote and return its signature. Throws a readable error when the wallet lacks USDC or declines. */
export async function payQuote(q: PaymentInstructions, ctx: PayContext, onStep?: (s: PayStep) => void): Promise<string> {
  if (ctx.stub) {
    onStep?.("sending");
    return (await api.stubPay(q.orderId)).signature;
  }
  const payer = ctx.signer.publicKey;
  if (!payer || !ctx.signer.send) throw new Error("Connect a wallet to pay");
  const mint = new PublicKey(q.mint);
  const from = getAssociatedTokenAddressSync(mint, payer);
  const need = BigInt(q.amountBaseUnits);
  try {
    const bal = await ctx.connection.getTokenAccountBalance(from, "confirmed");
    if (BigInt(bal.value.amount) < need) throw new Error(`Not enough USDC: this needs $${q.amountUsd.toFixed(2)} on ${q.cluster}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Not enough")) throw e;
    throw new Error(`Your wallet ${payer.toBase58()} has no ${q.cluster} USDC yet. Send USDC (mint ${q.mint.slice(0, 6)}...) and a little SOL for fees to that address, then pay again.`);
  }
  const tx = buildPaymentTx(q, payer);
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  onStep?.("wallet");
  const signature = await ctx.signer.send(tx, ctx.connection, q.cluster);
  onStep?.("confirming");
  await ctx.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

/** Ask the API to verify the payment. A 202 means the transfer is not visible yet: retry for a while. */
export async function confirmPayment(orderId: string, signature: string, tries = 20, waitMs = 1500): Promise<ConfirmOutcome> {
  let last: ConfirmOutcome | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await api.confirm(orderId, signature);
      if (last.status !== "pending") return last;
    } catch (e) {
      // 404/422 right after sending can just mean the node has not indexed it yet.
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 409 && e.status < 500)) throw e;
      if (i === tries - 1) throw e;
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (last) return last;
  throw new Error("The payment is still pending. It will complete automatically once confirmed; check Barracks in a minute.");
}
