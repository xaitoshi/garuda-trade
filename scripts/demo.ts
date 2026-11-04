/**
 * Garuda core demo: a $25,000 Knight challenge traded against the LIVE Phoenix L2 book.
 *
 *   pnpm demo          live Phoenix (falls back to recorded books if unreachable)
 *   pnpm demo:mock     force the recorded-book fallback
 *
 * What is real: order book shape, depth, spread, mark price, funding rate (when live).
 * What is scripted: price MOVES after entry (a scenario overlay shifts the real book by x%),
 * because real prices will not move 1% during a demo. The clock is simulated too, so we can
 * cross a UTC midnight and accrue hours of funding.
 */
import {
  OverlayProvider,
  PhoenixSdkProvider,
  ReplayProvider,
  loadRecordedMarkets,
  type MarketDataProvider,
} from "@garuda/market-data";
import { ChallengeService, type ChallengeState, type PlaceOrderResult } from "@garuda/api";
import { quotePayout, usd } from "@garuda/risk-engine";
import { ServiceError } from "@garuda/api";

const HOUR = 3_600_000;
const MIN = 60_000;
const day0 = new Date();
let clock = Date.UTC(day0.getUTCFullYear(), day0.getUTCMonth(), day0.getUTCDate(), 9, 0, 0);

// ----------------------------------------------------------------- data source
let inner: MarketDataProvider;
let sourceNote: string;
const forceMock = process.env.GARUDA_DEMO_MOCK === "1";
if (!forceMock) {
  const live = new PhoenixSdkProvider();
  if (await live.ping()) {
    inner = live;
    sourceNote = "LIVE Phoenix Perps (perp-api.phoenix.trade, read-only, via @ellipsis-labs/rise)";
  } else {
    inner = new ReplayProvider(loadRecordedMarkets());
    sourceNote = "MOCK: Phoenix unreachable, using RECORDED real Phoenix books";
  }
} else {
  inner = new ReplayProvider(loadRecordedMarkets());
  sourceNote = "MOCK (forced): using RECORDED real Phoenix books";
}
const market = new OverlayProvider(inner);
const svc = new ChallengeService({ market, now: () => clock });

