import { ChallengeService, type ServiceDeps } from "@garuda/api";
import { ReplayProvider, loadRecordedMarkets } from "@garuda/market-data";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);

export function makeRig(deps: Partial<ServiceDeps> = {}) {
  const clock = { t: T0 };
  const market = new ReplayProvider(loadRecordedMarkets());
  const svc = new ChallengeService({ market, now: () => clock.t, enforceGating: false, ...deps });
  return { clock, market, svc };
}

export const fakeTimers = () => {
  const fns = new Map<number, () => void>();
  let n = 0;
  return {
    fns,
    timers: {
      set: (fn: () => void) => {
        fns.set(++n, fn);
        return n;
      },
      clear: (h: unknown) => void fns.delete(h as number),
    },
  };
};

/** Small deterministic PRNG so the replay test is reproducible. */
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
