import { useCallback, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { errorText } from "./api";
import { confirmPayment, payQuote } from "./pay";
import { useSession } from "./session";
import type { PaymentInstructions, PaymentOrder } from "./types";

export type PurchaseStep = "idle" | "quote" | "wallet" | "sending" | "confirming" | "done" | "error";

export const STEP_TEXT: Record<PurchaseStep, string> = {
  idle: "",
  quote: "Getting your quote...",
  wallet: "Approve the USDC transfer in your wallet...",
  sending: "Sending USDC...",
  confirming: "Waiting for the network to confirm...",
  done: "Paid",
  error: "",
};

/** Quote -> pay USDC -> confirm. Resolves with the fulfilled order; throws a readable Error when it fails or is refunded. */
export function usePurchase() {
  const { connection } = useConnection();
  const { health, paySigner } = useSession();
  const [step, setStep] = useState<PurchaseStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<PaymentInstructions | null>(null);

  const run = useCallback(
    async (getQuote: () => Promise<PaymentInstructions>): Promise<PaymentOrder> => {
      setError(null);
      setStep("quote");
      try {
        const q = await getQuote();
        setQuote(q);
        const sig = await payQuote(q, { signer: paySigner, connection, stub: health?.chain === "stub" }, (s) => setStep(s));
        setStep("confirming");
        const out = await confirmPayment(q.orderId, sig);
        if (out.status === "refunded" || out.status === "refund_pending") {
          throw new Error(out.order.failure ? `Payment could not be completed (${out.order.failure.replace(/_/g, " ")}). ${out.status === "refunded" ? "You were refunded." : "A refund is on its way."}` : "Payment could not be completed. A refund is on its way.");
        }
        setStep("done");
        return out.order;
      } catch (e) {
        const msg = /reject|declin|denied/i.test(errorText(e)) ? "You declined the transfer in your wallet." : errorText(e);
        setError(msg);
        setStep("error");
        throw new Error(msg);
      }
    },
    [paySigner, connection, health?.chain],
  );
  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setQuote(null);
  }, []);
  return { run, step, error, quote, reset, busy: step !== "idle" && step !== "done" && step !== "error" };
}
