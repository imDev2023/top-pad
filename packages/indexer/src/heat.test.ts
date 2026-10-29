import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import { candles, coins, createDb, creators, indexedTransactions, launches, pools, trades, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { CANDLE_SECONDS, foldTrade, rebuildCandles, writtenCandles, type CandleSeconds } from "./candles";
import type { RawTransaction } from "./decode";
import { heatHandler, orderKey, type Indexed } from "./heat";
import { indexTransactions } from "./index";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());
beforeEach(async () => {
  for (const table of [candles, trades, coins, launches, creators, pools, indexedTransactions]) await db.delete(table);
});

const heat = CLUSTERS.devnet!;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as RawTransaction;
const MINT = "EcQZjuhGWVjF3GjSPj6e9XzCchMy7B338Ug9VNgraf1L";
const POOL = "HLzYgbHReBQxdungMNakZT72MFQrjmkDWhJk773CWKkw";

function handler() {
  const published: Indexed[] = [];
  const asked: [number, string][] = [];
  const handle = heatHandler({
    heat,
    blockIndexOf: async (slot, signature) => {
      asked.push([slot, signature]);
      return 17;
    },
    onIndexed: (indexed) => void published.push(indexed),
  });
  return { handle, published, asked };
}

describe("indexing Heat's transactions", () => {
  it("writes a launch's pool, its coin, the creator's buy and the buy's candles, then follows the pool's price", async () => {
    const { handle, published, asked } = handler();
    const tx = fixture("launch-with-creator-buy");
    expect(await indexTransactions(db, handle, [tx])).toEqual({ transactions: 1, pools: 1, coins: 1, trades: 1 });
    expect(asked).toEqual([[516_292_177, tx.transaction.signatures[0]]]);

    const [pool] = await db.select().from(pools);
    expect(pool).toMatchObject({
      pool: POOL,
      mint: MINT,
      config: heat.configs!.instant,
      activatedAt: new Date(1_793_247_380_000),
      createdSlot: 516_292_177,
      // After the buy, not curve A's start.
      sqrtPrice: "35525545851457242",
      quoteReserve: 100_000n,
      lastTradeKey: orderKey(516_292_177, 17, 0),
    });
    // No launch of this database's: the coin is listed from what the chain says, with no image.
    const [coin] = await db.select().from(coins);
    expect(coin).toMatchObject({ mint: MINT, pool: POOL, launchMode: "instant", launchId: null, imageUri: null, name: pool!.name });

    const [trade] = await db.select().from(trades);
    expect(trade).toMatchObject({
      signature: tx.transaction.signatures[0],
      eventIndex: 0,
      blockIndex: 17,
      at: new Date(1_793_247_380_000),
      side: "buy",
      quoteAmount: 10_000_000n,
      baseAmount: 26_962_757_915n,
      fee: 9_900_000n,
      price: "0.000000003708873955",
    });
    const written = await db.select().from(candles);
    expect(written.map((c) => c.seconds).sort((a, b) => a - b)).toEqual([...CANDLE_SECONDS]);
    expect(written.every((c) => c.open === trade!.price && c.close === trade!.price && c.trades === 1 && c.volumeQuote === "10000000")).toBe(true);

    expect(published).toHaveLength(1);
    expect(published[0]!.trades).toEqual([trade]);
  });

  it("writes a transaction once, however many sources hand it in", async () => {
    const { handle, published } = handler();
    const tx = fixture("launch-with-creator-buy");
    await indexTransactions(db, handle, [tx]);
    expect(await indexTransactions(db, handle, [tx, tx])).toEqual({});
    expect(await db.select().from(trades)).toHaveLength(1);
    expect((await db.select().from(candles)).every((c) => c.trades === 1)).toBe(true);
    expect(published).toHaveLength(1);
  });

  it("asks for no block position when a transaction has no trade", async () => {
    const { handle, asked } = handler();
    expect(await indexTransactions(db, handle, [fixture("launch")])).toEqual({ transactions: 1, pools: 1, coins: 1 });
    expect(asked).toEqual([]);
    const [pool] = await db.select().from(pools);
    expect(pool!.sqrtPrice).toBe(heat.sqrtStartPrice.toString());
  });

  it("lands a launch whose browser went away, and lists its coin with what the launch knew", async () => {
    const [creator] = await db.insert(creators).values({ xUserId: "1", xHandle: "lumen_lab", xName: "Lumen" }).returning();
    const tx = fixture("launch-with-creator-buy");
    await db.insert(launches).values({
      creatorId: creator!.id,
      wallet: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8",
      mode: "instant",
      name: "Lumen",
      ticker: "LUMEN",
      mint: MINT,
      pool: POOL,
      config: heat.configs!.instant,
      metadataUri: "https://turbo-gateway.com/metadata",
      imageUri: "https://turbo-gateway.com/image",
      message: "",
      mintSignature: "",
      lastValidBlockHeight: 1n,
      status: "sending",
      signature: tx.transaction.signatures[0],
    });
    await indexTransactions(db, handler().handle, [tx]);
    const [launch] = await db.select().from(launches);
    expect(launch).toMatchObject({ status: "landed", slot: 516_292_177 });
    expect((await db.select().from(coins))[0]).toMatchObject({ launchId: launch!.id, creatorId: creator!.id, imageUri: "https://turbo-gateway.com/image", ticker: "LUMEN" });
  });
});

