import type { Fill } from "@garuda/sim-engine";
import { routingConfigFromEnv } from "../src/config.js";
import type { FillEvent, PhoenixTradingClient, PlaceMirrorOrder } from "../src/types.js";

export class MockPhoenix implements PhoenixTradingClient {
  readonly name = "mock";
  readonly firmAuthority = "FirmAuthority1111111111111111111111111111111";
  readonly delegate = "DelegateKey11111111111111111111111111111111";
  orders: PlaceMirrorOrder[] = [];
  book: Record<string, number> = {};
  failNext = 0;
  async placeMarketOrder(o: PlaceMirrorOrder) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("blockhash expired");
    }
    this.orders.push(o);
    this.book[o.symbol] = (this.book[o.symbol] ?? 0) + (o.side === "buy" ? o.size : -o.size);
    return { signature: `sig${this.orders.length}` };
  }
  async positions() {
    return { ...this.book };
  }
}

export const cfg = (extra: Record<string, string> = {}) =>
  routingConfigFromEnv({
    ROUTING_ENABLED: "true",
    ROUTING_DRY_RUN: "false",
    ROUTING_SIZE_MULTIPLIER: "0.1",
    ROUTING_MAX_TRADE_NOTIONAL_USD: "10000",
    ROUTING_MAX_TRADER_NOTIONAL_USD: "10000",
    ROUTING_MAX_TOTAL_NOTIONAL_USD: "50000",
    ROUTING_DAILY_LOSS_LIMIT_USD: "1000",
    ROUTING_MARKETS: "SOL,BTC,ETH",
    ROUTING_MAX_SLIPPAGE_BPS: "50",
    ROUTING_MIN_ORDER_NOTIONAL_USD: "10",
    ...extra,
  });

let n = 0;
export function fillEvent(o: {
  id?: string; symbol?: string; side: "buy" | "sell"; size: number; price: number; after: number;
  stage?: "evaluation" | "funded"; demo?: boolean; status?: string;
}): FillEvent {
  const symbol = o.symbol ?? "SOL";
  const fill: Fill = {
    id: `f${++n}`, orderId: `o${n}`, symbol, side: o.side, price: o.price, size: o.size, notional: o.size * o.price, fee: 0, liquidity: "taker",
    realizedPnl: 0, closedSize: 0, positionAfter: o.after, forced: false, ts: 0,
  } as Fill;
  return {
    challengeId: o.id ?? "ch_funded", stage: o.stage ?? "funded", demo: o.demo ?? false, wallet: "TraderWallet", status: o.status ?? "active",
    fills: [fill], positions: { [symbol]: o.after },
  };
}
