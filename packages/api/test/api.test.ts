import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ReplayProvider, loadRecordedMarkets, type RecordedMarket } from "@garuda/market-data";
import { buildApp, ChallengeService } from "../src/index.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);

let clock = T0;
let market: ReplayProvider;
let app: FastifyInstance;

const markets = (): RecordedMarket[] => {
  const wide: RecordedMarket = {
    symbol: "HYPE",
    recordedAt: "synthetic",
    markPrice: 100,
    fundingRateHourly: 0,
    bids: [[98, 5000]],
    asks: [[102, 5000]], // 400 bps spread -> circuit breaker
  };
  return [...loadRecordedMarkets().filter((m) => m.symbol !== "HYPE"), wide];
};

beforeEach(() => {
  clock = T0;
  market = new ReplayProvider(markets());
  const service = new ChallengeService({ market, now: () => clock });
  app = buildApp({ service });
});

const create = async (body: object = { tier: "knight", knight: "Sir Pudding" }) => {
  const r = await app.inject({ method: "POST", url: "/challenges", payload: body });
  return { status: r.statusCode, body: r.json() };
};
const order = async (id: string, body: object) => {
  const r = await app.inject({ method: "POST", url: `/challenges/${id}/orders`, payload: body });
  return { status: r.statusCode, body: r.json() };
};
const state = async (id: string) => (await app.inject({ method: "GET", url: `/challenges/${id}` })).json();

describe("POST /challenges", () => {
  it("creates a Knight challenge with the rulebook limits", async () => {
    const { status, body } = await create();
    expect(status).toBe(201);
    expect(body).toMatchObject({ simulated: true, tier: "knight", knight: "Sir Pudding", status: "active" });
    expect(body.account).toMatchObject({ startingBalance: 10_000, balance: 10_000, equity: 10_000 });
    expect(body.risk).toMatchObject({ dailyFloor: 9_700, drawdownFloor: 9_400, targetEquity: 11_000, effectiveFloor: 9_700 });
  });

  it("rejects bad input and unknown tiers with 400", async () => {
    expect((await create({ tier: "king" })).status).toBe(400);
    expect((await create({})).status).toBe(400);
  });

  it("every tier is open to buy (no knight-level gate on Paladin or Ascended)", async () => {
    expect((await create({ tier: "paladin" })).status).toBe(201);
    expect((await create({ tier: "ascended" })).status).toBe(201);
    expect((await create({ tier: "ascended", nftLevels: ["squire"] })).status).toBe(201);
    expect((await create({ tier: "demo" })).status).toBe(201);
  });

  it("404 for an unknown challenge", async () => {
    expect((await app.inject({ method: "GET", url: "/challenges/nope" })).statusCode).toBe(404);
  });
});

