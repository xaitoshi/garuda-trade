import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useSession } from "../lib/session";
import { shortAddr } from "../lib/format";
import { Logo } from "./Art";

export function SimBadge() {
  return (
    <span className="simbadge" title="Challenge accounts are simulated. Fees are paid in USDC. Payouts are not live yet.">
      <i />
      SIMULATED ACCOUNT
    </span>
  );
}

const TABS = [
  ["/terminal", "Terminal"],
  ["/challenges", "Challenges"],
  ["/barracks", "Barracks"],
  ["/leaderboard", "Leaderboard"],
  ["/payouts", "Payouts"],
] as const;

export function TopBar({ landing }: { landing: boolean }) {
  return (
    <header className="top">
      <Link className="brand" to="/">
        <Logo />
        <span>GARUDA</span>
      </Link>
      {landing ? (
        <nav className="tabs landing-tabs" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#trials">Challenges</a>
          <a href="#knights">Knights</a>
          <a href="#faq">FAQ</a>
        </nav>
      ) : (
        <nav className="tabs" aria-label="Main">
          {TABS.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "on" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
      )}
      <div className="top-r">
        <SimBadge />
        <WalletButton />
      </div>
    </header>
  );
}

export function WalletButton({ label, ghost }: { label?: string; ghost?: boolean } = {}) {
  const { connecting, wallets, select, disconnect } = useWallet();
  const { wallet: address, connected, browserWallet, signedIn, signingIn, signIn, signOut, error, walletLabel, via, privyEnabled, privyLogin } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);

  if (connected && address) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button className="wallet" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="wallet-pill">
          <i className="chain" style={signedIn ? undefined : { background: "var(--gold)", boxShadow: "0 0 8px var(--gold)" }} />
          {shortAddr(address)}
        </button>
        {open && (
          <div className="menu" role="menu">
            <div className="lbl">{walletLabel ?? "Wallet"}</div>
            {via === "privy" && <div className="mute mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{address}</div>}
            {!signedIn && browserWallet && (
              <button className="btn btn-fire btn-sm" onClick={() => void signIn()} disabled={signingIn}>
                {signingIn ? "Waiting for signature..." : "Sign in"}
              </button>
            )}
            {!signedIn && !browserWallet && privyEnabled && signingIn && <div className="mute" style={{ fontSize: 13 }}>Signing you in...</div>}
            {error && <div className="dn" style={{ fontSize: 12 }}>{error}</div>}
            <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
            {browserWallet && via !== "privy" && (
              <button className="btn btn-ghost btn-sm" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const usable = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  return (
    <div className="wallet-wrap" ref={ref}>
      <button className={`btn ${ghost ? "btn-ghost" : "btn-fire"} btn-sm`} onClick={() => setOpen((o) => !o)} disabled={connecting} data-testid="connect">
        {connecting ? "Connecting..." : (label ?? (privyEnabled ? "Sign in" : "Connect wallet"))}
      </button>
      {open && (
        <div className="menu" role="menu">
          {privyEnabled && (
            <>
              <button className="btn btn-fire btn-sm" onClick={() => { setOpen(false); privyLogin(); }} data-testid="privy-login-menu">
                Email or wallet
              </button>
              <div className="mute" style={{ fontSize: 12 }}>Email creates a Solana wallet for you. No identity checks.</div>
            </>
          )}
          <div className="lbl">{privyEnabled ? "Or sign a message with a browser wallet" : "Choose a wallet"}</div>
          {usable.length === 0 && (
            <div className="mute" style={{ fontSize: 13, maxWidth: 220 }}>
              No Solana wallet found. Install Phantom or Solflare, then reload.
            </div>
          )}
          {usable.map((w) => (
            <button key={w.adapter.name} className="wopt" onClick={() => select(w.adapter.name)} data-testid={`wallet-${w.adapter.name}`}>
              <img src={w.adapter.icon} width={22} height={22} alt="" />
              {w.adapter.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
