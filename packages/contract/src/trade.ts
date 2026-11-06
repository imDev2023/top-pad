import { z } from "zod";
import { Trade } from "./coin";
import { Signature } from "./earnings";
import { Address, RawAmount } from "./launch";

/** The most slippage a quick trade may allow, in basis points: beyond 50% it protects nothing. */
export const MAX_SLIPPAGE_BPS = 5_000;

/**
 * `POST /coins/:mint/quote` and `POST /coins/:mint/swap`: a quick buy spends `amount` of the quote (its raw units), a quick
 * sell `amount` of the coin (raw units), at most `slippageBps` worse than quoted. A swap names the wallet that signs.
 */
export const SwapRequest = z.object({
  side: z.enum(["buy", "sell"]),
  amount: RawAmount.refine((a) => BigInt(a) > 0n, "nothing to trade"),
  slippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS),
});
export type SwapRequest = z.infer<typeof SwapRequest>;

export const SwapPrepareRequest = SwapRequest.extend({ wallet: Address });
export type SwapPrepareRequest = z.infer<typeof SwapPrepareRequest>;

/**
 * What the trade does if it runs from the second `from` on, by the chain's clock, as DBC computes it: during the sniper
 * tax each second has its own fee, falling, so a quote holds one step a second until the tax ends and the last step holds
 * from then on.
 */
export const QuoteStep = z.object({
  /** Unix seconds by the chain's clock. */
  from: z.number().int(),
  /** The whole fee, in the quote's raw units: never the creator's during the tax (spec 4). */
  fee: RawAmount,
  /** The quote side before the fee, as the trade will be recorded: the fee's base, so `fee / quoteAmount` is its rate. */
  quoteAmount: RawAmount,
  /** What the trader receives: coins on a buy, the quote on a sell. */
  amountOut: RawAmount,
});
export type QuoteStep = z.infer<typeof QuoteStep>;

export const SwapQuote = z.object({
  side: z.enum(["buy", "sell"]),
  /** What the trader puts in, in raw units, all of it unless the buy reaches Graduation. */
  amountIn: RawAmount,
  /** What a buy that reaches Graduation leaves unspent, returned in the same transaction; 0 otherwise. */
  amountLeft: RawAmount,
  /** The chain's clock as the pool was read, Unix seconds: the first step holds from here. */
  chainTime: z.number().int(),
  /** When the sniper tax ends, Unix seconds by the chain's clock: from then on the fee is the trading fee. */
  taxEndsAt: z.number().int(),
  /** Oldest first; the first is now, the last holds from the end of the tax on. */
  steps: z.array(QuoteStep).min(1),
  slippageBps: z.number().int(),
  /**
   * The least the trade may return, less the slippage allowed: what it returns at the fee of two seconds before the
   * quote's clock, since a wallet's node may simulate it that far behind and the sniper tax is higher there. The fee
   * only falls, so the trade itself never pays more than its first step.
   */
  minimumOut: RawAmount,
});
export type SwapQuote = z.infer<typeof SwapQuote>;

/** `POST /coins/:mint/swap`: the trade for the wallet to sign and send, unsigned, base64, the wallet paying its fee. */
export const PreparedSwap = z.object({ quote: SwapQuote, transaction: z.string() });
export type PreparedSwap = z.infer<typeof PreparedSwap>;

/** `POST /coins/:mint/trades`: a trade's signature once the wallet has sent it, so the page shows it at once. */
export const SwapSent = z.object({ signature: Signature });
export type SwapSent = z.infer<typeof SwapSent>;

/**
 * What a sent trade did, read from the chain the moment it confirmed: the browser's fast path (spec 10.2). Its trades
 * carry a provisional order key, the end of their slot, until the indexer reports them with their place in the block.
 */
export const SwapOutcome = z.object({
  signature: Signature,
  /** `pending` when it had not confirmed by the time the API stopped waiting: it may still land. */
  status: z.enum(["landed", "failed", "pending"]),
  error: z.string().nullable(),
  explorer: z.string().url(),
  trades: z.array(Trade),
});
export type SwapOutcome = z.infer<typeof SwapOutcome>;

/**
 * `GET /coins/:mint/holdings/:wallet`: what a wallet can trade with, in raw units: its SOL, which pays every network fee
 * and rent, the coin's quote it can spend on a buy (its SOL again for a coin priced in SOL), and the coin.
 */
export const Holdings = z.object({ wallet: Address, sol: RawAmount, quote: RawAmount, coins: RawAmount });
export type Holdings = z.infer<typeof Holdings>;
