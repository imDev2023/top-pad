// What every Heat coin shares (spec 3.1, 3.2): its fixed supply and the sniper tax its configs charge, and the exact
// arithmetic that turns a DBC pool's square-root price into a price and a market cap. Here rather than in
// `@top-pad/meteora` so the API, the indexer and the keeper read them without web3.js; the config generator imports them.

/** The coin (spec 3.1): exactly 1,000,000,000 coins of 6 decimals, a fixed supply, in raw units. */
export const COIN_DECIMALS = 6;
export const COIN_SUPPLY = 1_000_000_000n * 10n ** BigInt(COIN_DECIMALS);

/** DBC's fee denominator: a fee numerator of 12,500,000 is 1.25%. */
export const FEE_DENOMINATOR = 1_000_000_000n;

/**
 * The sniper tax (spec 3.2): DBC's linear fee scheduler in timestamp mode, from a 98.999996% cliff down
 * 16,291,666 per one-second period for 60 periods, ending at exactly 1.25% (fee numerators over 1,000,000,000).
 */
export const SNIPER_TAX = {
  cliffFeeNumerator: 989_999_960n,
  numberOfPeriod: 60,
  periodFrequency: 1n,
  reductionFactor: 16_291_666n,
} as const;

/** The sniper tax's fee numerator `seconds` after the open (DBC's linear fee scheduler). */
export function sniperTaxNumerator(seconds: number): bigint {
  const periods = BigInt(Math.min(Math.max(Math.floor(seconds / Number(SNIPER_TAX.periodFrequency)), 0), SNIPER_TAX.numberOfPeriod));
  return SNIPER_TAX.cliffFeeNumerator - SNIPER_TAX.reductionFactor * periods;
}

/** How many decimal places a price keeps: exact to a billionth of a lamport per coin. */
export const PRICE_DECIMALS = 18;

/**
 * The price a Q64.64 square-root price stands for, in whole quote units (SOL) per whole coin, as a decimal string with
 * `PRICE_DECIMALS` places, rounded down. DBC prices are raw quote units per raw coin unit: (sqrt / 2^64)^2.
 */
export function priceOfSqrtPrice(sqrtPrice: bigint, quoteDecimals: number): string {
  const exponent = COIN_DECIMALS + PRICE_DECIMALS - quoteDecimals;
  if (exponent < 0) throw new Error(`a quote of ${quoteDecimals} decimals is beyond the price's precision`);
  return decimal((sqrtPrice * sqrtPrice * 10n ** BigInt(exponent)) >> 128n, PRICE_DECIMALS);
}

/** The market cap at a square-root price, in whole quote units, as a decimal string with `PRICE_DECIMALS` places. */
export function marketCapOfSqrtPrice(sqrtPrice: bigint, quoteDecimals: number): string {
  if (quoteDecimals > PRICE_DECIMALS) throw new Error(`a quote of ${quoteDecimals} decimals is beyond the price's precision`);
  return decimal((sqrtPrice * sqrtPrice * COIN_SUPPLY * 10n ** BigInt(PRICE_DECIMALS - quoteDecimals)) >> 128n, PRICE_DECIMALS);
}

/** A non-negative integer scaled by 10^places, as a decimal string. */
function decimal(scaled: bigint, places: number): string {
  const digits = scaled.toString().padStart(places + 1, "0");
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