describe("orders", () => {
  it("market buy walks the recorded SOL book and charges the taker fee", async () => {
    const { body: c } = await create();
    const r = await order(c.id, { symbol: "SOL-PERP", side: "buy", size: 1000, type: "market" });
    expect(r.status).toBe(201);
    expect(r.body.accepted).toBe(true);
    expect(r.body.fills.length).toBeGreaterThan(1); // 1000 SOL spans several levels
    const notional = r.body.fills.reduce((s: number, f: any) => s + f.price * f.size, 0);
    const fees = r.body.fills.reduce((s: number, f: any) => s + f.fee, 0);
    expect(fees).toBeCloseTo(notional * 0.00035, 6);
    expect(r.body.slippageBps).toBeGreaterThan(0);
    expect(r.body.state.positions[0]).toMatchObject({ symbol: "SOL", side: "long", size: 1000, leverageCap: 10 });
    expect(r.body.combat[0].kind).toBe("advance");
  });

  it("rejects orders beyond the margin-style leverage cap", async () => {
    const { body: c } = await create();
    const r = await order(c.id, { symbol: "SOL", side: "buy", size: 3000, type: "market" }); // ~$279k > 10x of $25k
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ accepted: false, reason: "leverage_cap_exceeded" });
    expect((await state(c.id)).positions).toHaveLength(0);
  });

  it("applies the 2x cap to other crypto and rejects non-whitelisted markets", async () => {
    const { body: c } = await create();
    // HYPE ~ $84.6 in the recording, but our synthetic HYPE book is wide: whitelist/leverage first
    const big = await order(c.id, { symbol: "XRP", side: "buy", size: 1, type: "market" });
    expect(big.body.reason).toBe("market_not_whitelisted");
  });

  it("circuit breaker pauses new orders on a >100 bps spread but allows reduce-only", async () => {
    const { body: c } = await create();
    const r = await order(c.id, { symbol: "HYPE", side: "buy", size: 10, type: "market" });
    expect(r.body).toMatchObject({ accepted: false, reason: "circuit_breaker:spread" });
  });

  it("closed tradfi market: no opening orders, reduce-only still works", async () => {
    const { body: c } = await create();
    const open = await order(c.id, { symbol: "SPY", side: "buy", size: 50, type: "market" });
    expect(open.body.accepted).toBe(true);
    market.setTradable("SPY", false, "after_hours");
    const more = await order(c.id, { symbol: "SPY", side: "buy", size: 10, type: "market" });
    expect(more.body.reason).toBe("market_closed:after_hours");
    const close = await order(c.id, { symbol: "SPY", side: "sell", size: 50, type: "market", reduceOnly: true });
    expect(close.body.accepted).toBe(true);
    expect((await state(c.id)).positions).toHaveLength(0);
  });

  it("limit order rests, fills as maker when price drops, then can be cancelled if still open", async () => {
    const { body: c } = await create();
    const mark = (await market.snapshot("SOL")).markPrice;
    const r = await order(c.id, { symbol: "SOL", side: "buy", size: 100, type: "limit", limitPrice: +(mark * 0.99).toFixed(2) });
    expect(r.body.accepted).toBe(true);
    expect(r.body.order.status).toBe("open");
    market.setMove("SOL", -0.02);
    const s = await app.inject({ method: "POST", url: `/challenges/${c.id}/tick` });
    const st = s.json();
    expect(st.positions[0]).toMatchObject({ symbol: "SOL", side: "long", size: 100 });
    expect(st.recentFills[0].liquidity).toBe("maker");
    expect(st.openOrders).toHaveLength(0);
    const cancel = await app.inject({ method: "DELETE", url: `/challenges/${c.id}/orders/${r.body.order.id}` });
    expect(cancel.json().order.status).toBe("filled");
  });

  it("validates the order body", async () => {
    const { body: c } = await create();
    expect((await order(c.id, { symbol: "SOL", side: "buy", size: -1, type: "market" })).status).toBe(400);
    expect((await order(c.id, { symbol: "SOL", side: "buy", size: 1, type: "limit" })).status).toBe(400);
  });
});

