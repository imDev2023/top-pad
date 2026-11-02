// Bundle Radar's case job and a coin's labels (spec 6.4, 6.5): a case opens only on wallets directly linked to the
// Creator wallet that bought 1% of supply between them across the pot and the first hour, with its evidence pack in
// Postgres and R2; a wallet that is only labelled is never in one. The chain is faked: the funding window's transfers are
// written as a scan would write them, and the RPC lists nothing new.
import { getBase58Decoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, COIN_SUPPLY } from "@top-pad/chain";
import { BundleRadar } from "@top-pad/contract";
import {
  bundleCases,
  bundleReviews,
  coins,
  createDb,
  creators,
  fairOpens,
  fairOpenSeatEvents,
  fundingScans,
  indexedTransactions,
  pools,
  trades,
  transfers,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { orderKey, type FundingSource, type RadarSources } from "@top-pad/indexer";
import { evidenceKey, reviewBundles, reviewCoin } from "./bundleRadar";
import { config } from "./env";
import { app } from "./index";
import { MemoryBlobs, ORIGINS, testBindings, testContext } from "./test/fakes";

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
beforeEach(async () => {
  for (const table of [bundleCases, bundleReviews, trades, coins, pools, creators, indexedTransactions, transfers, fundingScans, fairOpens, fairOpenSeatEvents]) await db.delete(table);
});
afterEach(() => vi.unstubAllGlobals());

const heat = CLUSTERS.devnet!;
const base58 = getBase58Decoder();
const newAddress = () => base58.decode(crypto.getRandomValues(new Uint8Array(32)));
const newSignature = () => base58.decode(crypto.getRandomValues(new Uint8Array(64)));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PERCENT = COIN_SUPPLY / 100n;

type Coin = { mint: string; pool: string; creator: string; creation: string; slot: number; openedAt: Date };

async function launch(o: { mode?: "instant" | "fair_open"; openedAt?: Date } = {}): Promise<Coin> {
  const c = { mint: newAddress(), pool: newAddress(), creator: newAddress(), creation: newSignature(), slot: 600_000, openedAt: o.openedAt ?? new Date("2026-11-02T10:00:00Z") };
  const config = o.mode === "fair_open" ? heat.configs!.fairOpen : heat.configs!.instant;
  const [record] = await db.insert(creators).values({ xUserId: newAddress(), xHandle: "e2e_creator_radar", xName: "Radar" }).returning();
  await db.insert(pools).values({
    pool: c.pool,
    mint: c.mint,
    config,
    creator: c.creator,
    name: "Radar",
    ticker: "RADAR",
    uri: "https://example.com/radar.json",
    activatedAt: c.openedAt,
    createdSignature: c.creation,
    createdSlot: c.slot,
    createdAt: c.openedAt,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    quoteReserve: 0n,
  });
  await db.insert(coins).values({
    mint: c.mint,
    pool: c.pool,
    config,
    launchMode: o.mode ?? "instant",
    creatorId: record!.id,
    creatorWallet: c.creator,
    name: "Radar",
    ticker: "RADAR",
    metadataUri: "https://example.com/radar.json",
    createdSignature: c.creation,
    createdSlot: c.slot,
    createdAt: c.openedAt,
  });
  await db.insert(indexedTransactions).values({ signature: c.creation, slot: c.slot, blockIndex: 20, signers: [c.creator, c.mint, heat.keys!.keeper] });
  return c;
}

async function buy(c: Coin, trader: string, coinsBought: bigint, o: { slot?: number; blockIndex?: number; ms?: number } = {}) {
  const signature = newSignature();
  const slot = o.slot ?? c.slot + 500;
  const blockIndex = o.blockIndex ?? 3;
  await db.insert(indexedTransactions).values({ signature, slot, blockIndex, signers: [trader] });
  await db.insert(trades).values({
    signature,
    eventIndex: 0,
    slot,
    blockIndex,
    orderKey: orderKey(slot, blockIndex, 0),
    at: new Date(c.openedAt.getTime() + (o.ms ?? 0)),
    pool: c.pool,
    mint: c.mint,
    trader,
    side: "buy",
    quoteAmount: 10_000_000n,
    baseAmount: coinsBought,
    fee: 125_000n,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    price: "0.000000003709",
    quoteReserve: 0n,
  });
  return signature;
}

async function transfer(c: Coin, source: string, destination: string, ms: number) {
  const signature = newSignature();
  await db.insert(transfers).values({ signature, ordinal: 0, slot: c.slot - 50, at: new Date(c.openedAt.getTime() + ms), source, destination, asset: "SOL", amount: "150000000" });
  return signature;
}

/** A chain with nothing new for the funding scans: the window's transfers are already written. */
const quiet: RadarSources = {
  funding: { listSignatures: async () => [], fetchParsed: async () => null } satisfies FundingSource,
  blockIndexOf: async () => 20,
};

/** The bundler simulation's shape (spec 11.1): the Creator wallet and 4 wallets it funded buy in the creation slot. */
async function bundled(c: Coin) {
  const funded = Array.from({ length: 4 }, newAddress);
  for (const w of funded) await transfer(c, c.creator, w, -10 * MIN);
  await buy(c, c.creator, 30_000_000_000n, { slot: c.slot, blockIndex: 21 });
  for (const [i, w] of funded.entries()) {
    await buy(c, w, 30_000_000_000n, { slot: c.slot, blockIndex: 22 + i });
    // Past the sniper tax, in the first hour: 0.3% of supply each.
    await buy(c, w, (PERCENT * 3n) / 10n, { ms: 70_000 });
  }
  return funded;
}

const bindings = (extra = {}) => testBindings(url, { BLOBS: new MemoryBlobs(), ...extra });

describe("the case job", () => {
  it("opens a case when wallets the Creator wallet funded bought 1% across the first hour, with only them in its evidence pack", async () => {
    const c = await launch();
    const funded = await bundled(c);
    // A sniper in the creation slot, far down its block, with nothing to the creator: labelled, never in the case.
    const sniper = newAddress();
    await buy(c, sniper, PERCENT, { slot: c.slot, blockIndex: 60 });
    const blobs = new MemoryBlobs();
    const now = new Date(c.openedAt.getTime() + 61 * MIN);

    const reviewed = await reviewCoin(db, config(bindings()), blobs, quiet, c.mint, now);
    // 4 x (0.3% + the creation slot's 0.003%): 1.212% of supply.
    expect(reviewed).toMatchObject({ outcome: "case", linkedWallets: 4, linkedCoins: 4n * ((PERCENT * 3n) / 10n + 30_000_000_000n) });
    const [row] = await db.select().from(bundleCases);
    expect(row).toMatchObject({ mint: c.mint, creatorWallet: c.creator, status: "open", linkedWallets: 4, supply: COIN_SUPPLY, evidenceKey: evidenceKey(c.mint), openedAt: now });
    expect(row!.creatorId).not.toBeNull();

    // The same pack in Postgres and R2.
    const stored = JSON.parse(new TextDecoder().decode(blobs.objects.get(evidenceKey(c.mint))!));
    expect(stored).toEqual(row!.evidence);
    expect(stored).toMatchObject({
      version: 1,
      cluster: "devnet",
      coin: { mint: c.mint, launchMode: "instant" },
      creator: { wallet: c.creator, xHandle: "e2e_creator_radar" },
      creation: { signature: c.creation, slot: c.slot, blockIndex: 20, jitoBundle: null },
      floor: { supply: COIN_SUPPLY.toString(), floor: PERCENT.toString(), share: "1.21%" },
    });
    const wallets = stored.wallets as { wallet: string; labels: string[]; transfers: { direction: string; explorer: string }[]; buys: { position: number | null }[] }[];
    expect(wallets.map((w) => w.wallet).sort()).toEqual(funded.slice().sort());
    expect(wallets.every((w) => w.labels.includes("creator_funded") && w.labels.includes("same_slot"))).toBe(true);
    expect(wallets.every((w) => w.transfers.length === 1 && w.transfers[0]!.direction === "from_creator" && w.transfers[0]!.explorer.endsWith("?cluster=devnet"))).toBe(true);
    // The positions after the creation: the second to fifth transactions after it are the bundle's.
    expect(wallets.flatMap((w) => w.buys.map((b) => b.position)).filter((p) => p !== null).sort()).toEqual([2, 3, 4, 5]);
    expect(JSON.stringify(stored)).not.toContain(sniper);

    // Reviewed again, it keeps the one case and its pack.
    const later = new Date(now.getTime() + 2 * 60 * MIN);
    await reviewCoin(db, config(bindings()), blobs, quiet, c.mint, later);
    expect(await db.$count(bundleCases)).toBe(1);
    expect((await db.select().from(bundleCases))[0]!.openedAt).toEqual(now);
    expect((await db.select().from(bundleReviews))[0]).toMatchObject({ outcome: "case", firstReviewedAt: now, reviewedAt: later });
  });

  it("never puts a wallet with no direct link in a case, however much it bought in the creation slot", async () => {
    const c = await launch();
    for (let i = 0; i < 3; i++) await buy(c, newAddress(), PERCENT, { slot: c.slot, blockIndex: 40 + i * 5 });
    // The Creator wallet's own open buy is labelled, never counted.
    await buy(c, c.creator, 5n * PERCENT, { ms: 2 * MIN });
    const blobs = new MemoryBlobs();
    expect(await reviewCoin(db, config(bindings()), blobs, quiet, c.mint, new Date(c.openedAt.getTime() + 61 * MIN))).toMatchObject({ outcome: "no_links", linkedCoins: 0n });
    expect(await db.$count(bundleCases)).toBe(0);
    expect(blobs.objects.size).toBe(0);
  });

  it("counts deposits into a Fair Open's pot toward the floor", async () => {
    const c = await launch({ mode: "fair_open" });
    const launchAccount = newAddress();
    await db.insert(fairOpens).values({
      launch: launchAccount,
      creator: c.creator,
      nonce: newAddress(),
      dbcConfig: heat.configs!.fairOpen,
      quoteMint: heat.quote.mint,
      identityHash: "00",
      depositsOpenAt: new Date(c.openedAt.getTime() - 10 * MIN),
      opensAt: c.openedAt,
      minRaise: 100_000_000n,
      potCap: 1_700_000_000n,
      lowestRung: 85_000_000n,
      step: 10_000_000n,
      status: "opened",
      mint: c.mint,
      pool: c.pool,
      createdSignature: newSignature(),
      createdSlot: c.slot - 2_000,
      createdAt: new Date(c.openedAt.getTime() - 20 * MIN),
    });
    const seat = async (wallet: string, kind: "deposit" | "delivery", coinsBought: bigint | null) => {
      const signature = newSignature();
      await db.insert(indexedTransactions).values({ signature, slot: c.slot - 10, signers: [wallet, heat.keys!.admission!] });
      await db.insert(fairOpenSeatEvents).values({
        signature,
        eventIndex: 0,
        slot: c.slot - 10,
        at: new Date(c.openedAt.getTime() + (kind === "deposit" ? -5 * MIN : MIN)),
        launch: launchAccount,
        wallet,
        person: "ab",
        kind,
        tier: kind === "deposit" ? "unverified" : null,
        amount: 100_000_000n,
        deposit: 100_000_000n,
        coins: coinsBought,
      });
    };
    // Two depositors the creator funded the day before: 0.8% of supply from the pot, 0.3% bought in the first hour.
    const [a, b] = [newAddress(), newAddress()];
    for (const w of [a, b]) {
      await transfer(c, c.creator, w, -DAY);
      await seat(w, "deposit", null);
      await seat(w, "delivery", (PERCENT * 4n) / 10n);
    }
    await buy(c, a, (PERCENT * 3n) / 10n, { ms: 5 * MIN });
    const blobs = new MemoryBlobs();
    expect(await reviewCoin(db, config(bindings()), blobs, quiet, c.mint, new Date(c.openedAt.getTime() + 61 * MIN))).toMatchObject({
      outcome: "case",
      linkedWallets: 2,
      linkedCoins: (PERCENT * 11n) / 10n,
    });
    const [row] = await db.select().from(bundleCases);
    const wallets = (row!.evidence as { wallets: { wallet: string; potCoins: string; deposits: unknown[] }[] }).wallets;
    expect(wallets.map((w) => [w.wallet, w.potCoins, w.deposits.length]).sort()).toEqual(
      [
        [a, ((PERCENT * 4n) / 10n).toString(), 1],
        [b, ((PERCENT * 4n) / 10n).toString(), 1],
      ].sort(),
    );
  });

  it("waits while the Creator wallet's funding window is not read through", async () => {
    const c = await launch();
    await bundled(c);
    const busy: RadarSources = {
      funding: {
        listSignatures: async () => [{ signature: newSignature(), slot: c.slot - 1, failed: false, blockTime: Math.floor(c.openedAt.getTime() / 1000) - 60 }],
        fetchParsed: async () => null,
      },
      blockIndexOf: async () => 20,
    };
    expect(await reviewCoin(db, config(bindings()), new MemoryBlobs(), busy, c.mint, new Date(c.openedAt.getTime() + 61 * MIN))).toEqual({ outcome: "pending", read: 0 });
    expect(await db.$count(bundleReviews)).toBe(0);
  });

  it("reviews a coin an hour after its open, then again each hour while proceeds sent back may link more wallets", async () => {
    // The RPC lists nothing new: what the funding scans find is written here as they would write it.
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      expect(input).toBe(ORIGINS.rpc);
      const { id } = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id, result: [] });
    });
    const c = await launch();
    const early = await launch({ openedAt: new Date(c.openedAt.getTime() + 30 * MIN) });
    // Two wallets bought 0.6% each in the first hour; only one is funded by the creator so far.
    const [a, b] = [newAddress(), newAddress()];
    await transfer(c, c.creator, a, -DAY);
    await buy(c, a, (PERCENT * 6n) / 10n, { ms: 2 * MIN });
    await buy(c, b, (PERCENT * 6n) / 10n, { ms: 3 * MIN });
    const env = bindings();
    const at = (ms: number) => new Date(c.openedAt.getTime() + ms);

    // Not before its first hour has ended.
    expect(await reviewBundles(db, env, at(59 * MIN))).toEqual({ reviewed: 0, cases: 0, pending: 0 });
    // Then once: below the floor, the other coin's hour not over yet.
    expect(await reviewBundles(db, env, at(65 * MIN))).toEqual({ reviewed: 1, cases: 0, pending: 0 });
    expect((await db.select().from(bundleReviews))[0]).toMatchObject({ mint: c.mint, outcome: "below_floor", linkedWallets: 1 });
    // The other wallet sends the creator its proceeds two days later.
    await transfer(c, b, c.creator, 2 * DAY);
    // Looked at again only once the hour since its review has passed; the other coin's first review meanwhile.
    expect(await reviewBundles(db, env, at(95 * MIN))).toEqual({ reviewed: 1, cases: 0, pending: 0 });
    expect(await db.$count(bundleReviews)).toBe(2);
    expect(await reviewBundles(db, env, at(125 * MIN))).toEqual({ reviewed: 1, cases: 1, pending: 0 });
    expect((await db.select().from(bundleCases))[0]).toMatchObject({ mint: c.mint, linkedWallets: 2, linkedCoins: (PERCENT * 12n) / 10n });
    // A coin with a case is not reviewed again, and nothing is once its 7 days are over.
    expect(await reviewBundles(db, env, at(3 * 60 * MIN))).toEqual({ reviewed: 1, cases: 0, pending: 0 });
    expect(await reviewBundles(db, env, at(8 * DAY))).toEqual({ reviewed: 0, cases: 0, pending: 0 });
    expect(early.mint).not.toBe(c.mint);
  });
});

