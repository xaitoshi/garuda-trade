import type { ReactNode } from "react";
import { useSession } from "../lib/session";
import { KnightImg } from "./Art";
import { WalletButton } from "./TopBar";

/** Children render once a wallet is connected and signed in; otherwise a short prompt in the app's style. */
export function Gate({ children, title, note }: { children: ReactNode; title?: string; note?: string }) {
  const { connected, signedIn, signingIn, signIn, error, offline, privyEnabled, privyLogin, browserWallet } = useSession();
  if (offline) return <Notice title="The Garuda API is not reachable" note="Start the API (pnpm dev) or the stub server (pnpm web:stub), then reload." />;
  if (connected && signedIn) return <>{children}</>;
  return (
    <main>
      <div className="panel gate dots">
        <KnightImg level={1} size={140} />
        <h2 className="pt">{connected ? "Sign in to continue" : (title ?? (privyEnabled ? "Sign in" : "Connect your wallet"))}</h2>
        <p className="mute">
          {note ??
            (privyEnabled
              ? "Sign in with your email and we create a Solana wallet for you, or connect Phantom, Solflare or Backpack. No identity checks. It costs nothing and moves no funds."
              : "Your wallet is your account. Signing a message proves it is yours. It costs nothing and moves no funds.")}
        </p>
        {privyEnabled ? (
          <div className="gate-actions">
            <button className="btn btn-fire" onClick={privyLogin} disabled={signingIn} data-testid="privy-login">
              {signingIn ? "Signing you in..." : "Sign in with email or wallet"}
            </button>
            {browserWallet ? (
              <button className="btn btn-ghost btn-sm" onClick={() => void signIn()} disabled={signingIn} data-testid="wallet-signature">
                Sign in with a wallet signature instead
              </button>
            ) : (
              <WalletButton label="Or sign in with a browser wallet signature" ghost />
            )}
          </div>
        ) : connected ? (
          <button className="btn btn-fire" onClick={() => void signIn()} disabled={signingIn}>
            {signingIn ? "Waiting for signature..." : "Sign in with wallet"}
          </button>
        ) : (
          <WalletButton />
        )}
        {error && <p className="dn" style={{ fontSize: 13 }}>{error}</p>}
      </div>
    </main>
  );
}

export function Notice({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <main>
      <div className="panel gate dots">
        <KnightImg level={1} state="dormant" size={120} />
        <h2 className="pt">{title}</h2>
        {note && <p className="mute">{note}</p>}
        {children}
      </div>
    </main>
  );
}
