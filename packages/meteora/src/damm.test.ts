// `./damm` against DAMM v2's SDK, function for function: the same pool, swap and position, the same answer to the raw
// unit. The pools are the kind Graduation makes (spec 3.4): concentrated liquidity over DBC's whole price range, fees in
// the quote, the market-cap scheduler from 1.25% down by 0.01% a step; recorded devnet swaps are checked in
// `tests/devnet/src/graduation.test.ts`.
import { getSwapResultFromExactInput, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { GRADUATED_POOL_FEE, graduatedPoolFeeNumerator } from "./configs";
import { dammFeeNumerator, marketCapScheduler, quoteDammSwap, unclaimedPositionFees, type DammPool } from "./damm";

const MIN_SQRT_PRICE = 4_295_048_016n;
const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;
/** Devnet's graduation price (spec 3.3) and the quote a graduated pool opens with. */
const GRADUATION_SQRT_PRICE = 120_258_058_333_485_015n;
const GRADUATION_QUOTE = 8_483_000_000n;
const ACTIVATION = 1_800_000_000n;

/** The market-cap scheduler's bytes as a pool stores them (`PodAlignedFeeMarketCapScheduler`). */
function schedulerBytes(): number[] {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, (BigInt(GRADUATED_POOL_FEE.poolFeeBps) * 1_000_000_000n) / 10_000n, true);
  view.setUint8(8, 3);
  view.setUint16(14, GRADUATED_POOL_FEE.numberOfPeriod, true);
  view.setUint32(16, GRADUATED_POOL_FEE.sqrtPriceStepBps, true);
  view.setUint32(20, GRADUATED_POOL_FEE.schedulerExpirationDuration, true);
  view.setBigUint64(24, GRADUATED_POOL_FEE.reductionFactor, true);
  return Array.from(bytes);
}

/** A graduated pool at `sqrtPrice`, holding the liquidity that pairs the graduation quote over DBC's range. */
function pool(sqrtPrice = GRADUATION_SQRT_PRICE): DammPool {
  const liquidity = (GRADUATION_QUOTE << 128n) / (GRADUATION_SQRT_PRICE - MIN_SQRT_PRICE);
  return {
    sqrtPrice,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    liquidity,
    activationPoint: ACTIVATION,
    collectFeeMode: 1,
    feeVersion: 1,
    poolFees: {
      protocolFeePercent: 20,
      referralFeePercent: 20,
      compoundingFeeBps: 0,
      initSqrtPrice: GRADUATION_SQRT_PRICE,
      baseFee: { baseFeeInfo: { data: schedulerBytes() } },
      dynamicFee: { initialized: 0 },
    },
  };
}

const bn = (v: bigint) => new BN(v.toString());
const big = (v: BN) => BigInt(v.toString());

/** The same pool as the SDK reads it. */
function sdkPool(p: DammPool) {
  return {
    collectFeeMode: p.collectFeeMode,
    sqrtMinPrice: bn(p.sqrtMinPrice),
    sqrtMaxPrice: bn(p.sqrtMaxPrice),
    sqrtPrice: bn(p.sqrtPrice),
    liquidity: bn(p.liquidity),
    activationPoint: bn(p.activationPoint),
    feeVersion: p.feeVersion,
    tokenAAmount: new BN(0),
    tokenBAmount: new BN(0),
    poolFees: {
      baseFee: { baseFeeInfo: { data: p.poolFees.baseFee.baseFeeInfo.data } },
      protocolFeePercent: p.poolFees.protocolFeePercent,
      referralFeePercent: p.poolFees.referralFeePercent,
      compoundingFeeBps: p.poolFees.compoundingFeeBps,
      initSqrtPrice: bn(p.poolFees.initSqrtPrice),
      dynamicFee: { initialized: 0 },
    },
  };
}

function sdkQuote(p: DammPool, side: "buy" | "sell", amountIn: bigint, at: bigint, hasReferral: boolean) {
  // `TradeDirection`: AtoB sells the coin, BtoA buys it; on a pool collecting in B a buy's fee comes off its input.
  const direction = side === "buy" ? 1 : 0;
  const feeMode = { feesOnInput: side === "buy", feesOnTokenA: false, hasReferral };
  const r = getSwapResultFromExactInput(sdkPool(p) as never, bn(amountIn), feeMode, direction, bn(at));
  const fee = big(r.claimingFee) + big(r.protocolFee) + big(r.referralFee) + big(r.compoundingFee);
  return {
    amountOut: big(r.outputAmount),
    fee,
    tradingFee: big(r.claimingFee),
    protocolFee: big(r.protocolFee),
    referralFee: big(r.referralFee),
    nextSqrtPrice: big(r.nextSqrtPrice),
  };
}

