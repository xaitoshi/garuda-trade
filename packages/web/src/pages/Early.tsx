import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import bs58 from "bs58";
import { Logo } from "../components/Art";
import { api, ApiError, errorText } from "../lib/api";

const LANDING_INK = "#08090a";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/;
const SHARE_PAGE = "https://garuda.markets/early/share";
const SHARE_IMAGE = "/early/you-are-early.png";
const SHARE_INTENT = `https://x.com/intent/post?text=${encodeURIComponent("Gm @garuda_markets")}&url=${encodeURIComponent(SHARE_PAGE)}`;

function isSolanaAddress(value: string): boolean {
  const s = value.trim();
  if (!BASE58.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function Early() {
  const [wallet, setWallet] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
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

  const walletOk = isSolanaAddress(wallet);
  const emailOk = EMAIL.test(email.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!walletOk || !emailOk) return;
    setBusy(true);
    try {
      // Waitlist only: never pass a payer and never follow a payment or mint response.
      const out = await api.earlyClaim(wallet.trim(), email.trim());
      if (out.status === "awaiting_payment") {
        setError("Something went wrong. Try again later.");
        return;
      }
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "wallet_taken" || err.code === "email_taken" || err.code === "already_claimed")) {
        setDone(true);
        return;
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pg-early" data-testid="early">
      <section className="early-hero">
        <Link className="early-logo" to="/" aria-label="Garuda home">
          <Logo h={168} />
        </Link>
        <p className="early-line">The first onchain prop firm on solana</p>
        <p className="early-sub">powered by Phoenix</p>

        {done ? (
          <div className="early-done" data-testid="early-done">
            <h1>You're in.</h1>
            <img className="early-share-art" src={SHARE_IMAGE} alt="You Are Early" width={1600} height={900} />
            <div className="early-share-row">
              <a className="btn btn-fire early-submit" href={SHARE_INTENT} target="_blank" rel="noopener noreferrer" data-testid="early-share-x">
                Share on X
              </a>
              <a className="btn btn-ghost early-submit" href={SHARE_IMAGE} download="you-are-early.png" data-testid="early-share-download">
                Download image
              </a>
            </div>
          </div>
        ) : (
          <form className="early-form" onSubmit={submit} noValidate>
            <label className="early-field">
              <span>Email address</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                aria-invalid={touched && !emailOk}
                data-testid="early-email"
              />
              {touched && !emailOk && <em>Enter a valid email.</em>}
            </label>
            <label className="early-field">
              <span>Wallet address</span>
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                aria-invalid={touched && !walletOk}
                data-testid="early-wallet"
              />
              {touched && !walletOk && <em>Enter a valid Solana address.</em>}
            </label>
            <button className="btn btn-fire early-submit" type="submit" disabled={busy} data-testid="early-submit">
              {busy ? "One moment" : "Enter"}
            </button>
            {error && <div className="early-error" role="alert">{error}</div>}
          </form>
        )}
      </section>
    </main>
  );
}
