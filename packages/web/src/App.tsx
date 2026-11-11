import { useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { SOLANA_RPC, DEV_WALLET } from "./lib/config";
import { DevWalletAdapter } from "./lib/devWallet";
import { SessionProvider } from "./lib/session";
import { PrivyApp } from "./lib/PrivyApp";
import { TopBar } from "./components/TopBar";
import { Landing } from "./pages/Landing";
import { Challenges } from "./pages/Challenges";
import { ChallengeFaq, ChallengeMarkets, ChallengeRules } from "./pages/ChallengeInfo";
import { Terminal } from "./pages/Terminal";
import { Barracks } from "./pages/Barracks";
import { Revive } from "./pages/Revive";
import { Leaderboard } from "./pages/Leaderboard";
import { Payouts } from "./pages/Payouts";
import { CalledIt } from "./pages/CalledIt";
import { Early } from "./pages/Early";
import { Footer } from "./components/Footer";

export function App() {
  // Phantom, Solflare, Backpack... register themselves through the Wallet Standard, so no explicit list is needed.
  const wallets = useMemo<Adapter[]>(() => (DEV_WALLET ? [new DevWalletAdapter()] : []), []);
  // PrivyApp is a pass-through unless VITE_PRIVY_APP_ID is set. The browser-wallet provider stays mounted either way:
  // it is the sign-message fallback and what the dev wallet and the screenshots use.
  return (
    <PrivyApp>
      <ConnectionProvider endpoint={SOLANA_RPC}>
        <WalletProvider wallets={wallets} autoConnect>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </WalletProvider>
      </ConnectionProvider>
    </PrivyApp>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const landing = pathname === "/";
  return (
    <>
      <TopBar landing={landing} />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/challenges/rules" element={<ChallengeRules />} />
        <Route path="/challenges/markets" element={<ChallengeMarkets />} />
        <Route path="/challenges/faq" element={<ChallengeFaq />} />
        <Route path="/challenges" element={<Challenges />} />
        {/* The Demo tab is gone; the free Demo card lives on /challenges. Old links land there. */}
        <Route path="/demo" element={<Navigate to="/challenges" replace />} />
        <Route path="/terminal" element={<Terminal />} />
        <Route path="/terminal/:id" element={<Terminal />} />
        <Route path="/barracks" element={<Barracks />} />
        <Route path="/barracks/:id" element={<Barracks />} />
        <Route path="/revive/:id" element={<Revive />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="/calledit" element={<CalledIt />} />
        <Route path="/early" element={<Early />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
    </>
  );
}
