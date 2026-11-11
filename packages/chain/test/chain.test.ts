import { describe, expect, it } from "vitest";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  DEVNET_GENESIS_HASH,
  FakeKnights,
  FakeUsdc,
  HttpRpc,
  KNIGHT_TIERS,
  MainnetRefusedError,
  MetaplexCoreKnights,
  RpcError,
  SolanaUsdc,
  assertDevnetCluster,
  assertDevnetUrl,
  deriveKnightState,
  fromAttributeList,
  imageUrl,
  knightAssetKeypair,
  tierMetadata,
  tierMetadataUri,
  refundReferenceKeypair,
  sameAttrs,
  toAttributeList,
  usdToBaseUnits,
  withReference,
  type JsonRpc,
  type KnightAttrs,
  type KnightHistoryRow,
} from "../src/index.js";

const eddsa = createUmi("http://127.0.0.1:1").eddsa;
const kp = () => eddsa.generateKeypair();

describe("devnet-only guard", () => {
  it("refuses mainnet-looking RPC URLs everywhere a client is built", () => {
    for (const u of ["https://api.mainnet-beta.solana.com", "https://solana-mainnet.g.alchemy.com/v2/x", "https://mainnet.helius-rpc.com/?api-key=x"]) {
      expect(() => assertDevnetUrl(u)).toThrow(MainnetRefusedError);
      expect(() => new HttpRpc(u)).toThrow(MainnetRefusedError);
      expect(() => new MetaplexCoreKnights({ rpcUrl: u, authority: kp(), baseUrl: "http://x" })).toThrow(MainnetRefusedError);
      expect(() => new SolanaUsdc({ rpcUrl: u, rpc: { call: async () => null }, mint: "m", treasury: kp() })).toThrow(MainnetRefusedError);
    }
    expect(() => assertDevnetUrl("https://api.devnet.solana.com")).not.toThrow();
  });

  it("checks the genesis hash of whatever RPC it is given", async () => {
    await expect(assertDevnetCluster({ call: async () => DEVNET_GENESIS_HASH })).resolves.toBeUndefined();
    await expect(assertDevnetCluster({ call: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" })).rejects.toThrow(MainnetRefusedError);
  });
});

describe("HttpRpc", () => {
  it("posts JSON-RPC and surfaces RPC and HTTP errors", async () => {
    const calls: unknown[] = [];
    const ok = new HttpRpc("https://api.devnet.solana.com", async (_u, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ result: 42 }) };
    });
    expect(await ok.call("getSlot", [])).toBe(42);
    expect(calls[0]).toMatchObject({ jsonrpc: "2.0", method: "getSlot" });
    const rpcErr = new HttpRpc("https://api.devnet.solana.com", async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32005, message: "node is behind" } }) }));
    await expect(rpcErr.call("x")).rejects.toBeInstanceOf(RpcError);
    const httpErr = new HttpRpc("https://api.devnet.solana.com", async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(httpErr.call("x")).rejects.toThrow(/429/);
  });
});

describe("amounts", () => {
  it("converts dollars to USDC base units exactly", () => {
    expect(usdToBaseUnits(119)).toBe(119_000_000n);
    expect(usdToBaseUnits(95.2)).toBe(95_200_000n);
    expect(usdToBaseUnits(399.2)).toBe(399_200_000n);
    expect(usdToBaseUnits(0.1 + 0.2)).toBe(300_000n);
  });
});

