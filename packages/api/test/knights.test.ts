import { describe, expect, it } from "vitest";
import { FakeKnights } from "@garuda/chain";
import { ChallengeService, ServiceError } from "../src/index.js";
import { breach, makeRig, HOUR, type Rig } from "./helpers.js";

const A = "WalletA1111111111111111111111111111111111111";
const B = "WalletB1111111111111111111111111111111111111";

function nftRig(extra: Partial<ConstructorParameters<typeof ChallengeService>[0]> = {}) {
  const knights = new FakeKnights();
  const rig = makeRig({ knights, enforceGating: true, ...extra });
  return { ...rig, knights };
}

/** Take a challenge to +10% (pass). Size scales with the account. */
async function pass(rig: Rig, id: string, move = 0.014) {
  const size = Math.round(((await rig.svc.getState(id, { refresh: false })).account.startingBalance * 2400) / 25_000);
  await rig.svc.placeOrder(id, { symbol: "SOL", side: "buy", size, type: "market" });
  rig.market.setMove("SOL", move);
  const st = await rig.svc.tick(id);
  rig.market.setMove("SOL", 0);
  if (st.status !== "passed") throw new Error(`expected passed, got ${st.status}`);
  return st;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return `${e.status}:${e.code}`;
    throw e;
  }
  return "ok";
};

