import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLUSTERS, WSOL_MINT } from "@top-pad/chain";
import { Position } from "@top-pad/contract";
import { coins, createDb, creators, creatorWallets, fairOpens, fairOpenSeatEvents, pools, trades, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { CardAssets } from "./cardImage";
import { CARD_HEIGHT, CARD_WIDTH } from "./cardSize";
import { app } from "./index";
import { renderPnlImage } from "./pnlImage";
import { positionFigures, valueAt, type PositionEvent } from "./positionFigures";
import { pnlImageKey } from "./positions";
import { ORIGINS, testBindings, testContext } from "./test/fakes";

// A trader's position and its P&L share card (spec 9, #59): figures by average cost from the wallet's indexed swaps and
// Fair Open fills, stated as of a snapshot that never changes, and the card drawn as a 2:1 PNG kept in R2 per snapshot.
// `CARD_OUT=<folder>` keeps each drawn card there to look at.

const SOL = 1_000_000_000n;
const COIN = 1_000_000n;

describe("a position's figures", () => {
  const at = new Date("2026-11-15T10:00:00Z");
  const buy = (key: number, coins: bigint, quote: bigint, fee = 0n): PositionEvent => ({ kind: "buy", key: BigInt(key), at, coins, quote, fee });
  const sell = (key: number, coins: bigint, quote: bigint, fee = 0n): PositionEvent => ({ kind: "sell", key: BigInt(key), at, coins, quote, fee });

  it("values coins held at a price in whole quote units per coin, rounding down", () => {
    expect(valueAt(1_000_000n * COIN, "0.000000028", 6, 9)).toBe(28_000_000n);
    expect(valueAt(3n, "0.333333333333333333", 0, 9)).toBe(999_999_999n);
    expect(valueAt(0n, "5", 6, 9)).toBe(0n);
  });

  it("takes a sell's coins off at the average cost, its quote after fees received", () => {
    // 2M coins for 1 SOL, then 2M more for 3 SOL: 4M coins at 1 SOL a million; 1M sold for 2.1 SOL less a 0.1 SOL fee.
    const f = positionFigures([buy(1, 2_000_000n * COIN, SOL, 10_000_000n), buy(2, 2_000_000n * COIN, 3n * SOL), sell(3, 1_000_000n * COIN, 2_100_000_000n, 100_000_000n)], "0.000002", 6, 9);
    expect(f).toMatchObject({ bought: `${4_000_000n * COIN}`, spent: `${4n * SOL}`, sold: `${1_000_000n * COIN}`, received: `${2n * SOL}`, fees: "110000000", swaps: 3, fills: 0 });
    expect(f.held).toBe(`${3_000_000n * COIN}`);
    expect(f.costHeld).toBe(`${3n * SOL}`);
    // Realized: 2 SOL received less the sold million's 1 SOL; unrealized: 3M coins at 0.000002 is 6 SOL, less their 3.
    expect(f.realized).toBe(`${SOL}`);
    expect(f.value).toBe(`${6n * SOL}`);
    expect(f.unrealized).toBe(`${3n * SOL}`);
    expect(f.pnl).toBe(`${4n * SOL}`);
    expect(f.pnlPercent).toBe(100);
  });

  it("says a loss with its sign, and costs nothing for coins sold beyond what the counted events hold", () => {
    const loss = positionFigures([buy(1, 1_000_000n * COIN, SOL), sell(2, 1_000_000n * COIN, 400_000_000n)], "0.0000004", 6, 9);
    expect(loss).toMatchObject({ held: "0", value: "0", realized: "-600000000", unrealized: "0", pnl: "-600000000", pnlPercent: -60 });
    // 1M bought, 3M sold: the 2M the wallet was sent cost nothing, so all of their quote is gain.
    const sent = positionFigures([buy(1, 1_000_000n * COIN, SOL), sell(2, 3_000_000n * COIN, 3n * SOL)], "0.000001", 6, 9);
    expect(sent).toMatchObject({ held: "0", costHeld: "0", realized: `${2n * SOL}`, pnl: `${2n * SOL}`, pnlPercent: 200 });
  });

  it("counts a Fair Open fill as a buy at the open's one price and its Tax Share as received", () => {
    const f = positionFigures(
      [
        { kind: "fill", key: 1n, at, coins: 5_000_000n * COIN, quote: SOL },
        { kind: "tax_share", key: 2n, at, quote: 50_000_000n },
      ],
      "0.0000002",
      6,
      9,
    );
    expect(f).toMatchObject({ bought: `${5_000_000n * COIN}`, spent: `${SOL}`, taxShare: "50000000", received: "0", fills: 1, swaps: 0, held: `${5_000_000n * COIN}`, value: `${SOL}` });
    expect(f.realized).toBe("50000000");
    expect(f.pnl).toBe("50000000");
    expect(f.pnlPercent).toBe(5);
  });
});

// The route, from what the indexer wrote.

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
});
afterAll(async () => {
  await closeDb();
  await drop();
});

