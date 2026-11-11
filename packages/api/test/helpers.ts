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
