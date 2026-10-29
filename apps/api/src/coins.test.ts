import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBase58Encoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import { Coin, CoinCandles, CoinTrades } from "@top-pad/contract";
import { createDb, pools, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { foldTrade, heatHandler, indexTransactions, type RawTransaction } from "@top-pad/indexer";
import { app } from "./index";
import { ORIGINS, testBindings, testContext } from "./test/fakes";

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;

// A real devnet launch whose creator bought in the same transaction (packages/indexer's fixture), as the indexer wrote it.
const tx = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/launch-with-creator-buy.json"), "utf8"),
) as RawTransaction;
const MINT = "EcQZjuhGWVjF3GjSPj6e9XzCchMy7B338Ug9VNgraf1L";
const POOL = "HLzYgbHReBQxdungMNakZT72MFQrjmkDWhJk773CWKkw";

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
  await indexTransactions(db, heatHandler({ heat: CLUSTERS.devnet!, blockIndexOf: async () => 17 }), [tx]);
});
afterAll(async () => {
  await closeDb();
  await drop();
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const request = (path: string) => app.request(path, {}, testBindings(url), ctx);

/** The RPC's answer to the holder count: the creator holding coins, the pool's authority holding the rest. */
function holdersRpc() {
  const calls: string[] = [];
  const account = (owner: string, amount: bigint) => {
    const data = new Uint8Array(40);
    data.set(getBase58Encoder().encode(owner));
    new DataView(data.buffer).setBigUint64(32, amount, true);
    return { account: { data: [btoa(String.fromCharCode(...data)), "base64"] } };
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    calls.push(method);
    expect(input).toBe(ORIGINS.rpc);
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: [account("3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8", 26_962_757_915n), account("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", 1n)],
    });
  });
  return calls;
}

describe("a coin's page", () => {
  it("shows the coin, its market after its latest trade, its holders and the sniper tax it charges", async () => {
    const calls = holdersRpc();
    const res = await request(`/coins/${MINT}`);
    expect(res.status).toBe(200);
    const coin = Coin.parse(await res.json());
    expect(coin).toMatchObject({
      mint: MINT,
      pool: POOL,
      // Registered on chain, with no launch in this database: listed as a Heat coin, with no image.
      heat: true,
      launchMode: "instant",
      imageUri: null,
      creator: { wallet: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8", handle: null },
      activatedAt: new Date(1_793_247_380_000).toISOString(),
      quote: { symbol: "SOL", decimals: 9 },
      market: { price: "0.000000003708873955", quoteReserve: "100000", graduationTarget: "8500000000", holders: 1 },
      tax: { cliffNumerator: "989999960", reductionPerPeriod: "16291666", periodSeconds: 1, periods: 60, denominator: "1000000000" },
    });
    expect(Number(coin.market.marketCap)).toBeCloseTo(3.708873955, 8);
    expect(calls).toEqual(["getProgramAccounts"]);

    // The count stands for a minute.
    await request(`/coins/${MINT}`);
    expect(calls).toHaveLength(1);
  });

  it("keeps the last holder count when the RPC fails", async () => {
    await db.update(pools).set({ holders: 4, holdersCountedAt: new Date(0) });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const coin = Coin.parse(await (await request(`/coins/${MINT}`)).json());
    expect(coin.market.holders).toBe(4);
  });

  it("is not found for a mint that is no coin of Heat's", async () => {
    expect((await request("/coins/So11111111111111111111111111111111111111112")).status).toBe(404);
    expect((await request("/coins/not-an-address")).status).toBe(404);
  });
});

describe("a coin's trades and candles", () => {
  it("lists the trades newest first, and since an order key for a page catching up", async () => {
    const { trades } = CoinTrades.parse(await (await request(`/coins/${MINT}/trades`)).json());
    expect(trades).toEqual([
      expect.objectContaining({ side: "buy", quoteAmount: "10000000", fee: "9900000", baseAmount: "26962757915", trader: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8" }),
    ]);
    const key = trades[0]!.orderKey;
    expect(CoinTrades.parse(await (await request(`/coins/${MINT}/trades?after=${key}`)).json()).trades).toEqual([]);
    expect(CoinTrades.parse(await (await request(`/coins/${MINT}/trades?after=0`)).json()).trades).toHaveLength(1);
    expect(CoinTrades.parse(await (await request(`/coins/${MINT}/trades?before=${key}`)).json()).trades).toEqual([]);
    expect((await request(`/coins/${MINT}/trades?after=1;drop`)).status).toBe(400);
  });

  it("gives the candles of a length over a range, each opening where the price stood before it", async () => {
    const at = 1_793_247_380;
    const res = CoinCandles.parse(await (await request(`/coins/${MINT}/candles?seconds=1&from=${at - 60}&to=${at + 60}`)).json());
    // The coin's first candle opens at curve A's start and closes at the creator's buy, which moved the price up.
    const start = "0.000000003708764872";
    expect(res).toEqual({
      seconds: 1,
      candles: [
        {
          time: at,
          open: start,
          high: "0.000000003708873955",
          low: start,
          close: "0.000000003708873955",
          volumeQuote: "10000000",
          trades: 1,
        },
      ],
    });
    expect((await request(`/coins/${MINT}/candles?seconds=7`)).status).toBe(400);

    // A sell five seconds later opens its candle at the buy's close, and its low reaches below the open.
    const sold = "0.000000003708800000";
    await foldTrade(db, { mint: MINT, at: at + 5, orderKey: "5162921800000000000", price: sold, quoteAmount: 1n, baseAmount: 1n });
    const [first, second] = CoinCandles.parse(await (await request(`/coins/${MINT}/candles?seconds=1&from=${at - 60}&to=${at + 60}`)).json()).candles;
    expect(second).toMatchObject({ time: at + 5, open: first!.close, high: first!.close, low: sold, close: sold });
    expect(CoinCandles.parse(await (await request(`/coins/${MINT}/candles?seconds=86400&from=0&to=${at + 86_400}`)).json()).candles).toHaveLength(1);
  });
});
