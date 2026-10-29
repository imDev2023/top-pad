// A coin's page (spec 9, screen 3), read from what the indexer wrote: the coin and its market, its trades newest first
// (or since an order key, for a page catching up after its live connection dropped), and its candles of one length.
import { and, asc, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import type { Context } from "hono";
import { COIN_DECIMALS, COIN_SUPPLY, FEE_DENOMINATOR, marketCapOfSqrtPrice, priceOfSqrtPrice, SNIPER_TAX } from "@top-pad/chain";
import { Address, CandleSeconds, type Coin, type CoinCandles, type CoinTrades, type Trade } from "@top-pad/contract";
import { candles, coins, creators, pools, trades, type Db } from "@top-pad/db";
import { holderCount } from "@top-pad/indexer";
import { explorerUrl } from "./env";
import type { AppEnv } from "./http";

/** How long a holder count stands before a page asks for it again (spec 10.4 lets public figures be a minute stale). */
const HOLDERS_FRESH_MS = 60_000;
const HOLDERS_TIMEOUT_MS = 2_500;
const TRADES_PAGE = 50;
const TRADES_MAX = 200;
/** A page catching up gets at most this many trades; one further behind loads its trades afresh. */
const CATCH_UP_MAX = 500;
const CANDLES_MAX = 2_000;

const ORDER_KEY = /^\d{1,30}$/;

/** A trade as the API and the live rooms show it. */
export function tradeView(row: typeof trades.$inferSelect): Trade {
  return {
    signature: row.signature,
    eventIndex: row.eventIndex,
    orderKey: row.orderKey,
    slot: row.slot,
    at: row.at.toISOString(),
    trader: row.trader,
    side: row.side,
    quoteAmount: row.quoteAmount.toString(),
    baseAmount: row.baseAmount.toString(),
    fee: row.fee.toString(),
    price: row.price,
    quoteReserve: row.quoteReserve.toString(),
  };
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "Heat has no coin at this address." }, 404);

/** The pool row of a mint on Heat's configs, or null. */
async function poolOf(db: Db, mint: string) {
  if (!Address.safeParse(mint).success) return null;
  const [pool] = await db.select().from(pools).where(eq(pools.mint, mint));
  return pool ?? null;
}

