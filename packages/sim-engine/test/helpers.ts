import type { L2Book } from "../src/index.js";

/** Hand-built SOL book. mid = 100.00, spread = 0.10 */
export function solBook(ts = 1_700_000_000_000): L2Book {
  return {
    symbol: "SOL",
    ts,
    bids: [
      [99.95, 100],
      [99.9, 200],
      [99.8, 300],
    ],
    asks: [
      [100.05, 100],
      [100.1, 200],
      [100.2, 300],
    ],
  };
}
