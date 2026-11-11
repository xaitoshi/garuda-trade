import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import type { Keypair } from "@metaplex-foundation/umi";

const eddsa = createUmi("http://127.0.0.1:1").eddsa;

/** Read a Solana CLI style keypair file (JSON array of 64 bytes). */
export function loadKeypairFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${path} is not a 64-byte keypair array`);
  return eddsa.createKeypairFromSecretKey(Uint8Array.from(raw));
}

/** Create a keypair file (mode 0600) unless it exists. Returns the keypair and whether it was created now. */
export function loadOrCreateKeypairFile(path: string): { keypair: Keypair; created: boolean } {
  if (existsSync(path)) return { keypair: loadKeypairFile(path), created: false };
  mkdirSync(dirname(path), { recursive: true });
  const keypair = eddsa.generateKeypair();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { keypair, created: true };
}

/** Keypair from a 64-byte secret (Solana CLI keypair file contents, e.g. a secret env var). */
export function keypairFromSecret(secret: Uint8Array): Keypair {
  if (secret.length !== 64) throw new Error("secret key must be 64 bytes");
  return eddsa.createKeypairFromSecretKey(secret);
}