const { ctx, settle } = testContext();
afterAll(() => settle());

/** R2 as the Worker binds it, in memory, counting what is drawn and kept. */
const blobs = new Map<string, Uint8Array>();
const BLOBS = {
  put: async (key: string, value: Uint8Array) => void blobs.set(key, value),
  get: async (key: string) => {
    const b = blobs.get(key);
    return b ? { arrayBuffer: async () => b.slice().buffer } : null;
  },
};
const request = (path: string) => app.request(path, {}, testBindings(url, { BLOBS }), ctx);
const position = async (path: string) => {
  const res = await request(path);
  expect(res.status, await res.clone().text()).toBe(200);
  return { position: Position.parse(await res.json()), cache: res.headers.get("cache-control") };
};

const { instant, fairOpen: fairOpenConfig } = CLUSTERS.devnet!.configs!;
const DAY = 24 * 60 * 60_000;
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
const addr = async () => (await generateKeyPairSigner()).address;
let slot = 50_000;
const keyOf = (s: number) => BigInt(s) * 10n ** 10n + 10n ** 4n;

async function coin(ticker: string, mode: "instant" | "fair_open" = "instant") {
  const [mint, pool, wallet] = await Promise.all([addr(), addr(), addr()]);
  const [record] = await db.insert(creators).values({ xUserId: null, xHandle: null, xName: null, createdAt: new Date(Date.now() - 30 * DAY) }).returning();
  await db.insert(creatorWallets).values({ creatorId: record!.id, wallet, via: "sign_in", proof: signature(), startedAt: new Date(Date.now() - 30 * DAY) });
  const at = new Date(Date.now() - 2 * DAY);
  const created = { createdSignature: signature(), createdSlot: ++slot, createdAt: at };
  const config = mode === "instant" ? instant : fairOpenConfig;
  const uri = `https://turbo-gateway.com/${ticker}`;
  await db.insert(pools).values({
    pool,
    mint,
    config,
    creator: wallet,
    quoteMint: WSOL_MINT,
    graduationTarget: 8_500_000_000n,
    startSqrtPrice: CLUSTERS.devnet!.sqrtStartPrice.toString(),
    name: `${ticker} coin`,
    ticker,
    uri,
    activatedAt: at,
    sqrtPrice: CLUSTERS.devnet!.sqrtStartPrice.toString(),
    quoteReserve: 0n,
    ...created,
  });
  await db.insert(coins).values({ mint, pool, config, launchMode: mode, creatorId: record!.id, creatorWallet: wallet, name: `${ticker} coin`, ticker, metadataUri: uri, imageUri: null, ...created });
  return { mint, pool, creator: wallet };
}
type TestCoin = Awaited<ReturnType<typeof coin>>;

/** A trade, the pool's latest, at a price in whole SOL per coin. */
async function trade(c: TestCoin, trader: string, side: "buy" | "sell", o: { coins: bigint; quote: bigint; fee?: bigint; price: string }) {
  const s = ++slot;
  const orderKey = keyOf(s).toString();
  await db.insert(trades).values({
    signature: signature(),
    eventIndex: 0,
    slot: s,
    blockIndex: 1,
    orderKey,
    at: new Date(Date.now() - DAY + s * 1000),
    pool: c.pool,
    mint: c.mint,
    trader,
    side,
    quoteAmount: o.quote,
    baseAmount: o.coins,
    fee: o.fee ?? 0n,
    sqrtPrice: "1000",
    price: o.price,
    quoteReserve: 0n,
  });
  await db.update(pools).set({ lastTradeKey: orderKey }).where(eq(pools.pool, c.pool));
  return orderKey;
}