describe("candles", () => {
  /** A deterministic stream of trades on one coin over a few minutes, some sharing a second, some a slot. */
  function stream(n: number) {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    return Array.from({ length: n }, (_, i) => {
      const slot = 1_000 + i * 2 + (random() < 0.3 ? 0 : 1);
      return {
        signature: `sig${i}`,
        eventIndex: 0,
        slot,
        blockIndex: Math.floor(random() * 50),
        at: 1_793_247_380 + Math.floor(i * 1.7),
        price: (0.000000003 + random() / 1e8).toFixed(18),
        quoteAmount: BigInt(Math.floor(random() * 1e9)),
        baseAmount: BigInt(Math.floor(random() * 1e12)),
      };
    });
  }

  it("come out the same rebuilt from the trades, whatever order the trades were indexed in", async () => {
    const all = stream(120).map((s) => ({ ...s, orderKey: orderKey(s.slot, s.blockIndex, s.eventIndex) }));
    // Reconciliation indexes some trades after newer ones: shuffle the arrival order.
    const arrival = [...all].sort((a, b) => ((a.slot * 7919) % 101) - ((b.slot * 7919) % 101));
    for (const s of arrival) {
      await db.insert(trades).values({
        signature: s.signature,
        eventIndex: 0,
        slot: s.slot,
        blockIndex: s.blockIndex,
        orderKey: s.orderKey,
        at: new Date(s.at * 1000),
        pool: POOL,
        mint: MINT,
        trader: "trader",
        side: "buy",
        quoteAmount: s.quoteAmount,
        baseAmount: s.baseAmount,
        fee: 0n,
        sqrtPrice: "0",
        price: s.price,
        quoteReserve: 0n,
      });
      await foldTrade(db, { mint: MINT, at: s.at, orderKey: s.orderKey, price: s.price, quoteAmount: s.quoteAmount, baseAmount: s.baseAmount });
    }
    for (const seconds of CANDLE_SECONDS) {
      const written = await writtenCandles(db, MINT, seconds as CandleSeconds);
      expect(written.length).toBeGreaterThan(0);
      expect(await rebuildCandles(db, MINT, seconds as CandleSeconds)).toEqual(written);
    }
    // The 1 s candles split the minutes into many; the day's one candle holds every trade.
    expect((await writtenCandles(db, MINT, 86_400))[0]!.trades).toBe(120);
    const first = all.reduce((a, b) => (BigInt(a.orderKey) < BigInt(b.orderKey) ? a : b));
    expect((await writtenCandles(db, MINT, 86_400))[0]!.open).toBe(first.price);
  });

  it("keep the trades' order when two trades share a slot", async () => {
    await db.delete(trades).where(eq(trades.mint, MINT));
    const early = { orderKey: orderKey(5, 1, 0), price: "1.000000000000000000" };
    const late = { orderKey: orderKey(5, 2, 0), price: "2.000000000000000000" };
    for (const t of [late, early]) {
      await foldTrade(db, { mint: MINT, at: 1_793_247_380, orderKey: t.orderKey, price: t.price, quoteAmount: 1n, baseAmount: 1n });
    }
    const [candle] = await writtenCandles(db, MINT, 1);
    expect(candle).toMatchObject({ open: early.price, close: late.price, high: late.price, low: early.price, trades: 2 });
  });
});
