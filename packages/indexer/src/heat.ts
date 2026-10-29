// What the indexer writes for Heat (spec 10.2): the pools on Heat's configs, the coins the fee program registers, and
// every trade with its candles. Each transaction is written in one database transaction that first claims its
// signature, so the live source, the browser's fast path and reconciliation can all hand it in and it is written once.
import { and, eq, inArray, sql } from "drizzle-orm";
import { priceOfSqrtPrice, type HeatCluster } from "@top-pad/chain";
import { coins, indexedTransactions, launches, pools, trades, type DbOrTransaction } from "@top-pad/db";
import { foldTrade } from "./candles";
import { decodeTransaction, type CoinRegistered, type PoolCreated, type RawTransaction } from "./decode";
import type { IndexResult, TransactionHandler } from "./index";

export type Trade = typeof trades.$inferSelect;

/** What one transaction added, for the live rooms. */
export type Indexed = { signature: string; slot: number; pools: PoolCreated[]; coins: CoinRegistered[]; trades: Trade[] };

export type HeatHandlerOptions = {
  /** Heat on the cluster being indexed; it must have its configs. */
  heat: HeatCluster;
  /** A transaction's place in its block (`getBlock`), asked only for a transaction with trades. */
  blockIndexOf(slot: number, signature: string): Promise<number>;
  /** Called once a transaction's rows are committed, with what it added. */
  onIndexed?(indexed: Indexed): void | Promise<void>;
};

const BLOCK_INDEX_LIMIT = 1_000_000;
const EVENT_INDEX_LIMIT = 10_000;

/** The trades' total order as one number: slot, then place in the block, then place in the transaction. */
export function orderKey(slot: number, blockIndex: number, eventIndex: number): string {
  if (blockIndex < 0 || blockIndex >= BLOCK_INDEX_LIMIT) throw new Error(`block index ${blockIndex} is out of range`);
  if (eventIndex < 0 || eventIndex >= EVENT_INDEX_LIMIT) throw new Error(`event index ${eventIndex} is out of range`);
  return (BigInt(slot) * 10n ** 10n + BigInt(blockIndex) * 10n ** 4n + BigInt(eventIndex)).toString();
}

/** The handler the ingestion entry point runs on Heat's transactions. */
export function heatHandler({ heat, blockIndexOf, onIndexed }: HeatHandlerOptions): TransactionHandler {
  if (!heat.configs) throw new Error("the indexer needs Heat's configs on its cluster");
  const configs = new Set<string>([heat.configs.fairOpen, heat.configs.instant]);

  return async (db, tx: RawTransaction): Promise<IndexResult> => {
    const signature = tx.transaction.signatures[0]!;
    const decoded = decodeTransaction(tx, configs);
    const blockIndex = decoded.swaps.length ? await blockIndexOf(tx.slot, signature) : null;
    const blockTime = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000);

    const added = await db.transaction(async (t) => {
      const [claimed] = await t.insert(indexedTransactions).values({ signature, slot: tx.slot, blockIndex }).onConflictDoNothing().returning();
      if (!claimed) return null;

      for (const p of decoded.pools) {
        await t
          .insert(pools)
          .values({
            pool: p.pool,
            mint: p.mint,
            config: p.config,
            creator: p.creator,
            name: p.name,
            ticker: p.ticker,
            uri: p.uri,
            activatedAt: new Date(Number(p.activationPoint) * 1000),
            createdSignature: signature,
            createdSlot: tx.slot,
            createdAt: blockTime,
            sqrtPrice: heat.sqrtStartPrice.toString(),
            quoteReserve: 0n,
          })
          .onConflictDoNothing();
      }
      for (const c of decoded.coins) await recordCoin(t, c, signature, tx.slot, blockTime);

      const added: Trade[] = [];
      for (const s of decoded.swaps) {
        const key = orderKey(tx.slot, blockIndex!, s.eventIndex);
        const price = priceOfSqrtPrice(s.sqrtPrice, heat.quote.decimals);
        const at = Number(s.timestamp);
        const [row] = await t
          .insert(trades)
          .values({
            signature,
            eventIndex: s.eventIndex,
            slot: tx.slot,
            blockIndex: blockIndex!,
            orderKey: key,
            at: new Date(at * 1000),
            pool: s.pool,
            mint: s.mint,
            trader: s.trader,
            side: s.side,
            quoteAmount: s.quoteAmount,
            baseAmount: s.baseAmount,
            fee: s.fee,
            sqrtPrice: s.sqrtPrice.toString(),
            price,
            quoteReserve: s.quoteReserve,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) continue;
        added.push(row);
        await foldTrade(t, { mint: s.mint, at, orderKey: key, price, quoteAmount: s.quoteAmount, baseAmount: s.baseAmount });
      }
      for (const pool of new Set([...decoded.pools.map((p) => p.pool), ...added.map((a) => a.pool)])) await followLatestTrade(t, pool);
      return added;
    });
    if (!added) return {};

    if (onIndexed) await onIndexed({ signature, slot: tx.slot, pools: decoded.pools, coins: decoded.coins, trades: added });
    const result: IndexResult = { transactions: 1 };
    if (decoded.pools.length) result.pools = decoded.pools.length;
    if (decoded.coins.length) result.coins = decoded.coins.length;
    if (added.length) result.trades = added.length;
    return result;
  };
}

/**
 * A coin registered on chain joins the Heat coins, with what its launch here knew; a launch still marked sending (its
 * browser went away) or expired (its signature was not found in time) has landed.
 */
async function recordCoin(t: DbOrTransaction, c: CoinRegistered, signature: string, slot: number, at: Date) {
  const [launch] = await t.select().from(launches).where(eq(launches.mint, c.mint));
  const [pool] = await t.select().from(pools).where(eq(pools.pool, c.pool));
  if (!pool) throw new Error(`coin ${c.mint} was registered for pool ${c.pool}, which the indexer has not seen created`);
  await t
    .insert(coins)
    .values({
      mint: c.mint,
      pool: c.pool,
      config: c.config,
      launchMode: c.launchMode,
      launchId: launch?.id ?? null,
      creatorId: launch?.creatorId ?? null,
      creatorWallet: c.creator,
      name: launch?.name ?? pool.name,
      ticker: launch?.ticker ?? pool.ticker,
      metadataUri: launch?.metadataUri ?? pool.uri,
      imageUri: launch?.imageUri ?? null,
      createdSignature: signature,
      createdSlot: slot,
      createdAt: at,
    })
    .onConflictDoNothing();
  if (launch) {
    await t
      .update(launches)
      .set({ status: "landed", slot, landedAt: sql`now()` })
      .where(and(eq(launches.id, launch.id), inArray(launches.status, ["sending", "expired"])));
  }
}

/** A pool's price and quote reserve, from its latest trade by the trades' order, whenever that trade was indexed. */
async function followLatestTrade(t: DbOrTransaction, pool: string) {
  await t.execute(sql`
    update pools
    set sqrt_price = latest.sqrt_price, quote_reserve = latest.quote_reserve, last_trade_key = latest.order_key
    from (select sqrt_price, quote_reserve, order_key from trades where pool = ${pool} order by order_key desc limit 1) as latest
    where pools.pool = ${pool} and (pools.last_trade_key is null or pools.last_trade_key < latest.order_key)`);
}
