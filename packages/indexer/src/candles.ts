// Candles (spec 10.2): every trade is folded into its candle at each length as it is indexed, and any candle can be
// rebuilt from the trades. A fold keeps the open and the close by the trades' order, not by when they arrived, so a
// trade that reconciliation indexes late still lands where it belongs, and a rebuild comes out the same.
import { and, asc, eq, sql } from "drizzle-orm";
import { candles, type DbOrTransaction } from "@top-pad/db";

/** The candle lengths in seconds: 1 s and 15 s for the first minutes (spec 9), then 1 m to 1 d. */
export const CANDLE_SECONDS = [1, 15, 60, 300, 900, 3_600, 14_400, 86_400] as const;
export type CandleSeconds = (typeof CANDLE_SECONDS)[number];

/** How long the fine candles are kept (spec 10.2); coarser ones are kept forever. */
export const CANDLE_RETENTION_DAYS: Partial<Record<CandleSeconds, number>> = { 1: 7, 15: 30 };

/** What a fold needs of a trade. */
export type CandleTrade = {
  mint: string;
  /** When it ran, in whole Unix seconds. */
  at: number;
  orderKey: string;
  /** The price after it, a decimal string. */
  price: string;
  quoteAmount: bigint;
  baseAmount: bigint;
};

/** The start of the candle a moment falls in, in Unix seconds. */
export const candleStart = (at: number, seconds: number) => Math.floor(at / seconds) * seconds;

/** Folds one newly indexed trade into its candle at every length. Run it once per trade: it adds to the volumes. */
export async function foldTrade(db: DbOrTransaction, trade: CandleTrade) {
  await db
    .insert(candles)
    .values(
      CANDLE_SECONDS.map((seconds) => ({
        mint: trade.mint,
        seconds,
        startsAt: new Date(candleStart(trade.at, seconds) * 1000),
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        openKey: trade.orderKey,
        closeKey: trade.orderKey,
        volumeQuote: trade.quoteAmount.toString(),
        volumeBase: trade.baseAmount.toString(),
        trades: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [candles.mint, candles.seconds, candles.startsAt],
      set: {
        open: sql`case when excluded.open_key < ${candles.openKey} then excluded.open else ${candles.open} end`,
        openKey: sql`least(excluded.open_key, ${candles.openKey})`,
        close: sql`case when excluded.close_key > ${candles.closeKey} then excluded.close else ${candles.close} end`,
        closeKey: sql`greatest(excluded.close_key, ${candles.closeKey})`,
        high: sql`greatest(excluded.high, ${candles.high})`,
        low: sql`least(excluded.low, ${candles.low})`,
        volumeQuote: sql`${candles.volumeQuote} + excluded.volume_quote`,
        volumeBase: sql`${candles.volumeBase} + excluded.volume_base`,
        trades: sql`${candles.trades} + 1`,
      },
    });
}

export type Candle = typeof candles.$inferSelect;

/** A coin's candles of one length as the indexer wrote them, oldest first. */
export async function writtenCandles(db: DbOrTransaction, mint: string, seconds: CandleSeconds): Promise<Candle[]> {
  return db.select().from(candles).where(and(eq(candles.mint, mint), eq(candles.seconds, seconds))).orderBy(asc(candles.startsAt));
}

/** A coin's candles of one length rebuilt from its trades alone, oldest first, in the shape the indexer writes them. */
export async function rebuildCandles(db: DbOrTransaction, mint: string, seconds: CandleSeconds): Promise<Candle[]> {
  const rows = await db.execute<{
    starts_at: Date | string;
    open: string;
    high: string;
    low: string;
    close: string;
    open_key: string;
    close_key: string;
    volume_quote: string;
    volume_base: string;
    trades: number;
  }>(sql`
    select to_timestamp(floor(extract(epoch from at) / ${seconds}) * ${seconds}) as starts_at,
           (array_agg(price order by order_key))[1] as open,
           max(price) as high,
           min(price) as low,
           (array_agg(price order by order_key desc))[1] as close,
           min(order_key) as open_key,
           max(order_key) as close_key,
           sum(quote_amount) as volume_quote,
           sum(base_amount) as volume_base,
           count(*)::int as trades
    from trades
    where mint = ${mint}
    group by 1
    order by 1`);
  return rows.map((r) => ({
    mint,
    seconds,
    startsAt: new Date(r.starts_at),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    openKey: r.open_key,
    closeKey: r.close_key,
    volumeQuote: r.volume_quote,
    volumeBase: r.volume_base,
    trades: r.trades,
  }));
}

/** Deletes fine candles past their retention (spec 10.2); they can always be rebuilt from the trades. */
export async function pruneCandles(db: DbOrTransaction) {
  let deleted = 0;
  for (const [seconds, days] of Object.entries(CANDLE_RETENTION_DAYS)) {
    const gone = await db.execute(sql`
      delete from candles where seconds = ${Number(seconds)} and starts_at < now() - make_interval(days => ${days})`);
    deleted += gone.count;
  }
  return deleted;
}