describe("knight attributes and metadata", () => {
  const a: KnightAttrs = { tier: "paladin", level: 3, status: "funded", challengeId: "ch_1", wins: 3, revives: 1 };

  it("round-trips through the onchain key/value list (tier, funded level, status)", () => {
    const list = toAttributeList(a);
    expect(list.map((x) => x.key)).toEqual(["tier", "level", "status", "challenge_id", "wins", "revives"]);
    expect(list.find((x) => x.key === "level")?.value).toBe("3");
    expect(fromAttributeList(list)).toEqual(a);
  });

  it("reads a knight minted before Funded scaling (level was a tier name) as Lv.1 of its tier", () => {
    const legacy = [
      { key: "level", value: "knight" },
      { key: "status", value: "idle" },
      { key: "tier", value: "squire" },
      { key: "challenge_id", value: "c" },
      { key: "wins", value: "1" },
      { key: "revives", value: "0" },
    ];
    expect(fromAttributeList(legacy)).toEqual({ tier: "squire", level: 1, status: "idle", challengeId: "c", wins: 1, revives: 0 });
  });

  it("rejects attribute lists that are not ours or are malformed", () => {
    expect(fromAttributeList([])).toBeUndefined();
    expect(fromAttributeList(toAttributeList(a).map((x) => (x.key === "level" ? { ...x, value: "king" } : x)))).toBeUndefined();
    expect(fromAttributeList(toAttributeList(a).map((x) => (x.key === "level" ? { ...x, value: "0" } : x)))).toBeUndefined();
    expect(fromAttributeList(toAttributeList(a).map((x) => (x.key === "tier" ? { ...x, value: "king" } : x)))).toBeUndefined();
    expect(fromAttributeList(toAttributeList(a).map((x) => (x.key === "wins" ? { ...x, value: "-1" } : x)))).toBeUndefined();
  });

  it("sameAttrs compares every field", () => {
    expect(sameAttrs(a, { ...a })).toBe(true);
    for (const k of Object.keys(a) as (keyof KnightAttrs)[]) expect(sameAttrs(a, { ...a, [k]: k === "wins" || k === "revives" || k === "level" ? 9 : k === "status" ? "idle" : k === "tier" ? "squire" : "other" } as KnightAttrs)).toBe(false);
  });

  it("serves one metadata file per tier, pointing at the matching PNG (art follows the tier)", () => {
    expect(KNIGHT_TIERS).toEqual(["squire", "knight", "paladin", "ascended"]);
    const imgs = KNIGHT_TIERS.map((t) => tierMetadata("http://h:1/", t).image);
    expect(imgs).toEqual(["knight-1.png", "knight-2.png", "knight-3.png", "knight-4.png"].map((f) => `http://h:1/nft/images/${f}`));
    expect(tierMetadata("http://h:1/", "knight").attributes[0]).toEqual({ trait_type: "Tier", value: "Knight" });
    expect(tierMetadataUri("http://h:1/", "knight")).toBe("http://h:1/nft/metadata/knight.json");
    expect(imageUrl("http://h:1", "squire")).toBe("http://h:1/nft/images/knight-1.png");
  });
});

describe("deriveKnightState", () => {
  let t = 0;
  const row = (r: Partial<KnightHistoryRow>): KnightHistoryRow => ({ id: `c${++t}`, tier: "squire", stage: "evaluation", status: "active", lifecycle: "live" as never, createdAt: ++t, ...r });

  it("a fresh live challenge is Active, Lv.1 of its tier, frozen", () => {
    expect(deriveKnightState([row({})])).toMatchObject({ frozen: true, attrs: { tier: "squire", level: 1, status: "active", wins: 0, revives: 0 } });
    expect(deriveKnightState([row({ tier: "ascended" })]).attrs).toMatchObject({ tier: "ascended", level: 1 });
  });

  it("passing a challenge never changes the tier or level (no more pass promotion)", () => {
    expect(deriveKnightState([row({ status: "passed" })])).toMatchObject({ frozen: false, attrs: { tier: "squire", level: 1, wins: 1, status: "idle" } });
    expect(deriveKnightState([row({ tier: "knight", status: "passed" })]).attrs).toMatchObject({ tier: "knight", level: 1 });
  });

  it("a live funded account shows its funded level and its (possibly graduated) tier", () => {
    const passed = row({ status: "passed" });
    expect(deriveKnightState([passed, row({ stage: "funded", fundedLevel: 3 })])).toMatchObject({ frozen: true, attrs: { status: "funded", tier: "squire", level: 3 } });
    expect(deriveKnightState([passed, row({ stage: "funded", tier: "knight", fundedLevel: 1 })]).attrs).toMatchObject({ tier: "knight", level: 1, status: "funded" });
    expect(deriveKnightState([row({ tier: "demo", status: "passed" })]).attrs.wins).toBe(0);
  });

  it("a breach is Wounded and unlocked; a revive counts a scar, relocks, and the knight is back at Lv.1 of its current tier", () => {
    const passed = row({ tier: "knight", status: "passed" });
    const wounded = row({ stage: "funded", tier: "knight", fundedLevel: 2, status: "wounded" });
    expect(deriveKnightState([passed, wounded])).toMatchObject({ frozen: false, attrs: { status: "wounded", tier: "knight", level: 2 } });
    const revived = deriveKnightState([wounded, row({ tier: "knight", reviveOf: wounded.id })]);
    expect(revived).toMatchObject({ frozen: true, attrs: { status: "active", revives: 1, tier: "knight", level: 1 } });
  });

  it("is order independent (a retry after a failure converges on the same state)", () => {
    const rows = [row({ status: "passed" }), row({ tier: "paladin", status: "wounded" })];
    expect(deriveKnightState([...rows].reverse())).toEqual(deriveKnightState(rows));
  });
});

