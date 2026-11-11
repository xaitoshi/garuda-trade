import { describe, expect, it } from "vitest";
import { PhoenixRouter, InMemoryRoutingStore, routingConfigFromEnv, createRouterFromEnv, type TraderBook } from "../src/index.js";
import { MockPhoenix, cfg, fillEvent } from "./helpers.js";

const T = Date.UTC(2026, 10, 11, 4, 0, 0);

async function rig(extra: Record<string, string> = {}, opts: { client?: MockPhoenix | null; book?: (id: string) => Promise<TraderBook | undefined> } = {}) {
  const store = new InMemoryRoutingStore();
  const client = opts.client === null ? undefined : (opts.client ?? new MockPhoenix());
  const clock = { t: T };
  const router = new PhoenixRouter({ config: cfg(extra), store, client, traderBook: opts.book, now: () => clock.t, log: () => {} });
  await router.init();
  await router.setTrader("ch_funded", { enabled: true }, "test");
  return { store, client: client as MockPhoenix, router, clock };
}

describe("kill switch defaults", () => {
  it("is disabled with an empty environment and DRY_RUN defaults to true", () => {
    const c = routingConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(true);
  });

  it("disabled router ignores fills, never calls Phoenix and writes nothing", async () => {
    const store = new InMemoryRoutingStore();
    const client = new MockPhoenix();
    const router = new PhoenixRouter({ config: routingConfigFromEnv({ ROUTING_DRY_RUN: "false" }), store, client, log: () => {} });
    await router.init();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(router.healthLabel()).toBe("disabled");
    expect(client.orders).toHaveLength(0);
    expect(store.orders).toHaveLength(0);
    await expect(router.resumeRouting("admin")).rejects.toThrow(/disabled/);
  });

  it("createRouterFromEnv never reads the delegate key while disabled, and removes it from the env", async () => {
    const env: Record<string, string | undefined> = { PHOENIX_DELEGATE_KEYPAIR: "not-json", PHOENIX_FIRM_AUTHORITY: "Firm" };
    const router = await createRouterFromEnv(env, { store: new InMemoryRoutingStore() });
    expect(router.mode).toBe("disabled");
    expect(env.PHOENIX_DELEGATE_KEYPAIR).toBeUndefined();
  });

  it("enabled without ROUTING_DRY_RUN=false runs dry: logs A-book intents, sends nothing", async () => {
    const { router, client, store } = await rig({ ROUTING_DRY_RUN: "" });
    expect(router.healthLabel()).toBe("dry_run");
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(client.orders).toHaveLength(0);
    expect(store.orders).toMatchObject([{ mode: "dry_run", status: "dry_run", book: "A", action: "open", side: "buy", size: 1, symbol: "SOL" }]);
    expect((await router.status()).positions).toMatchObject([{ mode: "dry_run", size: 1 }]);
  });

  it("live mode without the delegate key is refused (disabled with a reason)", async () => {
    const { router } = await rig({}, { client: null });
    expect(router.mode).toBe("disabled");
    expect(router.modeReason).toMatch(/PHOENIX_DELEGATE_KEYPAIR/);
  });
});