describe("a graduated pool's fee", () => {
  it("reads the scheduler Graduation sets (spec 3.4)", () => {
    expect(marketCapScheduler(schedulerBytes())).toEqual({
      cliffFeeNumerator: 12_500_000n,
      baseFeeMode: 3,
      numberOfPeriod: 100,
      sqrtPriceStepBps: 900,
      schedulerExpirationDuration: 315_360_000,
      reductionFactor: 100_000n,
    });
  });

  it("starts at 1.25% and steps down 0.01% for every 9% the square-root price rises, to 0.25% at 100x the market cap", () => {
    const at = ACTIVATION + 60n;
    expect(dammFeeNumerator(pool(), at)).toBe(12_500_000n);
    // The first price a whole step above, rounding up.
    const step = (GRADUATION_SQRT_PRICE * 9n + 99n) / 100n;
    expect(dammFeeNumerator(pool(GRADUATION_SQRT_PRICE + step), at)).toBe(12_400_000n);
    expect(dammFeeNumerator(pool(GRADUATION_SQRT_PRICE + step - 1n), at)).toBe(12_500_000n);
    expect(dammFeeNumerator(pool(GRADUATION_SQRT_PRICE * 10n), at)).toBe(2_500_000n);
    expect(dammFeeNumerator(pool(GRADUATION_SQRT_PRICE * 20n), at)).toBe(2_500_000n);
    // Below the graduation price, the fee climbs back to the top.
    expect(dammFeeNumerator(pool(GRADUATION_SQRT_PRICE / 2n), at)).toBe(12_500_000n);
    // The same as the configs' own reading of the schedule.
    for (const sqrtPrice of [GRADUATION_SQRT_PRICE, GRADUATION_SQRT_PRICE + 3n * step, GRADUATION_SQRT_PRICE * 4n]) {
      expect(dammFeeNumerator(pool(sqrtPrice), at)).toBe(graduatedPoolFeeNumerator(GRADUATION_SQRT_PRICE, sqrtPrice));
    }
  });

  it("rests at its lowest once the schedule expires, 10 years after Graduation", () => {
    expect(dammFeeNumerator(pool(), ACTIVATION + 315_360_001n)).toBe(2_500_000n);
  });
});

describe("a swap's quote on a graduated pool, against DAMM v2's SDK", () => {
  const prices = [GRADUATION_SQRT_PRICE, (GRADUATION_SQRT_PRICE * 137n) / 100n, (GRADUATION_SQRT_PRICE * 61n) / 100n, GRADUATION_SQRT_PRICE * 9n];
  const amounts = {
    buy: [1n, 999n, 12_345_678n, 1_000_000_000n, 25_000_000_000n],
    sell: [1n, 1_000n, 3_000_000_000_000n, 150_000_000_000_000n, 700_000_000_000_000n],
  };
  for (const side of ["buy", "sell"] as const) {
    for (const hasReferral of [true, false]) {
      it(`agrees to the raw unit on a ${side}, ${hasReferral ? "with" : "without"} a referral account`, () => {
        for (const sqrtPrice of prices) {
          for (const amountIn of amounts[side]) {
            const p = pool(sqrtPrice);
            const at = ACTIVATION + 3_600n;
            const ours = quoteDammSwap({ pool: p, side, amountIn, currentPoint: at, hasReferral });
            const theirs = sdkQuote(p, side, amountIn, at, hasReferral);
            expect({ ...ours, amountIn: undefined, amountLeft: undefined, quoteAmount: undefined }).toEqual({
              ...theirs,
              amountIn: undefined,
              amountLeft: undefined,
              quoteAmount: undefined,
            });
            expect(ours.fee).toBe(ours.tradingFee + ours.protocolFee + ours.referralFee);
            expect(ours.quoteAmount).toBe(side === "buy" ? amountIn : ours.amountOut + ours.fee);
          }
        }
      });
    }
  }

  it("refuses what Graduation's pools never are", () => {
    expect(() => quoteDammSwap({ pool: { ...pool(), collectFeeMode: 0 }, side: "buy", amountIn: 1n, currentPoint: ACTIVATION, hasReferral: true })).toThrow(/quote alone/);
    expect(() => quoteDammSwap({ pool: pool(), side: "buy", amountIn: 0n, currentPoint: ACTIVATION, hasReferral: true })).toThrow(/nothing/);
  });
});

describe("a position's unclaimed fees, against DAMM v2's SDK", () => {
  const u256 = (v: bigint) => Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
  it("is its pending fees plus its liquidity's share since its checkpoint, to the raw unit", () => {
    const cases = [
      { perLiquidity: 0n, checkpoint: 0n, pending: 0n },
      { perLiquidity: 123_456_789_012_345_678_901_234_567_890n, checkpoint: 0n, pending: 0n },
      { perLiquidity: 9n << 140n, checkpoint: 5n << 140n, pending: 77n },
      // The counter wrapped past 2^256.
      { perLiquidity: 3n, checkpoint: (1n << 256n) - 5n, pending: 0n },
    ];
    for (const c of cases) {
      const poolFees = { feeAPerLiquidity: u256(0n), feeBPerLiquidity: u256(c.perLiquidity) };
      const position = {
        feeAPerTokenCheckpoint: u256(0n),
        feeBPerTokenCheckpoint: u256(c.checkpoint),
        feeAPending: 0n,
        feeBPending: c.pending,
        unlockedLiquidity: 0n,
        vestedLiquidity: 0n,
        permanentLockedLiquidity: 41_234_567_890_123_456_789_012_345n,
      };
      const ours = unclaimedPositionFees(poolFees, position);
      const theirs = getUnClaimLpFee(
        { ...poolFees, rewardInfos: [] } as never,
        {
          ...position,
          feeAPending: bn(0n),
          feeBPending: bn(c.pending),
          unlockedLiquidity: bn(0n),
          vestedLiquidity: bn(0n),
          permanentLockedLiquidity: bn(position.permanentLockedLiquidity),
          rewardInfos: [],
        } as never,
      );
      expect(ours).toEqual({ coin: big(theirs.feeTokenA), quote: big(theirs.feeTokenB) });
    }
  });
});