describe("GET /coins/:mint/radar", () => {
  const { ctx, settle } = testContext();
  afterAll(() => settle());

  it("shows a coin's labels with their evidence, linked wallets first", async () => {
    const c = await launch();
    const funded = await bundled(c);
    const sniper = newAddress();
    await buy(c, sniper, PERCENT, { slot: c.slot, blockIndex: 60 });
    const res = await app.request(`/coins/${c.mint}/radar`, {}, bindings(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const radar = BundleRadar.parse(await res.json());
    // The linked wallets first, then the labelled ones by their first buy.
    expect(radar.wallets.slice(0, 4).every((w) => w.linked && funded.includes(w.wallet))).toBe(true);
    expect(radar.wallets.slice(4).map((w) => w.wallet)).toEqual([c.creator, sniper]);
    expect(radar.wallets.find((w) => w.wallet === c.creator)).toMatchObject({ creator: true, linked: false, labels: ["same_slot", "after_creation"] });
    expect(radar.wallets.find((w) => w.wallet === sniper)).toMatchObject({ linked: false, labels: ["same_slot"], counted: PERCENT.toString() });
    expect(radar).toMatchObject({ mint: c.mint, creatorWallet: c.creator, jito: false, floor: PERCENT.toString(), linked: { wallets: 4 } });
  });

  it("answers 404 for a pool our launch key never co-signed, or no address at all", async () => {
    expect((await app.request(`/coins/${newAddress()}/radar`, {}, bindings(), ctx)).status).toBe(404);
    expect((await app.request(`/coins/not-a-mint/radar`, {}, bindings(), ctx)).status).toBe(404);
  });
});