describe("knight NFT on challenge", () => {
  it("mints a frozen Squire knight to the buyer with attributes that match the challenge", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    expect(c.knightId).toBeDefined();
    const k = (await r.knights.get(c.knightId!))!;
    expect(k).toMatchObject({ owner: A, level: "squire", status: "active", tier: "squire", challengeId: c.id, wins: 0, revives: 0, frozen: true, genuine: true });
  });

  it("demo challenges mint nothing", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "demo", wallet: A });
    expect(c.knightId).toBeUndefined();
    expect(r.knights.mintCalls).toBe(0);
  });

  it("a mint failure creates no account (nothing half-open)", async () => {
    const r = nftRig();
    r.knights.failMints = 1;
    expect(await code(r.svc.create({ tier: "squire", wallet: A }))).toBe("502:mint_failed");
    expect(await r.svc.list({ wallet: A })).toHaveLength(0);
  });

  it("the knight is transfer-locked while the challenge is live, then unlocked and levelled on pass", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    expect(() => r.knights.transfer(c.knightId!, B)).toThrow(/frozen/i);
    await pass(r, c.id);
    const k = (await r.knights.get(c.knightId!))!;
    expect(k).toMatchObject({ level: "knight", wins: 1, status: "idle", frozen: false });
    r.knights.transfer(c.knightId!, B); // free to sell after the fight
    expect((await r.knights.get(c.knightId!))!.owner).toBe(B);
  });

  it("a breach marks the knight Wounded and unlocks it", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await breach(r, c.id);
    expect(await r.knights.get(c.knightId!)).toMatchObject({ status: "wounded", frozen: false, level: "squire", wins: 0 });
  });

  it("gating reads the chain, not the client: a forged nftLevels claim is worthless", async () => {
    const r = nftRig();
    // paladin needs a Knight-level knight; the client claims it has one
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, nftLevels: ["knight"] }))).toBe("403:tier_locked");
  });

  it("gated tier: needs a genuine knight held by the signed-in wallet, at the right level", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    // still a Squire-level knight and busy
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId }))).toBe("403:tier_locked");
    await pass(r, c.id); // now level Knight
    expect(await code(r.svc.create({ tier: "paladin", wallet: B, knightAsset: c.knightId }))).toBe("403:not_knight_owner");
    expect(await code(r.svc.create({ tier: "paladin", wallet: A }))).toBe("403:tier_locked");
    const p = await r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId });
    expect(p.knightId).toBe(c.knightId);
    expect(await r.knights.get(c.knightId!)).toMatchObject({ frozen: true, status: "active", tier: "paladin", challengeId: p.id });
    // one live challenge per knight
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId }))).toBe("409:knight_busy");
  });

  it("a forged lookalike asset (not in the collection) is refused", async () => {
    const r = nftRig();
    r.knights.forge("ForgedKnight11111111111111111111111111111111", A, "knight");
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: "ForgedKnight11111111111111111111111111111111" }))).toBe("403:knight_not_genuine");
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: "NoSuchAsset11111111111111111111111111111111" }))).toBe("403:knight_not_genuine");
  });

  it("a Wounded knight cannot enter a gated tier until revived", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await pass(r, c.id);
    const p = await r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId });
    await breach(r, p.id, 3000);
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId }))).toBe("403:knight_wounded");
  });

  it("revive relocks the knight, counts the scar, and the new challenge sits on the same asset", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await breach(r, c.id);
    r.clock.t += 25 * HOUR;
    const res = await r.svc.revive(c.id, { actorWallet: A });
    expect(res.state.knightId).toBe(c.knightId);
    expect(await r.knights.get(c.knightId!)).toMatchObject({ status: "active", frozen: true, revives: 1, challengeId: res.state.id });
    expect(() => r.knights.transfer(c.knightId!, B)).toThrow(/frozen/i);
  });

  it("a Wounded knight sold to another wallet: the buyer holds the revive right and gets the new account", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await breach(r, c.id);
    r.knights.transfer(c.knightId!, B); // wounded = unlocked = sellable
    r.clock.t += 25 * HOUR;
    expect(await r.svc.canAct(c.id, A)).toBe(false);
    expect(await r.svc.canAct(c.id, B)).toBe(true);
    expect(await code(r.svc.revive(c.id, { actorWallet: A }))).toBe("403:not_knight_owner");
    const res = await r.svc.revive(c.id, { actorWallet: B });
    expect(res.state.wallet).toBe(B);
  });

  it("funded account: needs the passed evaluation on this knight, the knight stays with the holder", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    expect(await code(r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId }))).toBe("403:evaluation_not_passed");
    await pass(r, c.id);
    const f = await r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId });
    expect(f.stage).toBe("funded");
    expect(await r.knights.get(c.knightId!)).toMatchObject({ status: "funded", frozen: true });
    expect(await code(r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId }))).toBe("409:funded_exists");
  });

  it("an owner re-check after the freeze catches a knight that moved mid-open", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await pass(r, c.id);
    const realGet = r.knights.get.bind(r.knights);
    let n = 0;
    r.knights.get = async (a: string) => {
      const k = await realGet(a);
      // the third read (after the freeze) sees a different owner
      if (k && ++n === 2) return { ...k, owner: B };
      return k;
    };
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId }))).toBe("409:knight_moved");
  });

  it("an RPC failure on sync does not lose the state: the knight is marked dirty and reconcile heals it", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    r.knights.failUpdates = 1;
    await pass(r, c.id); // sync fails here
    expect(r.svc.dirtyKnightIds()).toContain(c.knightId);
    expect(await r.knights.get(c.knightId!)).toMatchObject({ level: "squire", frozen: true }); // stale
    const out = await r.svc.reconcileKnights();
    expect(out).toEqual({ synced: 1, failed: 0 });
    expect(await r.knights.get(c.knightId!)).toMatchObject({ level: "knight", wins: 1, frozen: false });
    expect(r.svc.dirtyKnightIds()).toEqual([]);
  });

  it("a failed freeze refuses to open a gated account (never live and unlocked)", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await pass(r, c.id);
    r.knights.failUpdates = 1;
    expect(await code(r.svc.create({ tier: "paladin", wallet: A, knightAsset: c.knightId }))).toBe("502:knight_lock_failed");
    expect((await r.svc.list({ wallet: A })).filter((x) => x.tier === "paladin")).toHaveLength(0);
  });

  it("sync is idempotent: a second run sends nothing", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await pass(r, c.id);
    const n = r.knights.updateCalls;
    expect(await r.svc.syncKnight(c.knightId!)).toBeUndefined();
    expect(r.knights.updateCalls).toBe(n);
  });

  it("payout goes to whoever holds the knight now", async () => {
    const r = nftRig();
    const c = await r.svc.create({ tier: "squire", wallet: A });
    await pass(r, c.id);
    const f = await r.svc.create({ tier: "squire", stage: "funded", wallet: A, knightAsset: c.knightId });
    expect((await r.svc.payoutQuote(f.id)).destination).toBe(A);
  });

  it("legacy mode (no knight chain) still trusts nftLevels", async () => {
    const rig = makeRig({ enforceGating: true });
    expect(await code(rig.svc.create({ tier: "paladin", wallet: A, nftLevels: ["knight"] }))).toBe("ok");
  });

  it("requirePayment: a direct paid create is 402, demo and funded are free", async () => {
    const r = nftRig({ requirePayment: true });
    expect(await code(r.svc.create({ tier: "squire", wallet: A }))).toBe("402:payment_required");
    expect(await code(r.svc.create({ tier: "demo", wallet: A }))).toBe("ok");
  });
});