// --------------------------------------------------------------------- helpers
const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n=== ${s} ===`);
const sizeFor = (notional: number, price: number) => Number((notional / price).toFixed(3));
const clockStr = () => new Date(clock).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function snap(symbol: string) {
  return market.snapshot(symbol);
}

function showOrder(label: string, r: PlaceOrderResult | undefined) {
  if (!r) return;
  if (!r.accepted) {
    line(`  ${label}: REJECTED (${r.reason})`);
    return;
  }
  const o = r.order!;
  const fills = r.fills;
  if (fills.length) {
    const fee = fills.reduce((s, f) => s + f.fee, 0);
    line(
      `  ${label}: ${o.side} ${o.size} ${o.symbol} ${o.type}, ${fills.length} fill(s) @ avg ${r.avgPrice!.toFixed(4)}, ` +
        `slippage ${r.slippageBps!.toFixed(2)} bps, fee ${usd(fee)} (${fills[0]!.liquidity})`,
    );
  } else {
    line(`  ${label}: ${o.side} ${o.size} ${o.symbol} ${o.type} @ ${o.limitPrice} RESTING (order ${o.id})`);
  }
  for (const c of r.combat) line(`     > ${c.text}`);
}

function showState(s: ChallengeState) {
  const r = s.risk;
  line(
    `  [${clockStr()}] ${s.status.toUpperCase()} | balance ${usd(s.account.balance)} equity ${usd(s.account.equity)} ` +
      `(P&L ${usd(r.profitLoss, { sign: true })})`,
  );
  line(
    `     HP (daily) ${((1 - Math.max(0, r.dailyUsedPct)) * 100).toFixed(0)}%  ` +
      `armor (DD) ${((1 - Math.max(0, r.drawdownUsedPct)) * 100).toFixed(0)}%  ` +
      `boss ${r.targetProgressPct === null ? "-" : (100 - r.targetProgressPct * 100).toFixed(0) + "% HP left"}  ` +
      `| floor ${usd(r.effectiveFloor)} (daily ${usd(r.dailyFloor)}, DD ${usd(r.drawdownFloor)})`,
  );
  for (const p of s.positions) {
    line(`     pos ${p.side} ${p.size} ${p.symbol} @ ${p.entryPrice.toFixed(4)} mark ${p.markPrice.toFixed(4)} uPnL ${usd(p.unrealizedPnl, { sign: true })}`);
  }
}

async function order(id: string, body: Parameters<ChallengeService["placeOrder"]>[1]): Promise<PlaceOrderResult | undefined> {
  try {
    return await svc.placeOrder(id, body);
  } catch (e) {
    if (e instanceof ServiceError) {
      line(`  order refused: ${e.code} (${e.message})`);
      return undefined;
    }
    throw e;
  }
}

// ------------------------------------------------------------------------ demo
h("Garuda core demo");
line(`Market data: ${sourceNote}`);
line("Price MOVES after entry are SCRIPTED (scenario overlay on the real book); clock is simulated.");

const sol0 = await snap("SOL");
line(`\nSOL book: bid ${sol0.book.bids[0]![0]} / ask ${sol0.book.asks[0]![0]}, mark ${sol0.markPrice}, ` +
  `funding ${(sol0.fundingRateHourly * 100).toFixed(5)}%/h, ${sol0.book.bids.length}x${sol0.book.asks.length} levels, ` +
  `source=${sol0.source}${sol0.slot ? ", slot " + sol0.slot : ""}`);

h("Challenge A: Knight $25k, Sir Pudding");
let st = await svc.create({ tier: "knight", knight: "Sir Pudding", wallet: "DemoWallet111111111111111111111111111111111" });
const id = st.id;
showState(st);

// a) ETH short that goes wrong -> HP warnings
line("\n[a] ETH short $100k, then ETH rips +0.30%");
const eth = await snap("ETH");
showOrder("open", await order(id, { symbol: "ETH", side: "sell", size: sizeFor(100_000, eth.markPrice), type: "market" }));
clock += 10 * MIN;
market.setMove("ETH", 0.003);
showState(await svc.tick(id));
showOrder("close", await order(id, { symbol: "ETH", side: "buy", size: sizeFor(100_000, eth.markPrice), type: "market", reduceOnly: true }));

// b) SOL long that works
line("\n[b] SOL long $120k, SOL +1.2%, take profit");
clock += 20 * MIN;
const sol = await snap("SOL");
const solSize = sizeFor(120_000, sol.markPrice);
showOrder("open", await order(id, { symbol: "SOL", side: "buy", size: solSize, type: "market" }));
clock += 15 * MIN;
market.setMove("SOL", 0.012);
showOrder("close", await order(id, { symbol: "SOL", side: "sell", size: solSize, type: "market", reduceOnly: true }));
market.setMove("SOL", 0);

// c) resting BTC limit, maker fill, hold across midnight with funding
line("\n[c] BTC limit buy 0.4% below mid rests; dip fills it as maker; hold overnight (funding accrues)");
clock += 10 * MIN;
const btc = await snap("BTC");
const btcSize = sizeFor(40_000, btc.markPrice);
const btcLimit = Number((btc.book.bids[0]![0] * 0.996).toFixed(0));
showOrder("limit", await order(id, { symbol: "BTC", side: "buy", size: btcSize, type: "limit", limitPrice: btcLimit }));
market.setMove("BTC", -0.005);
clock += 30 * MIN;
st = await svc.tick(id);
for (const f of st.recentFills.slice(-1)) line(`  fill: ${f.side} ${f.size} ${f.symbol} @ ${f.price} (${f.liquidity}), fee ${usd(f.fee)}`);
market.setMove("BTC", 0.002);
clock = Date.UTC(day0.getUTCFullYear(), day0.getUTCMonth(), day0.getUTCDate() + 1, 2, 0, 0); // next UTC day 02:00
st = await svc.tick(id);
line(`  after rollover: day ${st.risk.dayKey}, start-of-day balance ${usd(st.risk.startOfDayBalance)}, daily floor ${usd(st.risk.dailyFloor)}, funding paid so far ${usd(st.account.fundingPaid)}`);
showState(st);

// d) go for the boss
line("\n[d] Close BTC, then SOL long at max-ish size, +0.9%: reach the +10% target");
showOrder("close", await order(id, { symbol: "BTC", side: "sell", size: btcSize, type: "market", reduceOnly: true }));
clock += 20 * MIN;
const solB = await snap("SOL");
const cur = (await svc.getState(id, { refresh: false })).account.equity;
const solSize2 = sizeFor(cur * 9.5, solB.markPrice);
showOrder("open", await order(id, { symbol: "SOL", side: "buy", size: solSize2, type: "market" }));
clock += 15 * MIN;
market.setMove("SOL", 0.011);
st = await svc.tick(id);
showState(st);
const pay = quotePayout({ startingBalance: st.account.startingBalance, balance: st.account.balance, hasOpenPositions: st.positions.length > 0 });
line(`  payout preview if funded: gross ${usd(pay.grossProfit)}, trader 80% ${usd(pay.traderShare)}, eligible=${pay.eligible}`);

h("Combat log (Challenge A)");
for (const e of await svc.getCombatLog(id, 200)) line(`  ${new Date(e.ts).toISOString().slice(11, 16)}  ${e.text}`);

// --------------------------------------------------------------- challenge B
market.setMove("SOL", 0);
h("Challenge B: free Demo ($5k), reckless 9x SOL long, then a -0.5% drop");
clock += HOUR;
const b = await svc.create({ tier: "demo", knight: "Sir Reckless" });
const solC = await snap("SOL");
showOrder("open", await order(b.id, { symbol: "SOL", side: "buy", size: sizeFor(45_000, solC.markPrice), type: "market" }));
for (const mv of [-0.001, -0.0035, -0.005]) {
  clock += 5 * MIN;
  market.setMove("SOL", mv);
  const s = await svc.tick(b.id);
  line(`  SOL ${(mv * 100).toFixed(2)}% -> ${s.status.toUpperCase()} equity ${usd(s.account.equity)} (floor ${usd(s.risk.effectiveFloor)})`);
  if (s.status !== "active") break;
}
for (const e of await svc.getCombatLog(b.id, 50)) line(`  ${new Date(e.ts).toISOString().slice(11, 16)}  ${e.text}`);

h("Done");
line(`Data source for this run: ${sourceNote}`);
await inner.close();