describe("mirroring", () => {
  it("mirrors open, increase, reduce, close and flip with the multiplier and a slippage limit", async () => {
    const { router, client } = await rig();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 20 }));
    router.onFills(fillEvent({ side: "sell", size: 15, price: 150, after: 5 }));
    router.onFills(fillEvent({ side: "sell", size: 5, price: 150, after: 0 }));
    router.onFills(fillEvent({ side: "sell", size: 10, price: 150, after: -10 }));
    await router.idle();
    expect(client.orders.map((o) => [o.side, +o.size.toFixed(6), o.reduceOnly])).toEqual([
      ["buy", 1, false],
      ["buy", 1, false],
      ["sell", 1.5, true],
      ["sell", 0.5, true],
      ["sell", 1, false],
    ]);
    expect(client.orders[0]!.limitPrice).toBeCloseTo(150 * 1.005);
    expect(client.orders[2]!.limitPrice).toBeCloseTo(150 * 0.995);
    expect(client.orders[0]!.collateralUsd).toBeCloseTo(150 / 3);
    expect(client.orders[2]!.collateralUsd).toBe(0);
    expect(client.book.SOL).toBeCloseTo(-1);
    const orders = await router.listOrders();
    expect(orders.every((o) => o.book === "A" && o.status === "sent" && o.signature)).toBe(true);
  });

  it("closes the old side then opens the new one when a fill flips the trader in one go", async () => {
    const { router, client } = await rig();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    router.onFills(fillEvent({ side: "sell", size: 20, price: 150, after: -10 }));
    await router.idle();
    expect(client.orders.map((o) => [o.side, o.size, o.reduceOnly])).toEqual([["buy", 1, false], ["sell", 1, true], ["sell", 1, false]]);
  });

  it("uses a per-trader multiplier override", async () => {
    const { router, client } = await rig();
    await router.setTrader("ch_funded", { enabled: true, multiplier: 0.5 }, "admin");
    router.onFills(fillEvent({ side: "buy", size: 2, price: 150, after: 2 }));
    await router.idle();
    expect(client.orders[0]!.size).toBe(1);
  });

  it("never routes evaluation or demo accounts; unselected funded trades are labelled B-book", async () => {
    const { router, client, store } = await rig();
    router.onFills(fillEvent({ id: "ch_eval", stage: "evaluation", side: "buy", size: 10, price: 150, after: 10 }));
    router.onFills(fillEvent({ id: "ch_demo", demo: true, side: "buy", size: 10, price: 150, after: 10 }));
    router.onFills(fillEvent({ id: "ch_other", side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(client.orders).toHaveLength(0);
    expect(store.orders).toMatchObject([{ challengeId: "ch_other", book: "B", action: "skip", reason: "trader_not_selected" }]);
  });

  it("a breached funded account closes its routed position", async () => {
    const { router, client } = await rig();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    router.onFills(fillEvent({ side: "sell", size: 10, price: 140, after: 0, status: "wounded" }));
    await router.idle();
    expect(client.orders.map((o) => [o.side, o.reduceOnly])).toEqual([["buy", false], ["sell", true]]);
  });
});

describe("caps", () => {
  it("clips to the per-trade notional cap", async () => {
    const { router, client, store } = await rig({ ROUTING_MAX_TRADE_NOTIONAL_USD: "100" });
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(client.orders[0]!.size * 150).toBeCloseTo(100);
    expect(store.orders[0]!.reason).toBe("clipped:cap:per_trade");
  });

  it("enforces the per-trader cap across increases", async () => {
    const { router, client, store } = await rig({ ROUTING_MAX_TRADER_NOTIONAL_USD: "200" });
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 })); // 150 USD
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 20 })); // wants +150, room 50
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 30 })); // no room
    await router.idle();
    expect(client.orders.reduce((s, o) => s + o.size * 150, 0)).toBeCloseTo(200);
    expect(store.orders.at(-1)).toMatchObject({ book: "B", action: "skip", reason: "cap:per_trader" });
  });

  it("enforces the total exposure cap across traders", async () => {
    const { router, client } = await rig({ ROUTING_MAX_TOTAL_NOTIONAL_USD: "300" });
    await router.setTrader("ch_b", { enabled: true }, "admin");
    router.onFills(fillEvent({ side: "buy", size: 20, price: 150, after: 20 })); // 300
    router.onFills(fillEvent({ id: "ch_b", side: "buy", size: 20, price: 150, after: 20 }));
    await router.idle();
    expect(client.orders).toHaveLength(1);
    expect((await router.status()).exposure.totalNotionalUsd).toBeCloseTo(300);
  });

  it("skips markets outside the allowlist and dust below the minimum", async () => {
    const { router, client, store } = await rig();
    router.onFills(fillEvent({ symbol: "DOGE", side: "buy", size: 1000, price: 0.2, after: 1000 }));
    router.onFills(fillEvent({ side: "buy", size: 0.5, price: 150, after: 0.5 })); // 7.5 USD firm notional
    await router.idle();
    expect(client.orders).toHaveLength(0);
    expect(store.orders.map((o) => o.reason)).toEqual(["market_not_allowed"]); // dust is dropped without an audit row
  });
});

