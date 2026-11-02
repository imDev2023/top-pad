import { describe, expect, it } from "vitest";
import recorded from "./fixtures/swaps.json" with { type: "json" };
import type { SwapFixtures } from "./fixtures/types";
import { minimumOut, quoteSwap, type QuoteConfig, type QuotePool } from "./quote";

const fixtures = recorded as SwapFixtures;
type Fixture = SwapFixtures["pools"][number];

function configOf({ config: c }: Fixture): QuoteConfig {
  return {
    collectFeeMode: c.collectFeeMode,
    sqrtStartPrice: BigInt(c.sqrtStartPrice),
    migrationQuoteThreshold: BigInt(c.migrationQuoteThreshold),
    migrationSqrtPrice: BigInt(c.migrationSqrtPrice),
    curve: c.curve.map((p) => ({ sqrtPrice: BigInt(p.sqrtPrice), liquidity: BigInt(p.liquidity) })),
    enableFirstSwapWithMinFee: c.enableFirstSwapWithMinFee,
    quoteTokenFlag: c.quoteTokenFlag,
    transferFeeFlag: c.transferFeeFlag,
    transferFeeBasisPoints: c.transferFeeBasisPoints,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: BigInt(c.baseFee.cliffFeeNumerator),
        firstFactor: c.baseFee.firstFactor,
        secondFactor: BigInt(c.baseFee.secondFactor),
        thirdFactor: BigInt(c.baseFee.thirdFactor),
        baseFeeMode: c.baseFee.baseFeeMode,
      },
      dynamicFee: c.dynamicFee,
    },
  };
}

/** The pool as it stood before each of its swaps, from the curve's start and each swap's own event. */
function* replay(fixture: Fixture) {
  const config = configOf(fixture);
  let pool: QuotePool = {
    sqrtPrice: config.sqrtStartPrice,
    quoteReserve: 0n,
    activationPoint: BigInt(fixture.activationPoint),
    hasSwap: 0,
    volatilityTracker: { volatilityAccumulator: 0n },
  };
  for (const swap of fixture.swaps) {
    yield { config, pool, swap };
    pool = { ...pool, sqrtPrice: BigInt(swap.nextSqrtPrice), quoteReserve: BigInt(swap.quoteReserve), hasSwap: 1 };
  }
}

describe("a quote, against every swap recorded on devnet", () => {
  it("has swaps to replay: buys and sells, inside the sniper tax's minute and after it, on both of Heat's configs", () => {
    const all = fixtures.pools.flatMap((p) => p.swaps.map((s) => ({ ...s, seconds: Number(s.timestamp) - Number(p.activationPoint), config: p.config.address })));
    expect(all.filter((s) => s.side === "buy" && !s.inCreation).length).toBeGreaterThan(5);
    expect(all.filter((s) => s.side === "sell").length).toBeGreaterThan(5);
    expect(all.some((s) => s.seconds < 60 && !s.inCreation)).toBe(true);
    expect(all.some((s) => s.seconds >= 60)).toBe(true);
    expect(new Set(all.map((s) => s.config)).size).toBe(2);
    // Swaps Heat's site builds name Heat's referral account (#43): its share comes out of Meteora's.
    expect(all.filter((s) => s.hasReferral && s.side === "buy").length).toBeGreaterThan(1);
    expect(all.filter((s) => s.hasReferral && s.side === "sell").length).toBeGreaterThan(1);
    expect(all.some((s) => s.swapMode === 1)).toBe(true);
  });

  for (const fixture of fixtures.pools) {
    it(`matches DBC to the raw unit on pool ${fixture.pool}`, () => {
      let replayed = 0;
      for (const { config, pool, swap } of replay(fixture)) {
        // A Fair Open's pot buy runs in the pool's creation transaction, where its config grants the first swap its
        // minimum fee (spec 2.1 step 10): something no quick buy can ever claim, so it only moves the pool on.
        if (swap.inCreation && pool.hasSwap === 0 && config.enableFirstSwapWithMinFee) continue;
        const quote = quoteSwap({
          pool,
          config,
          side: swap.side,
          amountIn: BigInt(swap.amountIn),
          currentPoint: BigInt(swap.timestamp),
          hasReferral: swap.hasReferral,
        });
        const what = `the ${swap.side} in ${swap.signature}, ${Number(swap.timestamp) - Number(fixture.activationPoint)} s after the open`;
        expect(
          {
            taken: quote.amountIn,
            amountOut: quote.amountOut,
            tradingFee: quote.tradingFee,
            protocolFee: quote.protocolFee,
            referralFee: quote.referralFee,
            nextSqrtPrice: quote.nextSqrtPrice,
          },
          what,
        ).toEqual({
          taken: BigInt(swap.taken),
          amountOut: BigInt(swap.amountOut),
          tradingFee: BigInt(swap.tradingFee),
          protocolFee: BigInt(swap.protocolFee),
          referralFee: BigInt(swap.referralFee),
          nextSqrtPrice: BigInt(swap.nextSqrtPrice),
        });
        // The trade the indexer records (#42): its fee is the three parts, its quote side the fee's base.
        expect(quote.fee).toBe(BigInt(swap.tradingFee) + BigInt(swap.protocolFee) + BigInt(swap.referralFee));
        expect(quote.quoteAmount).toBe(swap.side === "buy" ? BigInt(swap.taken) : BigInt(swap.amountOut) + quote.fee);
        expect(quote.amountOut).toBeGreaterThanOrEqual(BigInt(swap.minimumOut));
        replayed++;
      }
      expect(replayed).toBeGreaterThan(0);
    });
  }
});

