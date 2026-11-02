// A swap's quote on a Heat pool (spec 10.1, "Chain clients"): DBC's own swap maths from its SDK's `math` entry, which
// mirrors the program's `get_swap_result_from_exact_input` and `get_swap_result_from_partial_input` integer for
// integer, behind plain data. What goes in is the pool and config as `@top-pad/clients` decodes them and what comes out
// is bigints, so the API, which builds quick buys and sells, never touches web3.js or bn.js; this entry imports only
// the SDK's maths, never its client, to keep the API Worker small. Parity with real devnet swaps is tested here against
// recorded swaps and in `tests/devnet` live.
import BN from "bn.js";
import { getFeeMode, getSwapResultFromExactInput, getSwapResultFromPartialInput } from "@meteora-ag/dynamic-bonding-curve-sdk/math";
import type { PoolConfig, PoolState } from "@top-pad/clients/dbc";

/** The pool's state a quote reads: its price, its reserve, when it opened, and the dynamic fee's tracker. */
export type QuotePool = Pick<PoolState, "sqrtPrice" | "quoteReserve" | "activationPoint" | "hasSwap"> & {
  volatilityTracker: Pick<PoolState["volatilityTracker"], "volatilityAccumulator">;
};

/** The config's fields a quote reads: its curve, its fees and how it collects them. */
export type QuoteConfig = Pick<
  PoolConfig,
  | "collectFeeMode"
  | "sqrtStartPrice"
  | "migrationQuoteThreshold"
  | "migrationSqrtPrice"
  | "curve"
  | "enableFirstSwapWithMinFee"
  | "quoteTokenFlag"
  | "transferFeeFlag"
  | "transferFeeBasisPoints"
> & {
  poolFees: {
    baseFee: Pick<PoolConfig["poolFees"]["baseFee"], "cliffFeeNumerator" | "firstFactor" | "secondFactor" | "thirdFactor" | "baseFeeMode">;
    dynamicFee: Pick<PoolConfig["poolFees"]["dynamicFee"], "initialized" | "binStep" | "variableFeeControl">;
  };
};

export type QuoteRequest = {
  pool: QuotePool;
  config: QuoteConfig;
  /** A buy spends the quote for the coin; a sell spends the coin for the quote. */
  side: "buy" | "sell";
  /** What the trader puts in, in raw units: the quote on a buy, the coin on a sell. */
  amountIn: bigint;
  /** The chain's clock as the swap would run, in Unix seconds: the sniper tax is read from it. */
  currentPoint: bigint;
  /** Whether the swap names a referral account, which takes its share out of Meteora's (spec 4). */
  hasReferral: boolean;
};

/** What a swap does, in raw units, as DBC computes it. */
export type Quote = {
  /** What the swap takes from the trader: all of `amountIn`, unless a buy fills only up to the curve's end. */
  amountIn: bigint;
  /** What a buy could not spend, because the curve completes first; always 0 on a sell. */
  amountLeft: bigint;
  /** What the trader receives after the fee. */
  amountOut: bigint;
  /** The whole fee, in the quote, and its three parts: the pool's trading fee, Meteora's and the referral's. */
  fee: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  /** What the quote side of the trade comes to before the fee, as a trade records it: the fee's base. */
  quoteAmount: bigint;
  /** The pool's square-root price after the swap. */
  nextSqrtPrice: bigint;
};

/** DBC's `TradeDirection`: base to quote is a sell, quote to base a buy. */
const BASE_TO_QUOTE = 0;
const QUOTE_TO_BASE = 1;

const bn = (value: bigint) => new BN(value.toString());
const big = (value: BN) => BigInt(value.toString());

/** The pool and config as the SDK's maths read them: bn.js integers where the program has u64 and u128. */
function sdkState(pool: QuotePool, config: QuoteConfig) {
  const { baseFee, dynamicFee } = config.poolFees;
  return {
    pool: {
      poolState: {
        sqrtPrice: bn(pool.sqrtPrice),
        quoteReserve: bn(pool.quoteReserve),
        activationPoint: bn(pool.activationPoint),
        hasSwap: pool.hasSwap,
        volatilityTracker: { volatilityAccumulator: bn(pool.volatilityTracker.volatilityAccumulator) },
      },
    },
    config: {
      collectFeeMode: config.collectFeeMode,
      sqrtStartPrice: bn(config.sqrtStartPrice),
      migrationQuoteThreshold: bn(config.migrationQuoteThreshold),
      migrationSqrtPrice: bn(config.migrationSqrtPrice),
      curve: config.curve.map((point) => ({ sqrtPrice: bn(point.sqrtPrice), liquidity: bn(point.liquidity) })),
      enableFirstSwapWithMinFee: config.enableFirstSwapWithMinFee,
      quoteTokenFlag: config.quoteTokenFlag,
      transferFeeFlag: config.transferFeeFlag,
      transferFeeBasisPoints: config.transferFeeBasisPoints,
      poolFees: {
        baseFee: {
          cliffFeeNumerator: bn(baseFee.cliffFeeNumerator),
          firstFactor: baseFee.firstFactor,
          secondFactor: bn(baseFee.secondFactor),
          thirdFactor: bn(baseFee.thirdFactor),
          baseFeeMode: baseFee.baseFeeMode,
        },
        dynamicFee: { initialized: dynamicFee.initialized, binStep: dynamicFee.binStep, variableFeeControl: dynamicFee.variableFeeControl },
      },
    },
  };
}

/**
 * A swap's quote, as DBC would run it at `currentPoint`. A buy is a partial fill, as quick buy sends it (DBC's
 * `SwapMode::PartialFill`): up to the curve's end it is the same as an exact-in swap, and past it the buy fills only
 * what the curve still holds rather than failing. A sell is exact in, since a sell never reaches the curve's end. Never
 * eligible for the first-swap discount, which only a pool's creation transaction can claim. Throws, with DBC's own
 * words, when the swap could not run: nothing to swap, or a sell larger than the curve has bought.
 */
export function quoteSwap({ pool, config, side, amountIn, currentPoint, hasReferral }: QuoteRequest): Quote {
  const state = sdkState(pool, config);
  const direction = side === "buy" ? QUOTE_TO_BASE : BASE_TO_QUOTE;
  const feeMode = getFeeMode(config.collectFeeMode, direction, hasReferral);
  const swap = side === "buy" ? getSwapResultFromPartialInput : getSwapResultFromExactInput;
  const result = swap(state.pool as never, state.config as never, bn(amountIn), feeMode, direction, bn(currentPoint), false);
  const tradingFee = big(result.tradingFee);
  const protocolFee = big(result.protocolFee);
  const referralFee = big(result.referralFee);
  const fee = tradingFee + protocolFee + referralFee;
  const amountOut = big(result.outputAmount);
  const taken = big(result.includedFeeInputAmount);
  // Heat's configs collect every fee in the quote (spec 3.2): out of a buy's input, out of a sell's output.
  if (feeMode.feesOnBaseToken) throw new Error("this config collects fees in the coin, which Heat's configs never do");
  return {
    amountIn: taken,
    amountLeft: amountIn - taken,
    amountOut,
    fee,
    tradingFee,
    protocolFee,
    referralFee,
    quoteAmount: side === "buy" ? taken : amountOut + fee,
    nextSqrtPrice: big(result.nextSqrtPrice),
  };
}

/** The least a swap may return so it still lands when the price moves against it by `slippageBps` before it runs. */
export const minimumOut = (amountOut: bigint, slippageBps: number) => (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
