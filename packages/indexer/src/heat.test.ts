import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import {
  candles,
  coins,
  createDb,
  creators,
  fairOpens,
  fairOpenSeatEvents,
  feeClaims,
  indexedTransactions,
  launches,
  pools,
  trades,
  windowClaims,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { CANDLE_SECONDS, foldTrade, rebuildCandles, writtenCandles, type CandleSeconds } from "./candles";
import type { RawTransaction } from "./decode";
import { heatHandler, orderKey, type Indexed } from "./heat";
import { IndexBatchError, indexTransactions, reindexTransactions } from "./index";

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
  for (const table of [candles, trades, coins, launches, creators, pools, indexedTransactions, windowClaims, feeClaims, fairOpens, fairOpenSeatEvents]) {
    await db.delete(table);
  }
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

  it("writes a coin's window claim and its creator's claims, once each, and hands them to the live rooms", async () => {
    const { handle, published, asked } = handler();
    const window = fixture("window-claim");
    const split = fixture("creator-claim");
    expect(await indexTransactions(db, handle, [window, split, window])).toEqual({ transactions: 2, claims: 2 });
    expect(asked).toEqual([]);
    expect(await db.select().from(windowClaims)).toEqual([
      {
        pool: "D5Wtpu6jo7a63EEWXBhxWPQQmFafbLn4wxMH5CGh7FDP",
        mint: "BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593",
        heat: true,
        destination: "CrQJCsFgWLETU8vPcavPV6SWyQsVSFJ5RkYxckpXWXu7",
        amount: 15_818_667n,
        windowEndedAt: new Date(1_793_306_730_000),
        claimedAt: new Date(1_793_306_733_000),
        signature: window.transaction.signatures[0],
        slot: 516_539_311,
      },
    ]);
    expect(await db.select().from(feeClaims)).toEqual([
      {
        signature: split.transaction.signatures[0],
        eventIndex: 0,
        slot: 516_539_330,
        at: new Date(1_793_306_738_000),
        pool: "D5Wtpu6jo7a63EEWXBhxWPQQmFafbLn4wxMH5CGh7FDP",
        mint: "BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593",
        creator: "4hsJPxhF2aeyuRK9s9d4HKdinmDTVMbdHp5Z3UoAbyB1",
        creatorAmount: 400_000n,
        treasuryAmount: 400_000n,
      },
    ]);
    expect(published.map((p) => [p.windowClaims.length, p.feeClaims.length])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("indexes again a transaction that older code indexed without knowing its claim", async () => {
    // What a version that did not yet decode claims left: the transaction marked indexed, and no window claim.
    const before = async (db: Db, tx: RawTransaction) => {
      await db.insert(indexedTransactions).values({ signature: tx.transaction.signatures[0]!, slot: tx.slot });
      return { transactions: 1 };
    };
    const window = fixture("window-claim");
    await indexTransactions(db, before, [window]);
    expect(await indexTransactions(db, handler().handle, [window])).toEqual({});
    expect(await db.select().from(windowClaims)).toEqual([]);

    expect(await reindexTransactions(db, handler().handle, [window])).toEqual({ transactions: 1, claims: 1 });
    expect(await db.select().from(windowClaims)).toHaveLength(1);
    // Once more changes nothing.
    await reindexTransactions(db, handler().handle, [window]);
    expect(await db.select().from(windowClaims)).toHaveLength(1);
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

describe("indexing a Fair Open", () => {
  it("writes the launch, every change to its seats, and its failure, and hands each to its live room", async () => {
    const { handle, published, asked } = handler();
    const life = ["fair-open-created", "fair-open-deposit", "fair-open-top-up", "fair-open-withdraw", "fair-open-failed-with-refund", "fair-open-refund"];
    expect(await indexTransactions(db, handle, life.map(fixture))).toEqual({ transactions: 6, fairOpen: 7 });
    expect(asked).toEqual([]);
    const [launch] = await db.select().from(fairOpens);
    expect(launch).toMatchObject({
      launch: "FLdTZ9qAbNVp4QTvdS8TyK3Vbnidy9DxSBowRdZ3yRLJ",
      creator: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8",
      depositsOpenAt: new Date(1_793_330_703_000),
      opensAt: new Date(1_793_331_303_000),
      minRaise: 1_000_000_000n,
      potCap: 1_700_000_000n,
      status: "failed",
      failure: "min_raise_missed",
      failedAt: new Date(1_793_331_307_000),
      teaser: null,
      createdSlot: 516_640_676,
    });
    const events = await db.select().from(fairOpenSeatEvents).orderBy(fairOpenSeatEvents.slot);
    expect(events.map((e) => [e.kind, e.tier, e.amount, e.deposit, e.rent])).toEqual([
      ["deposit", "unverified", 50_000_000n, 50_000_000n, null],
      ["deposit", "unverified", 30_000_000n, 80_000_000n, null],
      ["withdraw", null, 20_000_000n, 60_000_000n, null],
      ["refund", null, 360_000_000n, 0n, 3_042_920n],
      ["refund", null, 100_000_000n, 0n, 3_042_920n],
    ]);
    expect(published.map((p) => [p.fairOpens.length, p.seatEvents.length, p.fairOpenEnds.length])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
      [0, 1, 0],
    ]);
  });

  it("keeps a closed launch closed, whichever of its failure and its closing it indexes first", async () => {
    const { handle } = handler();
    await indexTransactions(db, handle, [fixture("fair-open-late-created"), fixture("fair-open-closed"), fixture("fair-open-late")]);
    const [launch] = await db.select().from(fairOpens);
    expect(launch).toMatchObject({ launch: "8EQ7fu8Fb4gt7jNqmnkSFk9Htx1oRKxapgwyQ9sp21xf", status: "closed", failure: "late", failedAt: new Date(1_793_331_349_000) });
  });

  it("leaves a failure seen before its launch for reconciliation, which finds the launch first", async () => {
    const { handle } = handler();
    // The live source reports the failure of a launch created before the indexer was watching.
    await expect(indexTransactions(db, handle, [fixture("fair-open-late")])).rejects.toBeInstanceOf(IndexBatchError);
    expect(await db.select().from(indexedTransactions)).toEqual([]);
    expect(await indexTransactions(db, handle, [fixture("fair-open-late-created"), fixture("fair-open-late")])).toEqual({ transactions: 2, fairOpen: 2 });
    expect((await db.select().from(fairOpens))[0]).toMatchObject({ status: "failed", failure: "late" });
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
