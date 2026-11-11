import { describe, expect, it } from "vitest";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { MPL_CORE_PROGRAM_ID } from "@metaplex-foundation/mpl-core";
import { MAINNET_USDC_MINT, MetaplexEarlyMinter, earlyAssetKeypair } from "../src/index.js";

const eddsa = createUmi("http://127.0.0.1:1").eddsa;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

describe("MetaplexEarlyMinter.buildPaidMint", () => {
  it("builds one legacy tx: idempotent treasury ATA, USDC transfer with reference, Core create; buyer pays, server pre-signs", async () => {
    const authority = eddsa.generateKeypair();
    const collection = eddsa.generateKeypair().publicKey;
    const m = new MetaplexEarlyMinter({
      rpcUrl: "http://127.0.0.1:1",
      cluster: "mainnet-beta",
      authority,
      collection,
      metadataUri: "https://garuda.markets/early/metadata.json",
      configureUmi: (umi) => {
        umi.rpc.getLatestBlockhash = async () => ({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 123 });
      },
    });
    const buyer = eddsa.generateKeypair().publicKey;
    const owner = eddsa.generateKeypair().publicKey;
    const reference = eddsa.generateKeypair().publicKey;
    const treasury = "CCezKqU697kanduvFk8GPwD484DGtKH46tfV9o7T2xKq";
    const out = await m.buildPaidMint({ claimId: "c1", owner, payer: buyer, usdcMint: MAINNET_USDC_MINT, treasury, amountBaseUnits: 1_690_000n, decimals: 6, reference });
    expect(out.asset).toBe(earlyAssetKeypair({ eddsa }, authority.secretKey, "c1").publicKey);
    const umi = createUmi("http://127.0.0.1:1");
    const tx = umi.transactions.deserialize(new Uint8Array(Buffer.from(out.transaction, "base64")));
    const msg = tx.message;
    expect(msg.version).toBe("legacy");
    const keys = msg.accounts.map(String);
    expect(keys[0]).toBe(buyer); // fee payer
    const ixs = msg.instructions.map((i) => ({ program: keys[i.programIndex], keys: i.accountIndexes.map((x) => keys[x]), data: i.data }));
    expect(ixs.map((i) => i.program)).toEqual([ATA, TOKEN, MPL_CORE_PROGRAM_ID]);
    expect(ixs[1]!.keys).toContain(reference);
    expect(Buffer.from(ixs[1]!.data).readBigUInt64LE(1)).toBe(1_690_000n);
    expect(ixs[2]!.keys).toEqual(expect.arrayContaining([buyer, owner, collection, out.asset, authority.publicKey]));
    const signers = keys.slice(0, msg.header.numRequiredSignatures);
    expect(signers).toEqual(expect.arrayContaining([buyer, out.asset, authority.publicKey]));
    const signed = (k: string) => tx.signatures[signers.indexOf(k)]!.some((b) => b !== 0);
    expect(signed(buyer)).toBe(false); // the wallet adds this one
    expect(signed(out.asset)).toBe(true);
    expect(signed(authority.publicKey)).toBe(true);
    expect(umi.eddsa.verify(tx.serializedMessage, tx.signatures[signers.indexOf(authority.publicKey)]!, authority.publicKey)).toBe(true);
  });
});
