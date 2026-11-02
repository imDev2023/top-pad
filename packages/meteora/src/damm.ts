// A swap's quote on a graduated Heat pool, DAMM v2 (spec 3.4, 10.1), and what a position has accrued: DAMM v2's own
// integer maths, as its SDK (`@meteora-ag/cp-amm-sdk`) and program run them, for the one kind of pool Graduation makes:
// concentrated liquidity, fees collected in the quote alone (token B), the market-cap fee scheduler and no dynamic fee.
// Plain bigints in and out, and none of the SDK, whose main entry would bring Anchor and its IDL into the API Worker
// (about 380 KiB gzipped, against the DBC maths' 87); `damm.test.ts` checks every function against the SDK's own, and
// `tests/devnet` against real swaps.
import type { Pool, Position } from "@top-pad/clients/damm-v2";

/** The pool's state a quote reads. */
export type DammPool = Pick<Pool, "sqrtPrice" | "sqrtMinPrice" | "sqrtMaxPrice" | "liquidity" | "activationPoint" | "collectFeeMode" | "feeVersion"> & {
  poolFees: Pick<Pool["poolFees"], "protocolFeePercent" | "referralFeePercent" | "compoundingFeeBps" | "initSqrtPrice"> & {
    baseFee: { baseFeeInfo: { data: ArrayLike<number> } };
    dynamicFee: Pick<Pool["poolFees"]["dynamicFee"], "initialized">;
  };
};

/** What a swap does, in raw units, as DAMM v2 computes it; the same shape as a curve's quote (`./quote`). */
export type DammQuote = {
  amountIn: bigint;
  /** Always 0: an exact-in swap on a graduated pool spends all it is given or fails. */
  amountLeft: bigint;
  amountOut: bigint;
  /** The whole fee, in the quote, and its parts: the liquidity's, Meteora's and the referral's. */
  fee: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  /** The quote side of the trade before the fee: the fee's base. */
  quoteAmount: bigint;
  nextSqrtPrice: bigint;
};

const FEE_DENOMINATOR = 1_000_000_000n;
/** The most a pool's fee may be: half for a pool of fee version 0, 99% for version 1. */
const MAX_FEE_NUMERATOR = [500_000_000n, 990_000_000n];
const BASIS_POINT_MAX = 10_000n;
/** `CollectFeeMode::OnlyB`: every fee in the quote, which is how Graduation makes a Heat coin's pool (spec 3.4). */
const ONLY_B = 1;
/** `BaseFeeMode::FeeMarketCapSchedulerLinear`. */
const MARKET_CAP_SCHEDULER_LINEAR = 3;
const U64_MAX = (1n << 64n) - 1n;
const U256_MODULUS = 1n << 256n;

const mulDiv = (x: bigint, y: bigint, d: bigint, up: boolean) => {
  const product = x * y;
  const q = product / d;
  return up && q * d !== product ? q + 1n : q;
};

/** The market-cap fee scheduler, as the pool stores it (`PodAlignedFeeMarketCapScheduler`). */
export function marketCapScheduler(data: ArrayLike<number>) {
  const bytes = Uint8Array.from(data);
  const view = new DataView(bytes.buffer);
  const scheduler = {
    cliffFeeNumerator: view.getBigUint64(0, true),
    baseFeeMode: view.getUint8(8),
    numberOfPeriod: view.getUint16(14, true),
    sqrtPriceStepBps: view.getUint32(16, true),
    schedulerExpirationDuration: view.getUint32(20, true),
    reductionFactor: view.getBigUint64(24, true),
  };
  if (scheduler.baseFeeMode !== MARKET_CAP_SCHEDULER_LINEAR) throw new Error(`the pool's base fee is mode ${scheduler.baseFeeMode}, not Graduation's linear market-cap scheduler`);
  return scheduler;
}

/**
 * The pool's fee numerator for a swap at `currentPoint` (Unix seconds): its market-cap scheduler, falling one step for
 * each `sqrt_price_step_bps` the price stands above its graduation price, until the schedule expires and the fee rests
 * at its lowest (spec 3.4).
 */
export function dammFeeNumerator(pool: DammPool, currentPoint: bigint): bigint {
  const s = marketCapScheduler(pool.poolFees.baseFee.baseFeeInfo.data);
  const periods = BigInt(s.numberOfPeriod);
  const expires = pool.activationPoint + BigInt(s.schedulerExpirationDuration);
  let period: bigint;
  if (currentPoint > expires || currentPoint < pool.activationPoint) {
    period = periods;
  } else if (pool.sqrtPrice <= pool.poolFees.initSqrtPrice) {
    period = 0n;
  } else {
    const passed = ((pool.sqrtPrice - pool.poolFees.initSqrtPrice) * BASIS_POINT_MAX) / pool.poolFees.initSqrtPrice / BigInt(s.sqrtPriceStepBps);
    period = passed < periods ? passed : periods;
  }
  const base = s.cliffFeeNumerator - period * s.reductionFactor;
  const max = MAX_FEE_NUMERATOR[pool.feeVersion];
  if (max === undefined) throw new Error(`fee version ${pool.feeVersion} is unknown`);
  return base < max ? base : max;
}

