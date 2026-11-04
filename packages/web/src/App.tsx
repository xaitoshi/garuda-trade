import { useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { SOLANA_RPC, DEV_WALLET } from "./lib/config";
import { DevWalletAdapter } from "./lib/devWallet";
import { SessionProvider } from "./lib/session";
import { TopBar } from "./components/TopBar";
import { Landing } from "./pages/Landing";
import { Challenges } from "./pages/Challenges";
import { Terminal } from "./pages/Terminal";
import { Barracks } from "./pages/Barracks";
import { Revive } from "./pages/Revive";
import { Leaderboard } from "./pages/Leaderboard";
import { Payouts } from "./pages/Payouts";
import { Footer } from "./components/Footer";

export function App() {
  // Phantom, Solflare, Backpack... register themselves through the Wallet Standard, so no explicit list is needed.
  const wallets = useMemo<Adapter[]>(() => (DEV_WALLET ? [new DevWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </WalletProvider>
    </ConnectionProvider>
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
        <Route path="/challenges" element={<Challenges />} />
        <Route path="/terminal" element={<Terminal />} />
        <Route path="/terminal/:id" element={<Terminal />} />
        <Route path="/barracks" element={<Barracks />} />
        <Route path="/barracks/:id" element={<Barracks />} />
        <Route path="/revive/:id" element={<Revive />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
    </>
  );
}
