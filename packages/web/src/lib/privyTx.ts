import type { Transaction } from "@solana/web3.js";

/** Privy chain id for a Garuda cluster name ("devnet", "mainnet-beta"...). */
export const privyChain = (cluster: string): "solana:devnet" | "solana:mainnet" | "solana:testnet" =>
  cluster.startsWith("mainnet") ? "solana:mainnet" : cluster === "testnet" ? "solana:testnet" : "solana:devnet";

/**
 * The bytes Privy's signAndSendTransaction takes: the legacy transaction in wire format with empty signature slots
 * (the embedded wallet fills in its own). Fee payer and blockhash must already be set.
 */
export const wireTransaction = (tx: Transaction): Uint8Array => new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