describe("deterministic keys", () => {
  const secret = kp().secretKey;
  it("one order always maps to one knight asset and one refund key, different orders to different ones", () => {
    const a1 = knightAssetKeypair({ eddsa }, secret, "ord_1").publicKey;
    expect(knightAssetKeypair({ eddsa }, secret, "ord_1").publicKey).toBe(a1);
    expect(knightAssetKeypair({ eddsa }, secret, "ord_2").publicKey).not.toBe(a1);
    expect(knightAssetKeypair({ eddsa }, kp().secretKey, "ord_1").publicKey).not.toBe(a1);
    const r1 = refundReferenceKeypair({ eddsa }, secret, "ord_1").publicKey;
    expect(r1).not.toBe(a1);
    expect(refundReferenceKeypair({ eddsa }, secret, "ord_1").publicKey).toBe(r1);
  });
});

// ------------------------------------------------------------------ SolanaUsdc.verifyPayment against fixture transactions

const MINT = "UsdcMint1111111111111111111111111111111111";
const TREASURY = "Treasury11111111111111111111111111111111111";
const PAYER = "Payer111111111111111111111111111111111111111";
const PAYER_ATA = "PayerAta111111111111111111111111111111111111";
const TREASURY_ATA = "TreasuryAta1111111111111111111111111111111111";
const REF = "Reference111111111111111111111111111111111111";
const SIG = "5".repeat(88);

interface Fx {
  err?: unknown;
  keys?: { pubkey: string; signer: boolean }[];
  pre?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
  post?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
  blockTime?: number | null;
}
const tx = (o: Fx = {}) => ({
  blockTime: o.blockTime === undefined ? 1_800_000_000 : o.blockTime,
  meta: {
    err: o.err ?? null,
    preTokenBalances: o.pre ?? [
      { accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "500000000" } },
      { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "0" } },
    ],
    postTokenBalances: o.post ?? [
      { accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "381000000" } },
      { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "119000000" } },
    ],
  },
  transaction: {
    message: {
      accountKeys: o.keys ?? [
        { pubkey: PAYER, signer: true },
        { pubkey: PAYER_ATA, signer: false },
        { pubkey: TREASURY_ATA, signer: false },
        { pubkey: REF, signer: false },
      ],
    },
  },
});

function usdcWith(result: unknown, extra: Partial<JsonRpc> = {}) {
  const rpc: JsonRpc = { call: async (m: string) => (m === "getTransaction" ? result : null), ...extra } as JsonRpc;
  return new SolanaUsdc({ rpcUrl: "https://api.devnet.solana.com", rpc, mint: MINT, treasury: kp() }) as SolanaUsdc & { treasury: string };
}
const input = (o: Partial<Parameters<SolanaUsdc["verifyPayment"]>[0]> = {}) => ({ signature: SIG, wallet: PAYER, reference: REF, amountBaseUnits: 119_000_000n, notBeforeMs: 1_800_000_000_000 - 60_000, ...o });

