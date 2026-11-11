import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { api, ApiError, errorText } from "../lib/api";
import { EARLY_ART, EARLY_ART_PREVIEW, EARLY_RPC } from "../lib/config";
import { useSession } from "../lib/session";
import type { EarlyOutcome, EarlyPayment, EarlyStatus } from "../lib/types";
import { XMarketsButton } from "../components/XMarkets";

const LANDING_INK = "#08090a";
const FALLBACK_PRICE = 1.69;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/;

type Done =
  | { kind: "minted"; explorer: string; asset: string; again: boolean }
  | { kind: "waitlist"; again: boolean }
  | { kind: "paid"; message: string };

const STEP: Record<string, string> = {
  claim: "Reserving your spot...",
  wallet: "Approve the USDC payment in your wallet...",
  sending: "Sending USDC...",
  confirming: "Confirming payment and minting...",
};

export function Early() {
  const { wallet: sessionWallet, paySigner, connected, privyEnabled, privyLogin } = useSession();
  const [status, setStatus] = useState<EarlyStatus | null>(null);
  const [wallet, setWallet] = useState("");
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("landing-skin");
    root.style.setProperty("--landing-ink", LANDING_INK);
    return () => {
      root.classList.remove("landing-skin");
      root.style.removeProperty("--landing-ink");
    };
  }, []);

  useEffect(() => {
    let live = true;
    api.earlyStatus().then((s) => live && setStatus(s), () => undefined);
    return () => {
      live = false;
    };
  }, [done]);

  const connectedAddr = sessionWallet ?? paySigner.publicKey?.toBase58() ?? null;
  const enabled = status?.enabled ?? false;
  const price = status?.priceUsd ?? FALLBACK_PRICE;
  const priceText = `$${price.toFixed(2)}`;
  const walletOk = BASE58.test(wallet.trim());
  const emailOk = EMAIL.test(email.trim());
  const busy = step !== null;
  const soldOut = enabled && status?.soldOut;
  const mainnet = useMemo(() => new Connection(EARLY_RPC, "confirmed"), []);

  const useConnected = () => {
    if (connectedAddr) setWallet(connectedAddr);
    else if (privyEnabled) privyLogin();
  };

  const finish = (o: EarlyOutcome) => {
    if (o.status === "minted") setDone({ kind: "minted", explorer: o.explorer, asset: o.asset, again: o.alreadyMinted });
    else if (o.status === "waitlist") setDone({ kind: "waitlist", again: o.alreadyOnList });
    else if (o.status === "paid" || o.status === "refund_due") setDone({ kind: "paid", message: o.message });
  };

  /** Sign and send the pre-built transaction: it pays the USDC and mints the NFT in one go. */
  const pay = async (p: EarlyPayment) => {
    const payer = paySigner.publicKey;
    if (!payer || !paySigner.send) throw new Error(`Connect a wallet with ${priceText} USDC on Solana to pay. The NFT still goes to the wallet you entered.`);
    if (payer.toBase58() !== p.payer) throw new Error("Your connected wallet changed. Try again.");
    const ata = getAssociatedTokenAddressSync(new PublicKey(p.mint), payer);
    try {
      const bal = await mainnet.getTokenAccountBalance(ata, "confirmed");
      if (BigInt(bal.value.amount) < BigInt(p.amountBaseUnits)) throw new Error("low");
    } catch {
      throw new Error(`Your wallet needs ${priceText} USDC on Solana plus about 0.004 SOL for the network fee and NFT rent.`);
    }
    const tx = Transaction.from(Uint8Array.from(atob(p.transaction), (c) => c.charCodeAt(0)));
    setStep("wallet");
    const signature = await paySigner.send(tx, mainnet, p.cluster);
    setStep("confirming");
    for (let i = 0; i < 40; i++) {
      try {
        const out = await api.earlyConfirm(p.claimId, signature, payer.toBase58());
        if (out.status !== "pending") return finish(out);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status < 500 || i === 39) throw e;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setDone({ kind: "paid", message: "Payment sent. Your NFT shows up as soon as the network confirms it." });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!walletOk || !emailOk) return;
    setStep("claim");
    try {
      const payer = enabled ? paySigner.publicKey?.toBase58() : undefined;
      if (enabled && !payer) throw new Error(`Connect a wallet to pay ${priceText} in USDC. The NFT goes to the address you entered.`);
      const out = await api.earlyClaim(wallet.trim(), email.trim(), payer);
      if (out.status === "awaiting_payment") await pay(out.payment);
      else finish(out);
    } catch (err) {
      const msg = errorText(err);
      setError(/reject|declin|denied/i.test(msg) ? "You declined the payment in your wallet." : msg);
    } finally {
      setStep(null);
    }
  };

  return (
    <main className="pg-early" data-testid="early">
      <section className="early-grid">
        <div className="early-art">
          <picture>
            <source srcSet={EARLY_ART_PREVIEW} type="image/webp" />
            <img src={EARLY_ART} alt="Garuda Beta Access NFT" width={1024} height={1024} decoding="async" />
          </picture>
        </div>

        <div className="early-copy">
          <div className="early-eyebrow">Garuda Beta Access</div>
          <h1 className="early-title">You Are Early.</h1>
          <p className="early-lead">
            Mint the Garuda Beta Access NFT on Solana. One per wallet. Holders get first access to Garuda challenges and every beta drop.
          </p>

          <div className="early-meta">
            <div className="early-price" data-testid="early-price">
              <b>{priceText}</b>
              <span>USDC per mint</span>
            </div>
            <div className="early-supply">
              <b>{status ? `${status.minted} / ${status.cap}` : "1000"}</b>
              <span>{status ? "minted" : "supply"}</span>
            </div>
          </div>

          {done ? (
            <div className="early-done" data-testid="early-done">
              {done.kind === "minted" && (
                <>
                  <h2>Minted.</h2>
                  <p>{done.again ? "This wallet already holds its Beta Access NFT." : "Your Garuda Beta Access NFT is in your wallet."}</p>
                  <a className="btn btn-fire" href={done.explorer} target="_blank" rel="noopener">View on Solscan</a>
                </>
              )}
              {done.kind === "waitlist" && (
                <>
                  <h2>You're on the list.</h2>
                  <p>{done.again ? "This wallet is already on the list." : "Minting opens soon. Come back to mint yours for " + priceText + " when it opens."}</p>
                </>
              )}
              {done.kind === "paid" && (
                <>
                  <h2>Payment received.</h2>
                  <p>{done.message}</p>
                </>
              )}
              <div className="cta-row">
                <XMarketsButton />
                <span className="cta-note">Follow Garuda on X for the launch.</span>
              </div>
            </div>
          ) : (
            <form className="early-form" onSubmit={submit} noValidate>
              {!enabled && <div className="early-soon"><i />Minting opens soon. Join the waitlist now, no payment today.</div>}
              {soldOut && <div className="early-soon"><i />Sold out. Every Beta Access NFT is claimed.</div>}
              <label className="early-field">
                <span>Solana wallet address</span>
                <div className="early-input-row">
                  <input
                    value={wallet}
                    onChange={(e) => setWallet(e.target.value)}
                    placeholder="Your wallet address"
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="text"
                    aria-invalid={touched && !walletOk}
                    data-testid="early-wallet"
                  />
                  {(connectedAddr || privyEnabled) && (
                    <button type="button" className="early-use" onClick={useConnected}>
                      {connectedAddr ? "Use connected" : "Connect"}
                    </button>
                  )}
                </div>
                {touched && !walletOk && <em>Enter a valid Solana address.</em>}
              </label>
              <label className="early-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  aria-invalid={touched && !emailOk}
                  data-testid="early-email"
                />
                {touched && !emailOk && <em>Enter a valid email.</em>}
              </label>
              <button className="btn btn-fire early-submit" type="submit" disabled={busy || Boolean(soldOut)} data-testid="early-submit">
                {busy ? STEP[step!] ?? "Working..." : enabled ? `Mint for ${priceText}` : "Join the waitlist"}
              </button>
              {error && <div className="early-error" role="alert">{error}</div>}
              <p className="early-fine">
                {enabled
                  ? `You pay ${priceText} in USDC from your connected wallet on Solana mainnet, plus the network fee and NFT rent (about 0.003 SOL). The NFT is minted to the address above. One per wallet and per email.`
                  : `Mint price will be ${priceText} in USDC on Solana mainnet. One per wallet and per email. We only use your email for Garuda updates.`}
                {enabled && !connected && " Connect a wallet to pay."}
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