describe("a quote", () => {
  const fixture = fixtures.pools.find((p) => p.config.enableFirstSwapWithMinFee === 0)!;
  const config = configOf(fixture);
  const start: QuotePool = {
    sqrtPrice: config.sqrtStartPrice,
    quoteReserve: 0n,
    activationPoint: BigInt(fixture.activationPoint),
    hasSwap: 1,
    volatilityTracker: { volatilityAccumulator: 0n },
  };
  const at = (seconds: number) => BigInt(fixture.activationPoint) + BigInt(seconds);
  const buy = (amountIn: bigint, seconds: number, hasReferral = false) => quoteSwap({ pool: start, config, side: "buy", amountIn, currentPoint: at(seconds), hasReferral });

  it("pays the sniper tax its second calls for, falling to the 1.25% trading fee once the minute is over", () => {
    const rates = [0, 1, 30, 59, 60, 600].map((s) => Number(buy(1_000_000_000n, s).fee) / 1e9);
    expect(rates[0]).toBeCloseTo(0.99, 6);
    expect(rates[1]! - rates[2]!).toBeGreaterThan(0);
    expect(rates[3]).toBeGreaterThan(0.0125);
    expect(rates[4]).toBeCloseTo(0.0125, 9);
    expect(rates[5]).toBeCloseTo(0.0125, 9);
  });

  it("gives a referral account a fifth of Meteora's fifth, out of Meteora's share, the fee itself unchanged", () => {
    const plain = buy(1_000_000_000n, 120);
    const referred = buy(1_000_000_000n, 120, true);
    expect(referred.fee).toBe(plain.fee);
    expect(referred.amountOut).toBe(plain.amountOut);
    expect(referred.tradingFee).toBe(plain.tradingFee);
    expect(referred.referralFee).toBe(plain.protocolFee / 5n);
    expect(referred.protocolFee + referred.referralFee).toBe(plain.protocolFee);
    // About 0.05% of the trade (spec 4).
    expect(Number(referred.referralFee) / 1e9).toBeCloseTo(0.0005, 6);
  });

  it("fills a buy only up to the curve's end, leaving the rest to the trader", () => {
    const whole = buy(1_000_000_000n, 120);
    expect(whole.amountLeft).toBe(0n);
    expect(whole.amountIn).toBe(1_000_000_000n);
    const past = buy(50_000_000_000n, 120);
    expect(past.amountLeft).toBeGreaterThan(0n);
    expect(past.amountIn + past.amountLeft).toBe(50_000_000_000n);
    expect(past.nextSqrtPrice).toBe(config.migrationSqrtPrice);
  });

  it("refuses to sell more than the curve has bought", () => {
    expect(() => quoteSwap({ pool: { ...start, hasSwap: 0 }, config, side: "sell", amountIn: 1_000_000n, currentPoint: at(120), hasReferral: false })).toThrow();
  });

  it("allows for the price moving by the slippage asked", () => {
    expect(minimumOut(1_000_000n, 100)).toBe(990_000n);
    expect(minimumOut(999n, 50)).toBe(994n);
  });
});