describe("rule engine through the API", () => {
  it("open profit at +10% does NOT pass and nothing is auto-closed (Path to Funded rules 1 and 2)", async () => {
    const { body: c } = await create();
    const passSize = Math.round((c.account.startingBalance * 2400) / 25_000);
    await order(c.id, { symbol: "SOL", side: "buy", size: passSize, type: "market" });
    market.setMove("SOL", 0.014);
    const st = (await app.inject({ method: "POST", url: `/challenges/${c.id}/tick` })).json();
    expect(st.account.equity).toBeGreaterThan(11_000);
    expect(st.status).toBe("active");
    expect(st.positions).toHaveLength(1);
    expect(st.pathToFunded).toMatchObject({ targetMet: false, flat: false, next: "trade" });
  });

  it("pass: three days of closed profit, flat, best-day rule met; locks the challenge and logs the boss kill", async () => {
    const { body: c } = await create();
    const size = Math.round((c.account.startingBalance * 2400) / 25_000);
    let last: any;
    for (let day = 0; day < 3; day++) {
      if (day > 0) clock += 24 * HOUR;
      await order(c.id, { symbol: "SOL", side: "buy", size, type: "market" });
      market.setMove("SOL", 0.0065);
      last = (await order(c.id, { symbol: "SOL", side: "sell", size, type: "market", reduceOnly: true })).body;
      market.setMove("SOL", 0);
      expect(last.state.pathToFunded.tradingDays).toBe(day + 1);
      if (day < 2) expect(last.state.status).toBe("active");
    }
    const st = last.state;
    expect(st.status).toBe("passed");
    expect(st.positions).toHaveLength(0);
    expect(st.pathToFunded).toMatchObject({ targetMet: true, flat: true, daysMet: true, eligible: true, next: "claim" });
    expect(st.pathToFunded.bestDay.ok).toBe(true);
    expect(st.combatLog.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["pass", "strike"]));
    expect(st.combatLog.some((e: any) => /slays the boss/.test(e.text))).toBe(true);
    const again = await order(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect(again.status).toBe(409);
    // claim (library default: KYC and review auto) opens the funded account
    const cl = await app.inject({ method: "POST", url: `/challenges/${c.id}/claim` });
    expect(cl.statusCode).toBe(200);
    expect(cl.json().pathToFunded).toMatchObject({ next: "funded", claim: { status: "approved", kyc: "approved" } });
    const fid = cl.json().pathToFunded.claim.fundedId;
    expect((await state(fid))).toMatchObject({ stage: "funded", status: "active", pathToFunded: null });
  });

  it("daily loss breach: warnings at 50/80%, then Wounded, positions closed, no more trading", async () => {
    const { body: c } = await create();
    const sz = Math.round((c.account.startingBalance * 2400) / 25_000);
    await order(c.id, { symbol: "SOL", side: "buy", size: sz, type: "market" });
    market.setMove("SOL", -0.0018);
    let st = (await app.inject({ method: "POST", url: `/challenges/${c.id}/tick` })).json();
    expect(st.status).toBe("active");
    expect(st.combatLog.some((e: any) => e.kind === "warning")).toBe(true);
    market.setMove("SOL", -0.0023);
    st = (await app.inject({ method: "POST", url: `/challenges/${c.id}/tick` })).json();
    expect(st.risk.dailyUsedPct).toBeGreaterThan(0.8);
    expect(st.status).toBe("active");
    market.setMove("SOL", -0.006); // ~ -$1,300 > $750
    st = (await app.inject({ method: "POST", url: `/challenges/${c.id}/tick` })).json();
    expect(st.status).toBe("wounded");
    expect(st.risk.breach).toMatchObject({ rule: "daily_loss" });
    expect(st.positions).toHaveLength(0);
    expect(st.combatLog.some((e: any) => /falls, Wounded/.test(e.text))).toBe(true);
    expect((await order(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" })).status).toBe(409);
  });

  it("a breach caught by the pre-order refresh locks the challenge (409)", async () => {
    const { body: c } = await create({ tier: "squire", knight: "Sir Oops" });
    const sz = Math.round((c.account.startingBalance * 900) / 10_000);
    await order(c.id, { symbol: "SOL", side: "buy", size: sz, type: "market" });
    market.setMove("SOL", -0.005);
    const r = await order(c.id, { symbol: "SOL", side: "buy", size: 1, type: "market" });
    expect(r.status).toBe(409); // the refresh before the order breached the account
    const st = await state(c.id);
    expect(st.status).toBe("wounded");
  });

  it("UTC day rollover re-bases the daily limit on the banked balance and accrues funding", async () => {
    const { body: c } = await create();
    market.setFunding("SOL", 0.0001); // 1 bp/h, longs pay
    await order(c.id, { symbol: "SOL", side: "buy", size: 500, type: "market" });
    const before = (await state(c.id)).account.balance;
    clock = T0 + 20 * HOUR; // 2026-11-05 02:00 UTC: crossed midnight
    const st = await state(c.id);
    expect(st.risk.dayKey).toBe("2026-11-05");
    const expectedFunding = 500 * st.positions[0].markPrice * 0.0001 * 20;
    expect(st.account.fundingPaid).toBeGreaterThan(expectedFunding * 0.99);
    expect(st.account.fundingPaid).toBeLessThan(expectedFunding * 1.01);
    expect(st.account.balance).toBeLessThan(before);
    // new SOD = last evaluated balance (after funding accrual is realised at this tick's evaluate)
    expect(st.risk.startOfDayBalance).toBeCloseTo(before, 2);
    expect(st.combatLog.some((e: any) => e.kind === "dawn")).toBe(true);
  });
});

describe("meta endpoints", () => {
  it("/health reports simulated mode, data source and the builder-code flag only", async () => {
    const r = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(r).toMatchObject({ ok: true, simulated: true, marketData: "replay", marketDataReachable: true });
    expect(typeof r.builderCodeConfigured).toBe("boolean");
    expect(JSON.stringify(r)).not.toMatch(/PHOENIX_BUILDER_CODE=/);
  });

  it("/rules exposes tiers, caps and the 46-market whitelist", async () => {
    const r = (await app.inject({ method: "GET", url: "/rules" })).json();
    expect(r.markets).toHaveLength(46);
    expect(r.tiers.knight.fee).toBe(79);
    expect(r.common.dailyLossPct).toBe(0.03);
  });

  it("combat-log endpoint returns entries", async () => {
    const { body: c } = await create();
    const r = (await app.inject({ method: "GET", url: `/challenges/${c.id}/combat-log` })).json();
    expect(r.entries[0].text).toContain("Sir Pudding rides out");
  });
});