/** `GET /coins/:mint`. */
export async function getCoin(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const heat = cfg.heat;
  const mint = c.req.param("mint")!;
  if (!heat || !Address.safeParse(mint).success) return notFound(c);
  const [row] = await db
    .select({ pool: pools, coin: coins, handle: creators.xHandle })
    .from(pools)
    .leftJoin(coins, eq(coins.mint, pools.mint))
    .leftJoin(creators, eq(creators.id, coins.creatorId))
    .where(eq(pools.mint, mint));
  if (!row) return notFound(c);
  const { pool, coin } = row;

  let holders = pool.holders;
  if (!pool.holdersCountedAt || Date.now() - pool.holdersCountedAt.getTime() > HOLDERS_FRESH_MS) {
    try {
      holders = await holderCount(cfg.rpcUrl, mint, AbortSignal.timeout(HOLDERS_TIMEOUT_MS));
      await db.update(pools).set({ holders, holdersCountedAt: new Date() }).where(eq(pools.pool, pool.pool));
    } catch (e) {
      // The count is a nicety: an RPC that is slow or down leaves the last one standing.
      console.warn("counting holders failed", mint, e);
    }
  }

  const sqrtPrice = BigInt(pool.sqrtPrice);
  const body: Coin = {
    mint,
    pool: pool.pool,
    config: pool.config,
    name: coin?.name ?? pool.name,
    ticker: coin?.ticker ?? pool.ticker,
    metadataUri: coin?.metadataUri ?? pool.uri,
    imageUri: coin?.imageUri ?? null,
    heat: coin !== null,
    launchMode: coin?.launchMode ?? null,
    creator: { wallet: coin?.creatorWallet ?? pool.creator, handle: row.handle ?? null },
    activatedAt: pool.activatedAt.toISOString(),
    supply: COIN_SUPPLY.toString(),
    decimals: COIN_DECIMALS,
    quote: { symbol: heat.quote.symbol, decimals: heat.quote.decimals },
    market: {
      price: priceOfSqrtPrice(sqrtPrice, heat.quote.decimals),
      marketCap: marketCapOfSqrtPrice(sqrtPrice, heat.quote.decimals),
      quoteReserve: pool.quoteReserve.toString(),
      graduationTarget: heat.graduationTarget.toString(),
      holders,
      lastTradeKey: pool.lastTradeKey,
    },
    tax: {
      cliffNumerator: SNIPER_TAX.cliffFeeNumerator.toString(),
      reductionPerPeriod: SNIPER_TAX.reductionFactor.toString(),
      periodSeconds: Number(SNIPER_TAX.periodFrequency),
      periods: SNIPER_TAX.numberOfPeriod,
      denominator: FEE_DENOMINATOR.toString(),
    },
    explorer: { mint: explorerUrl(cfg, "address", mint), pool: explorerUrl(cfg, "address", pool.pool) },
    servedAt: new Date().toISOString(),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/** `GET /coins/:mint/trades?limit=&before=` (newest first) or `?after=` (since an order key, oldest first). */
export async function getCoinTrades(c: Context<AppEnv>) {
  const { db } = c.var;
  const mint = c.req.param("mint")!;
  if (!(await poolOf(db, mint))) return notFound(c);
  const { after, before } = c.req.query();
  if ((after !== undefined && !ORDER_KEY.test(after)) || (before !== undefined && !ORDER_KEY.test(before))) {
    return c.json({ error: "after and before are trades' order keys." }, 400);
  }
  let rows;
  if (after !== undefined) {
    rows = await db.select().from(trades).where(and(eq(trades.mint, mint), gt(trades.orderKey, after))).orderBy(asc(trades.orderKey)).limit(CATCH_UP_MAX);
  } else {
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit") ?? TRADES_PAGE)) || TRADES_PAGE, 1), TRADES_MAX);
    rows = await db
      .select()
      .from(trades)
      .where(before !== undefined ? and(eq(trades.mint, mint), lt(trades.orderKey, before)) : eq(trades.mint, mint))
      .orderBy(desc(trades.orderKey))
      .limit(limit);
  }
  const body: CoinTrades = { trades: rows.map(tradeView) };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/** A decimal price of `priceOfSqrtPrice`'s fixed 18 places, as an integer to compare. */
const scaled = (price: string) => BigInt(price.replace(".", ""));
const higher = (a: string, b: string) => (scaled(a) >= scaled(b) ? a : b);
const lower = (a: string, b: string) => (scaled(a) <= scaled(b) ? a : b);

/**
 * `GET /coins/:mint/candles?seconds=&from=&to=`: `from` and `to` in Unix seconds, the latest candles by default. The
 * indexer's candles hold the price after each trade; here each opens where the price stood before its first trade, the
 * close of the candle before it (curve A's start before the first), since only trades move a curve's price. So a candle
 * of one trade still shows the move that trade made.
 */
export async function getCoinCandles(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const mint = c.req.param("mint")!;
  if (!cfg.heat || !(await poolOf(db, mint))) return notFound(c);
  const seconds = CandleSeconds.safeParse(Number(c.req.query("seconds") ?? 60));
  if (!seconds.success) return c.json({ error: "seconds is one of 1, 15, 60, 300, 900, 3600, 14400 and 86400." }, 400);
  const to = Number(c.req.query("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(c.req.query("from") ?? to - seconds.data * CANDLES_MAX);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return c.json({ error: "from and to are Unix seconds, from first." }, 400);
  // The latest candles in the range when it holds more than a page of them.
  const rows = await db
    .select()
    .from(candles)
    .where(and(eq(candles.mint, mint), eq(candles.seconds, seconds.data), gte(candles.startsAt, new Date(from * 1000)), lte(candles.startsAt, new Date(to * 1000))))
    .orderBy(desc(candles.startsAt))
    .limit(CANDLES_MAX);
  rows.reverse();
  const [before] = rows.length
    ? await db
        .select({ close: candles.close })
        .from(candles)
        .where(and(eq(candles.mint, mint), eq(candles.seconds, seconds.data), lt(candles.startsAt, rows[0]!.startsAt)))
        .orderBy(desc(candles.startsAt))
        .limit(1)
    : [];
  let open = before?.close ?? priceOfSqrtPrice(cfg.heat.sqrtStartPrice, cfg.heat.quote.decimals);
  const body: CoinCandles = {
    seconds: seconds.data,
    candles: rows.map((r) => {
      const candle = {
        time: Math.floor(r.startsAt.getTime() / 1000),
        open,
        high: higher(r.high, open),
        low: lower(r.low, open),
        close: r.close,
        volumeQuote: r.volumeQuote,
        trades: r.trades,
      };
      open = r.close;
      return candle;
    }),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
}
