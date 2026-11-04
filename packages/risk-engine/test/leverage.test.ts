import { describe, expect, it } from "vitest";
import {
  assetClassOf,
  checkOrderLeverage,
  isWhitelisted,
  leverageCap,
  maxOrderSize,
  normalizeSymbol,
  requiredMargin,
  WHITELIST,
} from "../src/index.js";

describe("whitelist and caps", () => {
  it("has 46 markets matching the rulebook", () => {
    expect(WHITELIST).toHaveLength(46);
    expect(isWhitelisted("SOL-PERP")).toBe(true);
    expect(isWhitelisted("xrp")).toBe(false);
    expect(isWhitelisted("ANTHROPIC")).toBe(false);
  });

  it("maps classes to the rulebook caps", () => {
    expect(leverageCap("BTC")).toBe(10);
    expect(leverageCap("ETH")).toBe(10);
    expect(leverageCap("SOL")).toBe(10);
    expect(leverageCap("DOGE")).toBe(2);
    expect(leverageCap("NVDA")).toBe(4);
    expect(leverageCap("SPY")).toBe(10);
    expect(leverageCap("QQQ")).toBe(10);
    expect(leverageCap("TLT")).toBe(5);
    expect(leverageCap("GOLD")).toBe(8);
    expect(leverageCap("WTIOIL")).toBe(8);
    expect(leverageCap("COPPER")).toBe(5);
    expect(leverageCap("XRP")).toBeUndefined();
    expect(assetClassOf("HYPE")).toBe("other_crypto");
    expect(normalizeSymbol(" sol-perp ")).toBe("SOL");
  });
});

describe("margin-style leverage check", () => {
  const eq = 25_000;
  it("required margin = sum(notional / cap)", () => {
    expect(
      requiredMargin([
        { symbol: "SOL", size: 1000, markPrice: 100 }, // 100k / 10 = 10k
        { symbol: "DOGE", size: -100_000, markPrice: 0.2 }, // 20k / 2 = 10k
      ]),
    ).toBeCloseTo(20_000, 8);
  });

  it("allows up to 10x on SOL and rejects beyond", () => {
    const ok = checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "SOL", side: "buy", size: 2500, markPrice: 100 } });
    expect(ok.allowed).toBe(true); // exactly 250k notional = 10x
    const bad = checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "SOL", side: "buy", size: 2501, markPrice: 100 } });
    expect(bad).toMatchObject({ allowed: false, reason: "leverage_cap_exceeded" });
  });

  it("caps other crypto at 2x ($50k notional on $25k)", () => {
    expect(checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "DOGE", side: "buy", size: 250_000, markPrice: 0.2 } }).allowed).toBe(true);
    expect(checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "DOGE", side: "buy", size: 250_001, markPrice: 0.2 } }).allowed).toBe(false);
  });

  it("caps single stocks at 4x ($100k)", () => {
    expect(checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "NVDA", side: "buy", size: 500, markPrice: 200 } }).allowed).toBe(true);
    expect(checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "NVDA", side: "buy", size: 501, markPrice: 200 } }).allowed).toBe(false);
  });

  it("aggregates margin across markets", () => {
    const positions = [{ symbol: "SOL", size: 2000, markPrice: 100 }]; // 20k margin
    const r = checkOrderLeverage({ equity: eq, positions, order: { symbol: "NVDA", side: "buy", size: 300, markPrice: 200 } }); // +15k
    expect(r.allowed).toBe(false);
    expect(r.requiredMarginAfter).toBeCloseTo(35_000, 8);
  });

  it("reducing and reduce-only orders are always allowed, even when over the cap after a price move", () => {
    const positions = [{ symbol: "SOL", size: 3000, markPrice: 100 }]; // 30k margin > 25k equity
    expect(checkOrderLeverage({ equity: eq, positions, order: { symbol: "SOL", side: "sell", size: 500, markPrice: 100 } }).allowed).toBe(true);
    expect(checkOrderLeverage({ equity: eq, positions, order: { symbol: "SOL", side: "buy", size: 1, markPrice: 100 } }).allowed).toBe(false);
    expect(checkOrderLeverage({ equity: eq, positions, order: { symbol: "SOL", side: "buy", size: 5, markPrice: 100, reduceOnly: true } }).allowed).toBe(true);
  });

  it("non-whitelisted markets cannot be opened", () => {
    const r = checkOrderLeverage({ equity: eq, positions: [], order: { symbol: "XRP", side: "buy", size: 1, markPrice: 2 } });
    expect(r).toMatchObject({ allowed: false, reason: "market_not_whitelisted" });
  });

  it("maxOrderSize matches the check boundary", () => {
    const args = { equity: eq, positions: [], symbol: "SOL", side: "buy" as const, markPrice: 100 };
    expect(maxOrderSize(args)).toBeCloseTo(2500, 6);
    const long = [{ symbol: "SOL", size: 1000, markPrice: 100 }];
    expect(maxOrderSize({ ...args, positions: long })).toBeCloseTo(1500, 6);
    // selling from a 1000 long: close 1000, then up to 2500 short => 3500
    expect(maxOrderSize({ ...args, positions: long, side: "sell" })).toBeCloseTo(3500, 6);
  });
});
