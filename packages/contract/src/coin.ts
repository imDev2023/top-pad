import { z } from "zod";
import { Address, RawAmount } from "./launch";

/** An exact decimal number, such as a price or a market cap in whole quote units. */
export const Decimal = z.string().regex(/^\d+(\.\d+)?$/);

/** The trades' total order (slot, then place in the block, then place in the transaction), as an integer string. */
export const OrderKey = z.string().regex(/^\d+$/);

/**
 * The sniper tax (spec 3.2) as the pool's config charges it: a fee numerator over `denominator` that starts at
 * `cliffNumerator` when trading opens and falls by `reductionPerPeriod` every `periodSeconds`, `periods` times.
 */
export const TaxSchedule = z.object({
  cliffNumerator: RawAmount,
  reductionPerPeriod: RawAmount,
  periodSeconds: z.number().int().positive(),
  periods: z.number().int().positive(),
  denominator: RawAmount,
});
export type TaxSchedule = z.infer<typeof TaxSchedule>;

/** One trade on a coin's pool (spec 9, screen 3). Amounts are raw units; the quote side is before the fee. */
export const Trade = z.object({
  signature: z.string(),
  /** The trade's place among its transaction's swaps. */
  eventIndex: z.number().int().nonnegative(),
  orderKey: OrderKey,
  slot: z.number().int().nonnegative(),
  /** When it ran, by the chain's clock. */
  at: z.iso.datetime(),
  trader: Address,
  side: z.enum(["buy", "sell"]),
  quoteAmount: RawAmount,
  baseAmount: RawAmount,
  /** Its whole fee in the quote, the sniper tax included: never the creator's (spec 4). */
  fee: RawAmount,
  /** The price after it, in whole quote units per coin. */
  price: Decimal,
  /** The quote the curve holds after it, which Graduation is measured against. */
  quoteReserve: RawAmount,
});
export type Trade = z.infer<typeof Trade>;

/** `GET /coins/:mint`: a coin's page. 404 for a mint with no pool on Heat's configs. */
export const Coin = z.object({
  mint: Address,
  pool: Address,
  config: Address,
  name: z.string(),
  ticker: z.string(),
  metadataUri: z.string(),
  /** The coin's image as launched through Heat; none for a pool made around Heat's flow. */
  imageUri: z.string().url().nullable(),
  /** Whether our launch key co-signed it: false for a pool created directly on Heat's configs (spec 2.4). */
  heat: z.boolean(),
  launchMode: z.enum(["instant", "fair_open"]).nullable(),
  creator: z.object({ wallet: Address, handle: z.string().nullable() }),
  /** When trading opened: the sniper tax counts from here. */
  activatedAt: z.iso.datetime(),
  quote: z.object({ symbol: z.string(), decimals: z.number().int().nonnegative() }),
  market: z.object({
    price: Decimal,
    marketCap: Decimal,
    quoteReserve: RawAmount,
    /** Graduation's quote reserve (spec 2.3): 8.5 SOL on devnet. */
    graduationTarget: RawAmount,
    /** Wallets holding the coin outside its pool, counted at most a minute ago; null until first counted. */
    holders: z.number().int().nonnegative().nullable(),
    /** The latest trade's order key, from which a page's live trades continue; null before the first trade. */
    lastTradeKey: OrderKey.nullable(),
  }),
  tax: TaxSchedule,
  explorer: z.object({ mint: z.string().url(), pool: z.string().url() }),
});
export type Coin = z.infer<typeof Coin>;

/**
 * `GET /coins/:mint/trades`: newest first, up to `limit`, older than `before` when given; with `after`, every trade
 * since that order key instead, oldest first, so a page that lost its live connection catches up.
 */
export const CoinTrades = z.object({ trades: z.array(Trade) });
export type CoinTrades = z.infer<typeof CoinTrades>;

/** The candle lengths a chart asks for, in seconds: 1 s and 15 s for a coin's first minutes (spec 9), then 1 m to 1 d. */
export const CandleSeconds = z.union([1, 15, 60, 300, 900, 3_600, 14_400, 86_400].map((s) => z.literal(s)));
export type CandleSeconds = z.infer<typeof CandleSeconds>;

export const Candle = z.object({
  /** The candle's start, in Unix seconds. */
  time: z.number().int(),
  open: Decimal,
  high: Decimal,
  low: Decimal,
  close: Decimal,
  /** Quote traded before fees, in raw units. */
  volumeQuote: RawAmount,
  trades: z.number().int().positive(),
});
export type Candle = z.infer<typeof Candle>;

/** `GET /coins/:mint/candles?seconds=&from=&to=`: a coin's candles of one length, oldest first. */
export const CoinCandles = z.object({ seconds: CandleSeconds, candles: z.array(Candle) });
export type CoinCandles = z.infer<typeof CoinCandles>;

/** What a live room pushes (spec 10.2): its new trades and coins, batched every 100 ms. */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trade"), mint: Address, trade: Trade }),
  z.object({ type: z.literal("coin"), mint: Address, name: z.string(), ticker: z.string(), heat: z.boolean() }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** One message on a live room's WebSocket. */
export const LiveBatch = z.object({ events: z.array(LiveEvent) });
export type LiveBatch = z.infer<typeof LiveBatch>;
