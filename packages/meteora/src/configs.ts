// Heat's two DBC configs (spec 3): curve A for a Graduation Target, the sniper tax, the graduated pool's market-cap fee
// scheduler and the rest of spec 3.2's table, as `create_config2`'s arguments for the generated client. Every integer
// is exact: the curve is solved in bigint arithmetic, then run through DBC's own `create_config` rules, mirrored below
// from release 0.2.2 (`MeteoraAg/dynamic-bonding-curve` at 91e696e: `process_create_config.rs`, `curve.rs`,
// `params/liquidity_distribution.rs`, `migration_handler/concentrated_liquidity.rs`, `state/config.rs`), so a config
// DBC would refuse, or one that would graduate anywhere but its curve's last point, never leaves this module. A config
// cannot be changed once created (spec 3.2).
import { COIN_DECIMALS, COIN_SUPPLY, FEE_DENOMINATOR, SNIPER_TAX, sniperTaxNumerator } from "@top-pad/chain";
import type { ConfigParametersArgs } from "@top-pad/clients/dbc";

// The coin and the sniper tax live in @top-pad/chain, where the API and the indexer read them too.
export { COIN_DECIMALS, COIN_SUPPLY, FEE_DENOMINATOR, SNIPER_TAX, sniperTaxNumerator };

export type LaunchMode = "fairOpen" | "instant";

/** DBC's bounds on a square-root price, in Q64.64 (`constants.rs`). */
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;
const Q128 = 1n << 128n;

/**
 * The graduated pool's fee (spec 3.4): DAMM v2's linear market-cap scheduler from 1.25% at Graduation down 0.01% a
 * step for 100 steps, a step every 9% of the graduation square-root price, so the last lands at exactly 10x that price
 * (100x the market cap); it expires 10 years after Graduation. `sqrtPriceStepBps` counts as DAMM v2's
 * `fee_market_cap_scheduler.rs` does: passed steps = (sqrt price - initial) * 10,000 / initial / step.
 */
export const GRADUATED_POOL_FEE = {
  poolFeeBps: 125,
  numberOfPeriod: 100,
  sqrtPriceStepBps: 900,
  reductionFactor: 100_000n,
  schedulerExpirationDuration: 315_360_000,
} as const;

/**
 * Curve A's shape (spec 3.3), the same for every target: the coin graduates at a market cap of 5x its Graduation
 * Target (425 SOL at 85 SOL); the first segment holds the largest pot, a fifth of the target, while the square-root
 * price rises 1.25x (the price 1.5625x, so a full pot opens the public exactly 1.25x above its own average price); the
 * second takes the rest of the target up to Graduation.
 */
const GRADUATION_MARKET_CAP_MULTIPLE = 5n;
const POT_SHARE_OF_TARGET = 5n; // the pot's segment holds target / 5
const POT_SQRT_RISE = [5n, 4n] as const; // 1.25x

export type CurvePoint = { sqrtPrice: bigint; liquidity: bigint };
export type Curve = { sqrtStartPrice: bigint; points: [CurvePoint, CurvePoint] };

/** What DBC's `create_config` computes from a curve and its target; the config account stores these. */
export type CurveCheck = {
  migrationSqrtPrice: bigint;
  swapBaseAmount: bigint;
  migrationBaseAmount: bigint;
  /** The supply `create_config` requires: the swap amount with its buffer, plus the graduated pool's base. */
  minimumSupply: bigint;
};

/**
 * Curve A for a Graduation Target in the quote's raw units. Prices are quote raw units per raw coin unit, so the
 * quote's decimals never enter: the same code serves SOL and devnet USDC.
 *
 * Solving the shape in real numbers puts exactly 800,000,000 coins on the curve, but DAMM v2's graduated position
 * spans DBC's whole price range rather than zero to infinity, so pairing the target at the graduation price takes a
 * little more than 200,000,000 coins (about 2.26 more at 85 SOL, 7.14 at 8.5 SOL). The curve sells that much less:
 * its start price is solved against the supply that remains, then nudged until DBC's own check fits the fixed supply.
 * Each segment's liquidity is the largest whose quote, rounded up as DBC rounds it, is exactly that segment's share,
 * so the quotes add up to the target and the coin graduates exactly at the curve's last point.
 */
export function curveA(graduationTarget: bigint): Curve {
  if (graduationTarget <= 0n) throw new Error("the Graduation Target must be positive");
  const graduationSqrtPrice = isqrt((GRADUATION_MARKET_CAP_MULTIPLE * graduationTarget * Q128) / COIN_SUPPLY);
  let curveBase = COIN_SUPPLY - migrationBaseAmount(graduationTarget, graduationSqrtPrice);
  for (let attempt = 0; attempt < 16; attempt++) {
    const curve = solveCurve(graduationTarget, graduationSqrtPrice, curveBase);
    const excess = checkCurve(curve, graduationTarget).minimumSupply - COIN_SUPPLY;
    if (excess <= 0n) return curve;
    curveBase -= excess;
  }
  throw new Error(`no curve A fits the supply for a target of ${graduationTarget}`);
}

