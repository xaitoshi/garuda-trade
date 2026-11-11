import { ReplayProvider, loadRecordedMarkets } from "@garuda/market-data";
import { ChallengeService, type ServiceDeps } from "../src/index.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);

export interface Rig {
  market: ReplayProvider;
  svc: ChallengeService;
  clock: { t: number };
}

export function makeRig(deps: Partial<ServiceDeps> = {}): Rig {
  const clock = { t: T0 };
  const market = new ReplayProvider(loadRecordedMarkets());
  const svc = new ChallengeService({ market, now: () => clock.t, enforceGating: false, ...deps });
  return { market, svc, clock };
}

/** Open a SOL long and crash the market until the challenge is wounded (daily loss). Size scales with account size. */
export async function breach(rig: Rig, id: string, _size = 1000) {
  const start = (await rig.svc.getState(id, { refresh: false })).account.startingBalance;
  const size = Math.max(20, Math.round((start / 25_000) * 1000));
  const r = await rig.svc.placeOrder(id, { symbol: "SOL", side: "buy", size, type: "market" });
  if (!r.accepted) throw new Error(`setup order rejected: ${r.reason}`);
  rig.market.setMove("SOL", -0.1);
  const st = await rig.svc.tick(id);
  if (st.status !== "wounded") throw new Error(`expected wounded, got ${st.status}`);
  rig.market.setMove("SOL", 0);
  return st;
}

/**
 * Pass an evaluation the Path to Funded way (rulebook section 9): three UTC days, each with one closed winning trade of
 * the same size, so the closed balance reaches +10%, the book is flat, there are 3 trading days and no day is more
 * than 50% of the profit. Size scales with the account. Advances the rig clock by a day between trades.
 */
export async function passEvaluation(rig: Rig, id: string, opts: { move?: number; maxDays?: number } = {}) {
  const start = (await rig.svc.getState(id, { refresh: false })).account.startingBalance;
  const size = Math.round((start * 2400) / 25_000);
  const move = opts.move ?? 0.0065;
  for (let day = 0; day < (opts.maxDays ?? 5); day++) {
    if (day > 0) rig.clock.t += DAY;
    const b = await rig.svc.placeOrder(id, { symbol: "SOL", side: "buy", size, type: "market" });
    if (!b.accepted) throw new Error(`setup buy rejected: ${b.reason}`);
    rig.market.setMove("SOL", move);
    const s = await rig.svc.placeOrder(id, { symbol: "SOL", side: "sell", size, type: "market", reduceOnly: true });
    rig.market.setMove("SOL", 0);
    if (!s.accepted) throw new Error(`setup sell rejected: ${s.reason}`);
    if (s.state.status === "passed") return s.state;
    if (s.state.status !== "active") throw new Error(`expected active, got ${s.state.status}`);
  }
  const st = await rig.svc.getState(id, { refresh: false });
  throw new Error(`did not pass: ${JSON.stringify(st.pathToFunded)}`);
}