/** Build a SolanaUsdc whose treasury equals the fixture's treasury owner. */
function usdcFor(fx: Fx) {
  const treasuryKp = kp();
  const swap = (x: unknown) => JSON.parse(JSON.stringify(x).replaceAll(TREASURY, treasuryKp.publicKey));
  const raw = swap(tx(fx));
  return new SolanaUsdc({ rpcUrl: "https://api.devnet.solana.com", rpc: { call: async () => raw } as JsonRpc, mint: MINT, treasury: treasuryKp });
}

describe("SolanaUsdc.verifyPayment (mocked RPC, fixture transactions)", () => {
  it("confirms an exact payment and reports the payer's token account", async () => {
    const r = await usdcFor({}).verifyPayment(input());
    expect(r).toMatchObject({ status: "confirmed", payerTokenAccount: PAYER_ATA, paidBaseUnits: 119_000_000n, excessBaseUnits: 0n });
  });

  it("reports the excess when the payer overpays", async () => {
    const r = await usdcFor({
      post: [
        { accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "300000000" } },
        { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "200000000" } },
      ],
    }).verifyPayment(input());
    expect(r).toMatchObject({ status: "confirmed", excessBaseUnits: 81_000_000n });
  });

  it("is pending while the transaction is not on the node yet", async () => {
    const u = usdcWith(null);
    expect(await u.verifyPayment(input())).toEqual({ status: "pending" });
  });

  it("rejects a malformed signature without calling the RPC", async () => {
    let called = false;
    const u = new SolanaUsdc({ rpcUrl: "https://api.devnet.solana.com", rpc: { call: async () => ((called = true), null) } as JsonRpc, mint: MINT, treasury: kp() });
    expect(await u.verifyPayment(input({ signature: "not a signature!" }))).toMatchObject({ status: "invalid", reason: "bad_signature" });
    expect(called).toBe(false);
  });

  const cases: [string, Fx, Partial<Parameters<SolanaUsdc["verifyPayment"]>[0]>, string][] = [
    ["a failed transaction", { err: { InstructionError: [0, "Custom"] } }, {}, "transaction_failed"],
    ["a missing reference", { keys: [{ pubkey: PAYER, signer: true }, { pubkey: PAYER_ATA, signer: false }, { pubkey: TREASURY_ATA, signer: false }] }, {}, "reference_missing"],
    ["a different reference (replay onto another order)", {}, { reference: "OtherRef1111111111111111111111111111111111111" }, "reference_missing"],
    ["the payer not signing", { keys: [{ pubkey: PAYER, signer: false }, { pubkey: PAYER_ATA, signer: false }, { pubkey: TREASURY_ATA, signer: false }, { pubkey: REF, signer: false }] }, {}, "payer_not_signer"],
    ["a transaction older than the order", {}, { notBeforeMs: 1_800_000_000_000 + 10 * 60_000 }, "too_old"],
    ["underpayment", {}, { amountBaseUnits: 119_000_001n }, "underpaid"],
    [
      "a transfer of a different mint",
      {
        pre: [{ accountIndex: 2, mint: "OtherMint", owner: TREASURY, uiTokenAmount: { amount: "0" } }],
        post: [{ accountIndex: 2, mint: "OtherMint", owner: TREASURY, uiTokenAmount: { amount: "119000000" } }],
      },
      {},
      "no_transfer_to_treasury",
    ],
    [
      "a payment to someone else",
      {
        pre: [{ accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "500000000" } }, { accountIndex: 2, mint: MINT, owner: "Thief", uiTokenAmount: { amount: "0" } }],
        post: [{ accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "381000000" } }, { accountIndex: 2, mint: MINT, owner: "Thief", uiTokenAmount: { amount: "119000000" } }],
      },
      {},
      "no_transfer_to_treasury",
    ],
    [
      "money that came from a wallet other than the signer's own account",
      {
        pre: [{ accountIndex: 1, mint: MINT, owner: "SomeoneElse", uiTokenAmount: { amount: "500000000" } }, { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "0" } }],
        post: [{ accountIndex: 1, mint: MINT, owner: "SomeoneElse", uiTokenAmount: { amount: "381000000" } }, { accountIndex: 2, mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "119000000" } }],
      },
      {},
      "payer_balance_mismatch",
    ],
  ];
  for (const [name, fx, over, reason] of cases) {
    it(`rejects ${name}`, async () => {
      expect(await usdcFor(fx).verifyPayment(input(over))).toMatchObject({ status: "invalid", reason });
    });
  }

  it("withReference appends a read-only, non-signer key to the transfer instruction", async () => {
    const { transferTokensChecked, mplToolbox } = await import("@metaplex-foundation/mpl-toolbox");
    const { publicKey } = await import("@metaplex-foundation/umi");
    const { keypairIdentity } = await import("@metaplex-foundation/umi");
    const umi = createUmi("http://127.0.0.1:1").use(mplToolbox()).use(keypairIdentity(kp()));
    const [src, dst, mint, ref] = [kp(), kp(), kp(), kp()].map((k) => publicKey(k.publicKey));
    const b = transferTokensChecked(umi, { source: src!, destination: dst!, mint: mint!, authority: umi.identity, amount: 1n, decimals: 6 });
    const before = b.items[0]!.instruction.keys.length;
    const w = withReference(b, ref!);
    const keys = w.items[0]!.instruction.keys;
    expect(keys.length).toBe(before + 1);
    expect(keys.at(-1)).toMatchObject({ pubkey: ref, isSigner: false, isWritable: false });
  });

  it("refund finds an earlier refund by its order-derived key and sends nothing twice", async () => {
    const calls: string[] = [];
    const u = new SolanaUsdc({
      rpcUrl: "https://api.devnet.solana.com",
      rpc: {
        call: async (m: string) => {
          calls.push(m);
          return m === "getSignaturesForAddress" ? [{ signature: "earlierRefundSig", err: null }] : null;
        },
      } as JsonRpc,
      mint: MINT,
      treasury: kp(),
    });
    expect(await u.refund({ orderId: "ord_1", toTokenAccount: PAYER_ATA, amountBaseUnits: 1n })).toEqual({ signature: "earlierRefundSig", alreadyRefunded: true });
    expect(calls).toEqual(["getSignaturesForAddress"]);
  });
});

describe("fakes behave like the real thing", () => {
  it("FakeKnights: frozen assets refuse transfer, mint is idempotent per order", async () => {
    const f = new FakeKnights();
    const attrs: KnightAttrs = { tier: "squire", level: 1, status: "active", challengeId: "c", wins: 0, revives: 0 };
    const m1 = await f.mint({ owner: "A", name: "n", orderId: "o1", frozen: true, attrs });
    const m2 = await f.mint({ owner: "A", name: "n", orderId: "o1", frozen: true, attrs });
    expect(m2).toMatchObject({ asset: m1.asset, alreadyMinted: true });
    expect(() => f.transfer(m1.asset, "B")).toThrow(/frozen/);
    await f.update({ asset: m1.asset, attrs, frozen: false });
    f.transfer(m1.asset, "B");
    expect((await f.get(m1.asset))!.owner).toBe("B");
  });

  it("FakeUsdc refunds once per order", async () => {
    const f = new FakeUsdc();
    const a = await f.refund({ orderId: "o", toTokenAccount: "t", amountBaseUnits: 5n });
    const b = await f.refund({ orderId: "o", toTokenAccount: "t", amountBaseUnits: 5n });
    expect(b).toEqual({ signature: a.signature, alreadyRefunded: true });
  });
});