/**
 * The curve whose two segments hold base `curveBase` in real numbers: with x and g the start and graduation square-root
 * prices, the pot's segment holds 0.16 T / x^2 and the second 0.64 T / (x g), so x solves
 * 25 B g x^2 - 16 T x - 4 T g = 0; in Q64.64 that is the integer quadratic below, whose root is rounded up (a higher
 * start sells less).
 */
function solveCurve(target: bigint, graduationSqrtPrice: bigint, curveBase: bigint): Curve {
  const g = graduationSqrtPrice;
  const a = 16n * target * Q128;
  const discriminant = a * a + 400n * curveBase * target * Q128 * g * g;
  const denominator = 50n * curveBase * g;
  const root = isqrt(discriminant);
  const sqrtStartPrice = root * root === discriminant ? ceilDiv(a + root, denominator) : (a + root) / denominator + 1n;
  const potSqrtPrice = ceilDiv(POT_SQRT_RISE[0] * sqrtStartPrice, POT_SQRT_RISE[1]);
  const potQuote = target / POT_SHARE_OF_TARGET;
  return {
    sqrtStartPrice,
    points: [
      { sqrtPrice: potSqrtPrice, liquidity: (potQuote * Q128) / (potSqrtPrice - sqrtStartPrice) },
      { sqrtPrice: g, liquidity: ((target - potQuote) * Q128) / (g - potSqrtPrice) },
    ],
  };
}

/**
 * DBC's `create_config` arithmetic for a curve and target, with a 0% migration fee, DAMM v2 migration and no locked
 * vesting (spec 3.2): where the coin graduates, what the curve sells, and the supply that requires. Throws where DBC
 * would refuse the curve.
 */
export function checkCurve(curve: Curve, graduationTarget: bigint): CurveCheck {
  const { sqrtStartPrice, points } = curve;
  if (sqrtStartPrice < MIN_SQRT_PRICE || sqrtStartPrice >= MAX_SQRT_PRICE) throw new Error("start price out of range");
  let lower = sqrtStartPrice;
  for (const p of points) {
    if (p.sqrtPrice <= lower || p.liquidity <= 0n || p.sqrtPrice > MAX_SQRT_PRICE) throw new Error("invalid curve");
    lower = p.sqrtPrice;
  }
  const migrationSqrtPrice = migrationThresholdPrice(graduationTarget, curve);
  const swapBaseAmount = baseForSwap(curve, migrationSqrtPrice);
  const buffered = swapBaseAmount + (swapBaseAmount * 25n) / 100n;
  const onWholeCurve = baseForSwap(curve, MAX_SQRT_PRICE);
  const swapWithBuffer = buffered < onWholeCurve ? buffered : onWholeCurve;
  const migrationBase = migrationBaseAmount(graduationTarget, migrationSqrtPrice);
  return { migrationSqrtPrice, swapBaseAmount, migrationBaseAmount: migrationBase, minimumSupply: swapWithBuffer + migrationBase };
}

/** `get_migration_threshold_price`: walk the curve, each segment's quote rounded up, until the target is spent. */
function migrationThresholdPrice(target: bigint, { sqrtStartPrice, points }: Curve): bigint {
  let price = sqrtStartPrice;
  let left = target;
  for (const p of points) {
    const segmentQuote = ceilDiv(p.liquidity * (p.sqrtPrice - price), Q128);
    if (segmentQuote > left) return price + (left * Q128) / p.liquidity; // next price from a quote input, rounded down
    left -= segmentQuote;
    price = p.sqrtPrice;
  }
  if (left !== 0n) throw new Error("not enough liquidity: the curve's quote falls short of the target");
  return price;
}

/** `get_base_token_for_swap`: the coins the curve sells from its start to `upTo`, each segment rounded up. */
function baseForSwap({ sqrtStartPrice, points }: Curve, upTo: bigint): bigint {
  let total = 0n;
  let lower = sqrtStartPrice;
  for (const p of points) {
    const upper = p.sqrtPrice > upTo ? upTo : p.sqrtPrice;
    total += ceilDiv(p.liquidity * (upper - lower), lower * upper);
    if (p.sqrtPrice > upTo) break;
    lower = p.sqrtPrice;
  }
  return total;
}

/**
 * The coins DAMM v2's graduated position needs beside the target at a price (`get_included_protocol_fee_migration_
 * amounts_1`): the liquidity that holds the quote from DBC's minimum price up to it, then that liquidity's base from it
 * up to DBC's maximum price, rounded up.
 */
function migrationBaseAmount(quote: bigint, sqrtPrice: bigint): bigint {
  const liquidity = (quote * Q128) / (sqrtPrice - MIN_SQRT_PRICE);
  return ceilDiv(liquidity * (MAX_SQRT_PRICE - sqrtPrice), sqrtPrice * MAX_SQRT_PRICE);
}

/**
 * The graduated pool's fee numerator at a square-root price, given its graduation square-root price (DAMM v2's linear
 * market-cap scheduler, before expiry). DAMM v2's denominator is also 1,000,000,000.
 */
