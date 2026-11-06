// The band (ADR 0007, settled question 1; spec 3.2): a quote's config pair stands while its Graduation Target, valued in
// SOL at the quote's latest price, stays within 10% of the SOL target; past that, the band job makes a new pair at the
// live price and the quote manager names it in the quote's `QuoteSettings`. A deposit step is 0.01 SOL's worth of the
// quote (ADR 0007 decision 2), held to the same band. Every amount is an integer of raw units, so a price is an exact
// fraction and floating point never touches a target. Pure, so the job, the scripts and the tests share one reading.
import { DEPOSIT_STEP } from "@top-pad/clients/fair-open";

/** A quote's price: how many of its raw units one lamport is worth, as the exact fraction `num / den`. */
export type QuotePrice = { num: bigint; den: bigint };

/** What a quote's `QuoteSettings` hold in raw units: the Graduation Target of its config pair and its deposit step. */
export type QuoteAmounts = { graduationTarget: bigint; step: bigint };

/** The band's half-width, 10% (owner, 2026-11-04). */
export const BAND_BPS = 1_000n;
const BPS = 10_000n;

/**
 * The smallest step a quote is offered at, so that rounding 0.01 SOL's worth to a whole raw unit moves it at most 0.1%:
 * a quote so dear that 0.01 SOL buys fewer raw units is too coarse for Heat's tier caps and allocation.
 */
export const MIN_STEP = 1_000n;

/** SOL is worth exactly one lamport a lamport, whatever any market says. */
export const SOL_PRICE: QuotePrice = { num: 1n, den: 1n };

function checked(price: QuotePrice): QuotePrice {
  if (price.num <= 0n || price.den <= 0n) throw new Error(`a price must be positive, not ${price.num}/${price.den}`);
  return price;
}

/** `lamports` of SOL in the quote's raw units at `price`, rounded to the nearest unit (halves up). */
export function worthIn(lamports: bigint, price: QuotePrice): bigint {
  const { num, den } = checked(price);
  return (2n * lamports * num + den) / (2n * den);
}

/**
 * A new pair's amounts at `price` for the cluster's SOL Graduation Target: the step is 0.01 SOL's worth, rounded to the
 * nearest raw unit, and the target is exactly the SOL target's number of steps (850 on devnet, 8,500 on mainnet), as
 * the hand-made USDC pair was (#88), so a pot's cap and its rungs are whole steps in every quote. Throws for a quote
 * too coarse to step in (`MIN_STEP`).
 */
export function amountsAt(price: QuotePrice, solGraduationTarget: bigint): QuoteAmounts {
  if (solGraduationTarget % DEPOSIT_STEP !== 0n) throw new Error(`the SOL target ${solGraduationTarget} is not a whole number of steps`);
  const step = worthIn(DEPOSIT_STEP, price);
  if (step < MIN_STEP) throw new Error(`0.01 SOL is only ${step} raw units of this quote, fewer than ${MIN_STEP}`);
  return { step, graduationTarget: step * (solGraduationTarget / DEPOSIT_STEP) };
}

/**
 * How far `amount` raw units of the quote, valued in SOL at `price`, sit from `lamports`, in basis points rounded down:
 * |amount / price - lamports| / lamports. For the job's record; the band itself is judged exactly by `outOfBand`.
 */
export function driftBps(amount: bigint, lamports: bigint, price: QuotePrice): bigint {
  const { num, den } = checked(price);
  const gap = amount * den - lamports * num;
  return ((gap < 0n ? -gap : gap) * BPS) / (lamports * num);
}

function beyond(amount: bigint, lamports: bigint, { num, den }: QuotePrice): boolean {
  const gap = amount * den - lamports * num;
  return (gap < 0n ? -gap : gap) * BPS > BAND_BPS * lamports * num;
}

/**
 * Whether a quote's settings have drifted past the band at `price`: its Graduation Target is worth more than 10% more
 * or less than the SOL target, or its step more than 10% off 0.01 SOL. Exactly 10% is still inside.
 */
export function outOfBand(amounts: QuoteAmounts, price: QuotePrice, solGraduationTarget: bigint): boolean {
  checked(price);
  return beyond(amounts.graduationTarget, solGraduationTarget, price) || beyond(amounts.step, DEPOSIT_STEP, price);
}

/** A positive decimal as the exact fraction `digits / 10^scale`, as a price API prints it. */
export type Decimal = { digits: bigint; scale: number };

/** Parses "1.5", "2.5e-7" or a finite JS number; anything else, zero or negative, is no price. */
export function parseDecimal(value: string | number): Decimal | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m) return null;
  const fraction = m[2] ?? "";
  let digits = BigInt(m[1]! + fraction);
  let scale = fraction.length - Number(m[3] ?? 0);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return digits > 0n ? { digits, scale } : null;
}

/**
 * A quote's price from two USD prices: SOL's per whole SOL, and the quote's per whole token of `decimals` raw-unit
 * decimals, unscaled (for a Scaled UI Amount mint, the price per raw-unit token, not per the amount a wallet shows).
 * Raw units per lamport = (SOL's USD / 10^9) / (the quote's USD / 10^decimals).
 */
export function priceFromUsd(quoteUsd: Decimal, solUsd: Decimal, decimals: number): QuotePrice {
  return {
    num: solUsd.digits * 10n ** BigInt(quoteUsd.scale) * 10n ** BigInt(decimals),
    den: quoteUsd.digits * 10n ** BigInt(solUsd.scale) * 10n ** 9n,
  };
}

/**
 * A quote's price from a DAMM v2 pool of it and SOL: the pool's square-root price is Q64.64 of token B's raw units per
 * token A's, so with SOL as token A the quote's raw units per lamport are its square, and the inverse with SOL as B.
 */
export function priceFromSqrtPrice(sqrtPrice: bigint, solIsTokenA: boolean): QuotePrice {
  const squared = sqrtPrice * sqrtPrice;
  const q128 = 1n << 128n;
  return checked(solIsTokenA ? { num: squared, den: q128 } : { num: q128, den: squared });
}

/** A price as a decimal string of raw units per lamport, to 12 significant places, for the job's record. */
export function formatPrice({ num, den }: QuotePrice): string {
  const value = Number((num * 10n ** 18n) / den) / 1e18;
  return value.toPrecision(12);
}