/** A fee split as DAMM v2 splits it: Meteora's protocol share, the referral's out of it, and the liquidity's rest. */
function splitFee(pool: DammPool, fee: bigint, hasReferral: boolean) {
  let protocolFee = (fee * BigInt(pool.poolFees.protocolFeePercent)) / 100n;
  const tradingFee = fee - protocolFee;
  const referralFee = hasReferral ? (protocolFee * BigInt(pool.poolFees.referralFeePercent)) / 100n : 0n;
  protocolFee -= referralFee;
  return { tradingFee, protocolFee, referralFee };
}

/** The coin a quote buys from `sqrtPrice` up to `nextSqrtPrice`, rounded down. */
const amountA = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => mulDiv(liquidity, upper - lower, lower * upper, up);
/** The quote between two prices, rounded as asked. */
const amountB = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => {
  const product = liquidity * (upper - lower);
  const shift = 1n << 128n;
  return up ? (product + shift - 1n) / shift : product / shift;
};

/**
 * A swap's quote on a graduated pool, exact in, as DAMM v2 would run it at `currentPoint`: a buy spends the quote, the
 * fee taken off its input first; a sell spends the coin, the fee taken off the quote it returns. Throws, as the program
 * refuses, when a swap would take the price out of the pool's range.
 */
export function quoteDammSwap(r: { pool: DammPool; side: "buy" | "sell"; amountIn: bigint; currentPoint: bigint; hasReferral: boolean }): DammQuote {
  const { pool, amountIn, hasReferral } = r;
  if (pool.collectFeeMode !== ONLY_B) throw new Error("the graduated pool does not collect its fees in the quote alone");
  if (pool.poolFees.dynamicFee.initialized !== 0) throw new Error("the graduated pool has a dynamic fee, which Graduation never sets");
  if (pool.poolFees.compoundingFeeBps !== 0) throw new Error("the graduated pool compounds its fees, which Graduation never sets");
  if (amountIn <= 0n) throw new Error("nothing to swap");
  const numerator = dammFeeNumerator(pool, r.currentPoint);
  const { sqrtPrice, liquidity } = pool;
  if (r.side === "buy") {
    // Quote in (B to A), the fee off the input.
    const fee = mulDiv(amountIn, numerator, FEE_DENOMINATOR, true);
    const net = amountIn - fee;
    const nextSqrtPrice = sqrtPrice + (net << 128n) / liquidity;
    if (nextSqrtPrice > pool.sqrtMaxPrice) throw new Error("the buy would take the price above the pool's range");
    const amountOut = amountA(sqrtPrice, nextSqrtPrice, liquidity, false);
    return { amountIn, amountLeft: 0n, amountOut, fee, ...splitFee(pool, fee, hasReferral), quoteAmount: amountIn, nextSqrtPrice };
  }
  // Coin in (A to B), the fee off the output.
  const nextSqrtPrice = amountIn === 0n ? sqrtPrice : mulDiv(liquidity, sqrtPrice, liquidity + amountIn * sqrtPrice, true);
  if (nextSqrtPrice < pool.sqrtMinPrice) throw new Error("the sell would take the price below the pool's range");
  const gross = amountB(nextSqrtPrice, sqrtPrice, liquidity, false);
  const fee = mulDiv(gross, numerator, FEE_DENOMINATOR, true);
  return { amountIn, amountLeft: 0n, amountOut: gross - fee, fee, ...splitFee(pool, fee, hasReferral), quoteAmount: gross, nextSqrtPrice };
}

/** A 256-bit little-endian integer, as DAMM v2 keeps its fee-per-liquidity counters. */
const u256 = (bytes: ArrayLike<number>) => Array.from(bytes).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

/**
 * What a position has accrued and not yet claimed, in raw units of each token: its pending fees plus its liquidity's
 * share of what the pool earned since the position's checkpoint. On a Heat coin's graduated pool the coin's is always
 * 0, since the pool collects in the quote.
 */
export function unclaimedPositionFees(
  pool: { feeAPerLiquidity: ArrayLike<number>; feeBPerLiquidity: ArrayLike<number> },
  position: Pick<Position, "feeAPending" | "feeBPending" | "unlockedLiquidity" | "vestedLiquidity" | "permanentLockedLiquidity"> & {
    feeAPerTokenCheckpoint: ArrayLike<number>;
    feeBPerTokenCheckpoint: ArrayLike<number>;
  },
): { coin: bigint; quote: bigint } {
  const liquidity = position.unlockedLiquidity + position.vestedLiquidity + position.permanentLockedLiquidity;
  const accrued = (perLiquidity: ArrayLike<number>, checkpoint: ArrayLike<number>) => {
    const delta = (((u256(perLiquidity) - u256(checkpoint)) % U256_MODULUS) + U256_MODULUS) % U256_MODULUS;
    const fee = (liquidity * delta) >> 128n;
    return fee > U64_MAX ? U64_MAX : fee;
  };
  const add = (pending: bigint, fee: bigint) => (pending + fee > U64_MAX ? U64_MAX : pending + fee);
  return {
    coin: add(position.feeAPending, accrued(pool.feeAPerLiquidity, position.feeAPerTokenCheckpoint)),
    quote: add(position.feeBPending, accrued(pool.feeBPerLiquidity, position.feeBPerTokenCheckpoint)),
  };
}