export function graduatedPoolFeeNumerator(graduationSqrtPrice: bigint, sqrtPrice: bigint): bigint {
  const cliff = (BigInt(GRADUATED_POOL_FEE.poolFeeBps) * FEE_DENOMINATOR) / 10_000n;
  const passed =
    sqrtPrice <= graduationSqrtPrice
      ? 0n
      : ((sqrtPrice - graduationSqrtPrice) * 10_000n) / graduationSqrtPrice / BigInt(GRADUATED_POOL_FEE.sqrtPriceStepBps);
  const periods = passed < BigInt(GRADUATED_POOL_FEE.numberOfPeriod) ? passed : BigInt(GRADUATED_POOL_FEE.numberOfPeriod);
  return cliff - GRADUATED_POOL_FEE.reductionFactor * periods;
}

// DBC's enums, by value (`state/config.rs`, `utils/activation_handler.rs`, `migration_handler/mod.rs`,
// `utils/damm_v2_utils.rs` at 0.2.2).
const BASE_FEE_MODE_FEE_SCHEDULER_LINEAR = 0;
const COLLECT_FEE_MODE_QUOTE_TOKEN = 0;
const MIGRATION_OPTION_DAMM_V2 = 1;
const ACTIVATION_TYPE_TIMESTAMP = 1;
const TOKEN_TYPE_SPL_TOKEN = 0;
const MIGRATION_FEE_OPTION_CUSTOMIZABLE = 6;
const TOKEN_AUTHORITY_IMMUTABLE = 1;
const MIGRATED_COLLECT_FEE_MODE_QUOTE_TOKEN = 0;
const DAMM_V2_DYNAMIC_FEE_DISABLE = 0;
const DAMM_V2_BASE_FEE_MODE_MARKET_CAP_SCHEDULER_LINEAR = 3;

const NO_LIQUIDITY_VESTING = {
  vestingPercentage: 0,
  bpsPerPeriod: 0,
  numberOfPeriods: 0,
  cliffDurationFromMigrationTime: 0,
  frequency: 0,
} as const;

/**
 * Every value of spec 3.2's table, as `create_config2`'s `config_parameters`. The two launch modes differ only in
 * `enableFirstSwapWithMinFee`, on for Fair Open (the pot's buy pays the ending fee) and off for Instant launch.
 */
export function heatConfigParameters(mode: LaunchMode, graduationTarget: bigint): ConfigParametersArgs {
  const curve = curveA(graduationTarget);
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: SNIPER_TAX.cliffFeeNumerator,
        firstFactor: SNIPER_TAX.numberOfPeriod,
        secondFactor: SNIPER_TAX.periodFrequency,
        thirdFactor: SNIPER_TAX.reductionFactor,
        baseFeeMode: BASE_FEE_MODE_FEE_SCHEDULER_LINEAR,
      },
      dynamicFee: null,
    },
    collectFeeMode: COLLECT_FEE_MODE_QUOTE_TOKEN,
    migrationOption: MIGRATION_OPTION_DAMM_V2,
    activationType: ACTIVATION_TYPE_TIMESTAMP,
    tokenType: TOKEN_TYPE_SPL_TOKEN,
    tokenDecimal: COIN_DECIMALS,
    // Both graduated LP halves permanently locked, nothing unlocked or vesting (spec 3.2).
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
    migrationQuoteThreshold: graduationTarget,
    sqrtStartPrice: curve.sqrtStartPrice,
    lockedVesting: { amountPerPeriod: 0n, cliffDurationFromMigrationTime: 0n, frequency: 0n, numberOfPeriod: 0n, cliffUnlockAmount: 0n },
    migrationFeeOption: MIGRATION_FEE_OPTION_CUSTOMIZABLE,
    tokenSupply: { preMigrationTokenSupply: COIN_SUPPLY, postMigrationTokenSupply: COIN_SUPPLY },
    // The fee program splits instead (ADR 0003).
    creatorTradingFeePercentage: 0,
    tokenUpdateAuthority: TOKEN_AUTHORITY_IMMUTABLE,
    // 0%; Meteora's fixed 0.2% protocol liquidity fee still applies.
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: {
      collectFeeMode: MIGRATED_COLLECT_FEE_MODE_QUOTE_TOKEN,
      dynamicFee: DAMM_V2_DYNAMIC_FEE_DISABLE,
      poolFeeBps: GRADUATED_POOL_FEE.poolFeeBps,
    },
    poolCreationFee: 0n,
    partnerLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    creatorLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    migratedPoolBaseFeeMode: DAMM_V2_BASE_FEE_MODE_MARKET_CAP_SCHEDULER_LINEAR,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: GRADUATED_POOL_FEE.numberOfPeriod,
      sqrtPriceStepBps: GRADUATED_POOL_FEE.sqrtPriceStepBps,
      schedulerExpirationDuration: GRADUATED_POOL_FEE.schedulerExpirationDuration,
      reductionFactor: GRADUATED_POOL_FEE.reductionFactor,
    },
    enableFirstSwapWithMinFee: mode === "fairOpen",
    compoundingFeeBps: 0,
    padding: new Uint8Array(2),
    curve: curve.points.map((p) => ({ sqrtPrice: p.sqrtPrice, liquidity: p.liquidity })),
  };
}

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
