import { expect } from "vitest";
import { DEFAULT_PAYOUT_POLICY } from "@garuda/risk-engine";
import { FakePayoutExecutor, FakeKnights } from "@garuda/chain";
import { InMemoryPayoutStore, PayoutService, type PayoutServiceOptions, type PayoutStore } from "../src/index.js";
import { makeRig, type Rig } from "./helpers.js";
import type { ServiceDeps } from "../src/index.js";

/** A valid-looking Solana address (base58, 32 bytes) per letter, for wallets in tests. */
export const WALLET_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const WALLET_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export interface PayoutRig extends Rig {
  exec: FakePayoutExecutor;
  payouts: PayoutService;
  store: PayoutStore;
  errors: string[];
}

/**
 * Payout MECHANICS tests earn their profit in one trade on one day, so they switch the best-day rule off
 * (bestDayMaxShare 1). The rule itself is covered in path-to-funded.test.ts with the rulebook default (0.5).
 */
export const NO_BEST_DAY = { ...DEFAULT_PAYOUT_POLICY, bestDayMaxShare: 1 };

export function makePayoutRig(o: { deps?: Partial<ServiceDeps>; exec?: FakePayoutExecutor; store?: PayoutStore; payouts?: Partial<PayoutServiceOptions> } = {}): PayoutRig {
  const rig = makeRig({ payoutPolicy: NO_BEST_DAY, ...o.deps });
  const exec = o.exec ?? new FakePayoutExecutor();
  const store = o.store ?? new InMemoryPayoutStore();
  const errors: string[] = [];
  const payouts = new PayoutService({
    service: rig.svc,
    store,
    executor: exec,
    now: () => rig.clock.t,
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
    ...o.payouts,
  });
  return { ...rig, exec, payouts, store, errors };
}

/**
 * Earn realised profit on a funded account: buy SOL, let the market run up by `move`, sell it all.
 * Returns the resulting balance.
 */
export async function earn(rig: Rig, id: string, opts: { size?: number; move?: number } = {}): Promise<number> {
  const size = opts.size ?? 1000;
  const b = await rig.svc.placeOrder(id, { symbol: "SOL", side: "buy", size, type: "market" });
  if (!b.accepted) throw new Error(`setup buy rejected: ${b.reason}`);
  rig.market.setMove("SOL", opts.move ?? 0.05);
  const s = await rig.svc.placeOrder(id, { symbol: "SOL", side: "sell", size, type: "market", reduceOnly: true });
  if (!s.accepted) throw new Error(`setup sell rejected: ${s.reason}`);
  rig.market.setMove("SOL", 0);
  return s.state.account.balance;
}

export async function fundedAccount(rig: Rig, wallet = WALLET_A, tier: "knight" | "squire" | "paladin" = "knight") {
  return rig.svc.create({ tier, stage: "funded", wallet });
}

export const expectNoDoubleSend = (exec: FakePayoutExecutor) => {
  for (const [id, s] of exec.sent) expect(s.amountBaseUnits > 0n, id).toBe(true);
  expect(exec.sent.size).toBeLessThanOrEqual(exec.submitCalls);
};

export { FakeKnights };
