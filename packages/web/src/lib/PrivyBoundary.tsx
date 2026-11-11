import { useCallback, useMemo, type ReactNode } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import type { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { EARLY_RPC, PRIVY_APP_ID, SOLANA_RPC } from "./config";
import { PrivyCtx, type PrivyState } from "./privyState";
import { privyChain, wireTransaction } from "./privyTx";

const wsUrl = (http: string) => http.replace(/^http/, "ws");

/** Loaded lazily (only when VITE_PRIVY_APP_ID is set), so the Privy SDK stays out of the wallet-only bundle's startup path. */
export default function PrivyBoundary({ children }: { children: ReactNode }) {
  const config = useMemo(
    () => ({
      loginMethods: ["email" as const, "wallet" as const],
      appearance: { walletChainType: "solana-only" as const, theme: "dark" as const, accentColor: "#ff5f01" as const },
      // Email users get an embedded Solana wallet on first login. Users who connect an external wallet do not get a second one.
      embeddedWallets: { solana: { createOnLogin: "users-without-wallets" as const } },
      externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      solana: {
        rpcs: {
          // The cluster the API checks out on (devnet; the API refuses mainnet). Add 'solana:mainnet' when that ships.
          "solana:devnet": { rpc: createSolanaRpc(SOLANA_RPC), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl(SOLANA_RPC)) },
          // Mainnet is used by the /early Beta Access mint only (a $1.69 USDC payment).
          "solana:mainnet": { rpc: createSolanaRpc(EARLY_RPC), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl(EARLY_RPC)) },
        },
      },
    }),
    [],
  );
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={config}>
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const sendTransaction = useCallback(
    async (address: string, tx: Transaction, cluster: string) => {
      const wallet = wallets.find((w) => w.address === address);
      if (!wallet) throw new Error("That wallet is not connected to Privy. Sign in again.");
      const transaction = wireTransaction(tx);
      const out = await signAndSendTransaction({ transaction, wallet, chain: privyChain(cluster) });
      return bs58.encode(out.signature);
    },
    [wallets, signAndSendTransaction],
  );

  const state = useMemo<PrivyState>(
    () => ({
      enabled: true,
      ready,
      authenticated,
      walletsReady,
      wallets: wallets.map((w) => ({
        address: w.address,
        embedded: w.standardWallet.name === "Privy",
      })),
      email: user?.email?.address,
      login: () => login(),
      logout: () => logout(),
      getAccessToken: () => getAccessToken(),
      sendTransaction,
    }),
    [ready, authenticated, walletsReady, wallets, user, login, logout, getAccessToken, sendTransaction],
  );
  return <PrivyCtx.Provider value={state}>{children}</PrivyCtx.Provider>;
}