describe("GET /coins/:mint/positions/:wallet", () => {
  it("adds up a trader's swaps, priced at the coin's latest trade, as the newest snapshot", async () => {
    const c = await coin("PNLA");
    const trader = await addr();
    const other = await addr();
    await trade(c, trader, "buy", { coins: 2_000_000n * COIN, quote: SOL, fee: 10_000_000n, price: "0.0000005" });
    await trade(c, trader, "sell", { coins: 500_000n * COIN, quote: 400_000_000n, fee: 4_000_000n, price: "0.0000007" });
    const last = await trade(c, other, "buy", { coins: 100_000n * COIN, quote: 100_000_000n, price: "0.000001" });

    const { position: p, cache } = await position(`/coins/${c.mint}/positions/${trader}`);
    expect(cache).toBe("no-store");
    expect(p).toMatchObject({ mint: c.mint, wallet: trader, ticker: "PNLA", launchMode: "instant", at: last, latest: true, price: "0.000001", swaps: 2, fills: 0 });
    expect(p).toMatchObject({ bought: `${2_000_000n * COIN}`, spent: `${SOL}`, sold: `${500_000n * COIN}`, received: "396000000", fees: "14000000", held: `${1_500_000n * COIN}` });
    // 1.5M coins at 0.000001 SOL is 1.5 SOL, against the 0.75 SOL they cost; 0.396 SOL received for 0.25 SOL of cost.
    expect(p).toMatchObject({ value: "1500000000", costHeld: "750000000", unrealized: "750000000", realized: "146000000", pnl: "896000000", pnlPercent: 89.6 });
    expect(p.card).toBe(`${ORIGINS.api}/coins/${c.mint}/positions/${trader}/card.png?at=${last}`);
  });

  it("states an older snapshot as it was, whatever came after, and caches it", async () => {
    const c = await coin("PNLB");
    const trader = await addr();
    const first = await trade(c, trader, "buy", { coins: 1_000_000n * COIN, quote: SOL, price: "0.000001" });
    await trade(c, trader, "sell", { coins: 1_000_000n * COIN, quote: 3n * SOL, price: "0.000003" });

    const { position: then, cache } = await position(`/coins/${c.mint}/positions/${trader}?at=${first}`);
    expect(then).toMatchObject({ at: first, latest: false, swaps: 1, held: `${1_000_000n * COIN}`, pnl: "0", price: "0.000001" });
    expect(cache).toContain("max-age=3600");
    const { position: now } = await position(`/coins/${c.mint}/positions/${trader}`);
    expect(now).toMatchObject({ latest: true, held: "0", pnl: `${2n * SOL}`, pnlPercent: 200 });
    // A snapshot past the newest is the newest.
    const { position: ahead } = await position(`/coins/${c.mint}/positions/${trader}?at=${10n ** 25n}`);
    expect(ahead.at).toBe(now.at);
  });

  it("counts a depositor's Fair Open fill at the open's one price and the Tax Share their seat was paid", async () => {
    const c = await coin("PNLC", "fair_open");
    const depositor = await addr();
    const launch = await addr();
    await db.insert(fairOpens).values({
      launch,
      creator: c.creator,
      nonce: await addr(),
      dbcConfig: fairOpenConfig,
      quoteMint: WSOL_MINT,
      identityHash: "ab".repeat(32),
      depositsOpenAt: new Date(Date.now() - 3 * DAY),
      opensAt: new Date(Date.now() - 2 * DAY),
      minRaise: 500_000_000n,
      potCap: 1_700_000_000n,
      lowestRung: 100_000_000n,
      step: 10_000_000n,
      status: "closed",
      mint: c.mint,
      pool: c.pool,
      spent: 1_700_000_000n,
      coins: 100_000_000n * COIN,
      seats: 4,
      createdSignature: signature(),
      createdSlot: ++slot,
      createdAt: new Date(Date.now() - 3 * DAY),
    });
    // The keeper's pot buy is the coin's first trade; the deliveries come in later slots, with nothing traded since.
    await trade(c, CLUSTERS.devnet!.keys!.keeper, "buy", { coins: 100_000_000n * COIN, quote: 1_700_000_000n, price: "0.000000017" });
    const event = (kind: "delivery" | "tax_share" | "deposit", o: { amount: bigint; spent?: bigint; coins?: bigint }) =>
      db.insert(fairOpenSeatEvents).values({ signature: signature(), eventIndex: 0, slot: ++slot, at: new Date(Date.now() - DAY), launch, wallet: depositor, person: "00", kind, deposit: 500_000_000n, ...o });
    await event("deposit", { amount: 500_000_000n });
    await event("delivery", { amount: 75_000_000n, spent: 425_000_000n, coins: 25_000_000n * COIN });
    await event("tax_share", { amount: 5_000_000n });

    const { position: p } = await position(`/coins/${c.mint}/positions/${depositor}`);
    expect(p).toMatchObject({ latest: true, at: `${BigInt(slot) * 10n ** 10n}`, fills: 1, swaps: 0, spent: "425000000", bought: `${25_000_000n * COIN}`, taxShare: "5000000" });
    // Valued at the open's price, as nothing traded since: worth what it cost, plus the Tax Share.
    expect(p).toMatchObject({ price: "0.000000017", value: "425000000", pnl: "5000000" });
  });

  it("serves a snapshot's card R2 keeps as it was", async () => {
    const c = await coin("PNLK");
    const trader = await addr();
    const first = await trade(c, trader, "buy", { coins: COIN, quote: 1_000n, price: "0.001" });
    const { position: p } = await position(`/coins/${c.mint}/positions/${trader}?at=${first}`);
    const png = new TextEncoder().encode("a kept card");
    blobs.set(pnlImageKey("devnet", p), png);
    const res = await request(`/coins/${c.mint}/positions/${trader}/card.png?at=${first}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect((await request(`/coins/${c.mint}/positions/${await addr()}/card.png`)).status).toBe(404);
  });

  it("answers 404 for a wallet with nothing indexed, a coin Heat does not have, and addresses that are not addresses", async () => {
    const c = await coin("PNLD");
    await trade(c, await addr(), "buy", { coins: COIN, quote: 1_000n, price: "0.001" });
    expect((await request(`/coins/${c.mint}/positions/${await addr()}`)).status).toBe(404);
    expect((await request(`/coins/${await addr()}/positions/${await addr()}`)).status).toBe(404);
    expect((await request(`/coins/${c.mint}/positions/nope`)).status).toBe(404);
    expect((await request(`/coins/${c.mint}/positions/${await addr()}?at=12x`)).status).toBe(404);
  });
});

// The image.

const require = createRequire(import.meta.url);
const bytes = (specifier: string) => {
  const b = readFileSync(require.resolve(specifier));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const assets = async (): Promise<CardAssets> => ({
  layout: bytes("satori/yoga.wasm"),
  resvg: bytes("@resvg/resvg-wasm/index_bg.wasm"),
  fonts: [
    { name: "IBM Plex Sans", data: bytes("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"), weight: 400 },
    { name: "IBM Plex Sans", data: bytes("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff"), weight: 600 },
    { name: "IBM Plex Mono", data: bytes("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff"), weight: 400 },
    { name: "Saira Condensed", data: bytes("@fontsource/saira-condensed/files/saira-condensed-latin-700-normal.woff"), weight: 700 },
  ],
});
const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("the P&L card image", () => {
  const base: Position = {
    mint: "8cWz1WmjBp2nN7JyKuJ8rMjQQYmex3f6aEaYZ6PwLJQh",
    wallet: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8",
    name: "Pigeon on Green",
    ticker: "PIGEON",
    imageUri: null,
    launchMode: "fair_open",
    decimals: 6,
    quote: { mint: WSOL_MINT, symbol: "SOL", decimals: 9, multiplier: 1, labels: [], explorer: "https://explorer.solana.com/address/x?cluster=devnet" },
    at: "3000000000010000",
    latest: true,
    asOf: "2026-11-15T09:41:00.000Z",
    price: "0.000000061",
    bought: "25000000000000",
    spent: "425000000",
    sold: "10000000000000",
    received: "910000000",
    taxShare: "5000000",
    fees: "9100000",
    held: "15000000000000",
    value: "915000000",
    costHeld: "255000000",
    realized: "745000000",
    unrealized: "660000000",
    pnl: "1405000000",
    pnlPercent: 330.58,
    swaps: 1,
    fills: 1,
    firstAt: "2026-11-14T07:00:00.000Z",
    card: "https://api.example/x.png",
  };
  it.each([
    ["gain", base],
    ["loss", { ...base, name: "Baby Wif Hat With A Name Long Enough To Run Out Of Room", launchMode: "instant" as const, taxShare: "0", pnl: "-212345678", pnlPercent: -49.96 }],
    ["tiny", { ...base, pnl: "1234", pnlPercent: 0, value: "0", held: "0" }],
  ])("draws a %s as a 2:1 PNG under 5 MB", async (name, p) => {
    const png = await renderPnlImage(p, { cluster: "devnet", web: "https://top-pad-web-devnet.rc-labs.workers.dev", assets });
    expect(sizeOf(png)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);
    if (process.env.CARD_OUT) writeFileSync(join(process.env.CARD_OUT, `pnl-${name}.png`), png);
  });

  it("keys a kept image by its snapshot and the quote's multiplier", () => {
    expect(pnlImageKey("devnet", base)).toBe(`pnl-cards/devnet/${base.mint}/${base.wallet}/${base.at}-1.png`);
  });
});
