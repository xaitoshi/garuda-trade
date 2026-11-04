import { generateKeyPairSync, sign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { base58Encode } from "../src/base58.js";

export interface TestWallet {
  address: string;
  signMessage(message: string, enc?: "base58" | "base64"): string;
}

/** A throwaway Ed25519 keypair whose public key is a valid Solana address, like Phantom would hold. */
export function newWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return {
    address: base58Encode(raw),
    signMessage(message, enc = "base58") {
      const sig = sign(null, Buffer.from(message, "utf8"), privateKey);
      return enc === "base58" ? base58Encode(sig) : sig.toString("base64");
    },
  };
}

export async function signIn(app: FastifyInstance, w: TestWallet): Promise<string> {
  const n = await app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet: w.address } });
  const { nonce, message } = n.json();
  const v = await app.inject({ method: "POST", url: "/auth/verify", payload: { wallet: w.address, nonce, signature: w.signMessage(message) } });
  if (v.statusCode !== 200) throw new Error(`sign-in failed: ${v.body}`);
  return v.json().token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
