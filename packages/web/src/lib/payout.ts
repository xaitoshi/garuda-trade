import type { PayoutStatus, PayoutView } from "./types";

/** Devnet explorer link for a transaction signature (payouts only ever run on devnet). */
export const explorerTxUrl = (signature: string): string => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

/** Still moving: the trader cannot request another payout for this account. */
export const isOpenPayout = (p: Pick<PayoutView, "status">): boolean => p.status !== "paid" && p.status !== "rejected";

/** Plain words for a payout, including the cases where nothing is wrong but it is not instant. */
export function payoutStatusText(p: Pick<PayoutView, "status" | "needsApproval" | "delayed">): { label: string; tone: "up" | "dn" | "warn" | "dim"; hint: string } {
  const s: PayoutStatus = p.status;
  switch (s) {
    case "paid":
      return { label: "Paid", tone: "up", hint: "Sent to your wallet." };
    case "rejected":
      return { label: "Rejected", tone: "dn", hint: "Not paid. The profit was returned to your account." };
    case "pending_approval":
      return { label: "Awaiting approval", tone: "warn", hint: "Larger payouts are reviewed by Garuda before they are sent." };
    case "failed":
      return { label: "Needs attention", tone: "dn", hint: "The transfer could not be completed. Garuda has been alerted; your funds are held, not lost." };
    case "submitted":
      return { label: "Confirming", tone: "warn", hint: "Sent, waiting for the network to confirm." };
    case "approved":
    case "sending":
      return p.delayed
        ? { label: "Delayed", tone: "warn", hint: "The transfer is being retried automatically. You do not need to do anything." }
        : { label: "Sending", tone: "warn", hint: "Your USDC is on its way." };
    default:
      return { label: String(s), tone: "dim", hint: "" };
  }
}

/** The payout the account page should show as "in progress", if any (newest open one). */
export const openPayout = (payouts: PayoutView[], challengeId: string): PayoutView | undefined =>
  payouts.filter((p) => p.challengeId === challengeId && isOpenPayout(p)).sort((a, b) => b.createdAt - a.createdAt)[0];

/** Total USDC actually paid, from the settled rows only. */
export const totalPaid = (payouts: PayoutView[]): number => payouts.filter((p) => p.status === "paid").reduce((n, p) => n + p.amountUsd, 0);

/** Why a payout cannot be requested right now, in words ("" when it can). */
export function notEligibleText(q: { eligible: boolean; reason?: string } | null | undefined, minUsd: number): string {
  if (!q || q.eligible) return "";
  if (q.reason === "open_positions") return "Close all open positions to request a payout.";
  if (q.reason === "below_minimum") return `Your share is below the $${minUsd} minimum payout.`;
  return "No profit above the starting balance yet.";
}