describe("halts", () => {
  it("admin halt blocks new exposure but still mirrors reductions; flatten closes everything", async () => {
    const { router, client, store } = await rig();
    await router.setTrader("ch_b", { enabled: true }, "admin");
    router.onFills(fillEvent({ side: "buy", size: 20, price: 150, after: 20 }));
    router.onFills(fillEvent({ id: "ch_b", symbol: "ETH", side: "sell", size: 1, price: 3000, after: -1 }));
    await router.idle();
    await router.haltRouting("admin");
    expect(router.healthLabel()).toBe("live:halted");
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 30 }));
    router.onFills(fillEvent({ side: "sell", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(store.orders.find((o) => o.reason === "halted:admin")).toMatchObject({ book: "B", action: "skip" });
    expect(client.orders.at(-1)).toMatchObject({ side: "sell", reduceOnly: true, size: 1 });
    expect(await router.flatten("admin")).toBe(2);
    expect(client.book.SOL).toBeCloseTo(0);
    expect(client.book.ETH).toBeCloseTo(0);
    await router.resumeRouting("admin");
    expect(router.healthLabel()).toBe("live");
  });

  it("the halt survives a restart (persisted)", async () => {
    const { router, store, client } = await rig();
    await router.haltRouting("admin");
    const again = new PhoenixRouter({ config: cfg(), store, client, log: () => {} });
    await again.init();
    expect(again.healthLabel()).toBe("live:halted");
  });

  it("daily loss limit halts new exposure", async () => {
    const { router, client, store } = await rig({ ROUTING_DAILY_LOSS_LIMIT_USD: "50" });
    router.onFills(fillEvent({ side: "buy", size: 40, price: 150, after: 40 })); // firm 4 SOL
    router.onFills(fillEvent({ side: "sell", size: 40, price: 130, after: 0 })); // -80 realized
    router.onFills(fillEvent({ side: "buy", size: 10, price: 130, after: 10 }));
    await router.idle();
    expect(router.healthLabel()).toBe("live:halted");
    expect((await router.status()).haltReason).toBe("daily_loss");
    expect(client.orders).toHaveLength(2);
    expect(store.orders.at(-1)?.reason).toBe("halted:daily_loss");
  });
});

describe("failures and reconciliation", () => {
  it("a failed send is audited, leaves the tracked position alone, and reconcile retries from the trader's book", async () => {
    const book: TraderBook = { stage: "funded", demo: false, status: "active", positions: { SOL: { size: 10, markPrice: 150 } } };
    const { router, client, store } = await rig({}, { book: async () => book });
    client.failNext = 1;
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    expect(store.orders[0]).toMatchObject({ status: "failed", error: "blockhash expired" });
    expect((await router.status()).positions).toHaveLength(0);
    const r = await router.reconcile();
    expect(r?.resynced).toBe(1);
    expect(client.book.SOL).toBeCloseTo(1);
  });

  it("reconcile closes positions of traders who are flat, deselected or gone", async () => {
    let book: TraderBook | undefined = { stage: "funded", demo: false, status: "active", positions: { SOL: { size: 10, markPrice: 150 } } };
    const { router, client } = await rig({}, { book: async () => book });
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    book = undefined;
    await router.reconcile();
    expect(client.book.SOL).toBeCloseTo(0);
  });

  it("reports drift between the expected firm book and Phoenix without trading it", async () => {
    const { router, client, store } = await rig();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    client.book.SOL = 3; // someone traded the firm account by hand
    const before = client.orders.length;
    const r = await router.reconcile();
    expect(r?.drift).toMatchObject([{ symbol: "SOL", expected: 1, actual: 3 }]);
    expect(client.orders.length).toBe(before);
    expect(store.orders.at(-1)).toMatchObject({ action: "drift", status: "drift" });
  });

  it("deselecting a trader closes their routed position", async () => {
    const { router, client } = await rig();
    router.onFills(fillEvent({ side: "buy", size: 10, price: 150, after: 10 }));
    await router.idle();
    await router.setTrader("ch_funded", { enabled: false }, "admin");
    await router.idle();
    expect(client.book.SOL).toBeCloseTo(0);
    expect(client.orders.at(-1)).toMatchObject({ reduceOnly: true });
  });
});

describe("delegate key handling", () => {
  it("parses a solana-keygen array and rejects anything else without echoing it", async () => {
    const { parseKeypairSecret, RisePhoenixClient } = await import("../src/index.js");
    expect(() => parseKeypairSecret("secret-value")).toThrow(/not valid JSON/);
    expect(() => parseKeypairSecret("[1,2,3]")).toThrow(/64 bytes/);
    try {
      parseKeypairSecret("[999]");
    } catch (e) {
      expect(String(e)).not.toContain("999");
    }
    const { generateKeyPairSigner } = await import("@solana/kit");
    void generateKeyPairSigner;
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes.subarray(0, 32));
    // A 64-byte array whose public half does not match the secret is refused by kit.
    await expect(RisePhoenixClient.create({ firmAuthority: "Firm", delegateSecret: bytes })).rejects.toThrow();
  });
});
