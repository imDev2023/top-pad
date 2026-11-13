// The Discover board (spec 8, 9 screen 1, #57): its sections in spec 8's order from the CoinRecord mirror only, the sealed
// calendar with its featured slots, Trending's demotion of a confirmed creator bundle, search, and the signed daily
// snapshot of the CoinRecord list, checked against the chain.
import { generateKeyPairSigner, getBase58Decoder, none, some, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, verifySnapshot, WSOL_MINT } from "@top-pad/chain";
import { FEE_PROGRAM_ADDRESS, getCoinRecordEncoder, LaunchMode } from "@top-pad/clients/fee";
import { Board, CoinRecordList, CoinRecordSnapshot, SearchResults, type CreatorSummary } from "@top-pad/contract";
import {
  bars,
  bundleCases,
  coinRadar,
  coinRecordSnapshots,
  coins,
  creators,
  creatorWallets,
  createDb,
  fairOpens,
  fairOpenSeatEvents,
  graduations,
  launches,
  pools,
  trades,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { featuredOf, snapshotCoinRecords } from "./board";
import { config } from "./env";
import { app } from "./index";
import { Fakes, MemoryBlobs, testBindings, testContext, testKeypair } from "./test/fakes";

// The keeper key the cluster records is swapped for a test key: the real one lives only in Secrets Store (spec 10.3).
vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { testKeypair } = await import("./test/fakes");
  const keeper = await testKeypair();
  (globalThis as { __testKeeper?: typeof keeper }).__testKeeper = keeper;
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, keeper: keeper.signer.address } } } };
});
const keeper = () => (globalThis as { __testKeeper?: Awaited<ReturnType<typeof testKeypair>> }).__testKeeper!;

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
let fakes: Fakes;
beforeEach(async () => {
  fakes = new Fakes();
  vi.stubGlobal("fetch", fakes.fetch);
  for (const table of [coinRecordSnapshots, bars, bundleCases, trades, coinRadar, graduations, fairOpenSeatEvents, fairOpens, coins, pools, launches, creatorWallets, creators]) await db.delete(table);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const request = (path: string) => app.request(path, {}, testBindings(url), ctx);
const board = async () => {
  const res = await request("/board");
  expect(res.status, await res.clone().text()).toBe(200);
  return Board.parse(await res.json());
};
const search = async (q: string) => SearchResults.parse(await (await request(`/search?q=${encodeURIComponent(q)}`)).json()).coins.map((c) => c.ticker);

const { instant, fairOpen: fairOpenConfig } = CLUSTERS.devnet!.configs!;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
const addr = async () => (await generateKeyPairSigner()).address;

/** A Creator record with its current Creator wallet. */
async function creator(handle: string | null = null) {
  const wallet = await addr();
  const [row] = await db.insert(creators).values({ xUserId: handle ? `x-${handle}` : null, xHandle: handle, xName: handle, createdAt: ago(30 * DAY) }).returning();
  await db.insert(creatorWallets).values({ creatorId: row!.id, wallet, via: "sign_in", proof: signature(), startedAt: ago(30 * DAY) });
  return { id: row!.id, wallet };
}
type Creator = Awaited<ReturnType<typeof creator>>;

let slot = 10_000;
/** A Heat coin listed at `at` (an Instant launch's creation, a Fair Open's open); `heat: false` makes a pool around Heat's flow. */
async function coin(ticker: string, o: { at?: Date; by?: Creator; mode?: "instant" | "fair_open"; heat?: boolean; graduatedAt?: Date; name?: string } = {}) {
  const [mint, pool] = await Promise.all([addr(), addr()]);
  const at = o.at ?? ago(10 * MIN);
  const by = o.by ?? (await creator());
  const mode = o.mode ?? "instant";
  const created = { createdSignature: signature(), createdSlot: ++slot, createdAt: at };
  const name = o.name ?? `${ticker} coin`;
  await db.insert(pools).values({
    pool,
    mint,
    config: mode === "instant" ? instant : fairOpenConfig,
    creator: by.wallet,
    quoteMint: WSOL_MINT,
    graduationTarget: 8_500_000_000n,
    startSqrtPrice: CLUSTERS.devnet!.sqrtStartPrice.toString(),
    name,
    ticker,
    uri: "https://turbo-gateway.com/x",
    activatedAt: at,
    sqrtPrice: CLUSTERS.devnet!.sqrtStartPrice.toString(),
    quoteReserve: 0n,
    ...created,
  });
  if (o.heat !== false) {
    await db.insert(coins).values({
      mint,
      pool,
      config: mode === "instant" ? instant : fairOpenConfig,
      launchMode: mode,
      creatorId: by.id,
      creatorWallet: by.wallet,
      name,
      ticker,
      metadataUri: "https://turbo-gateway.com/x",
      imageUri: "https://turbo-gateway.com/image",
      ...created,
    });
  }
  if (o.graduatedAt) {
    await db.insert(graduations).values({
      mint,
      curvePool: pool,
      pool: await addr(),
      config: instant,
      signature: signature(),
      slot: ++slot,
      graduatedAt: o.graduatedAt,
      sqrtPrice: "1000",
      creatorPosition: await addr(),
      creatorPositionNftMint: await addr(),
      creatorPositionOwner: by.wallet,
      creatorLiquidity: "1",
      heatPosition: await addr(),
      heatPositionNftMint: await addr(),
      heatLiquidity: "1",
    });
  }
  return { mint, pool, ticker, by, ...created };
}

/** A buy of the coin by a fresh wallet `at`. */
async function buy(c: { mint: string; pool: string }, at = ago(5 * MIN), trader?: string) {
  const s = ++slot;
  await db.insert(trades).values({
    signature: signature(),
    eventIndex: 0,
    slot: s,
    blockIndex: 1,
    orderKey: (BigInt(s) * 10n ** 10n + 10n ** 4n).toString(),
    at,
    pool: c.pool,
    mint: c.mint,
    trader: trader ?? (await addr()),
    side: "buy",
    quoteAmount: 10_000_000n,
    baseAmount: 1_000_000n,
    fee: 0n,
    sqrtPrice: "1000",
    price: "0.000000028",
    quoteReserve: 0n,
  });
}

/** A Fair Open Heat's launch service scheduled, its coin sealed until `opensAt`. */
async function scheduled(by: Creator, opensAt: Date, o: { teaser?: string; cancelled?: boolean; status?: "landed" | "prepared"; secret?: string } = {}) {
  const [launch, nonce, mint, pool] = await Promise.all([addr(), addr(), addr(), addr()]);
  const secret = o.secret ?? `SEALED${++slot}`;
  const depositsOpenAt = new Date(opensAt.getTime() - 10 * MIN);
  await db.insert(launches).values({
    creatorId: by.id,
    wallet: by.wallet,
    mode: "fair_open",
    name: `${secret} name`,
    ticker: secret,
    mint,
    pool,
    config: fairOpenConfig,
    quoteMint: WSOL_MINT,
    metadataUri: `https://turbo-gateway.com/${secret}`,
    imageUri: `https://turbo-gateway.com/${secret}-image`,
    message: "AA==",
    lastValidBlockHeight: 1n,
    status: o.status ?? "landed",
    fairOpen: launch,
    nonce,
    depositsOpenAt,
    opensAt,
    minRaise: 500_000_000n,
    teaser: o.teaser ?? "racing",
    ladder: "signed",
    cancelledAt: o.cancelled ? new Date() : null,
  });
  await db.insert(fairOpens).values({
    launch,
    creator: by.wallet,
    nonce,
    dbcConfig: fairOpenConfig,
    quoteMint: WSOL_MINT,
    identityHash: "ab".repeat(32),
    depositsOpenAt,
    opensAt,
    minRaise: 500_000_000n,
    potCap: 1_700_000_000n,
    lowestRung: 100_000_000n,
    step: 10_000_000n,
    teaser: o.teaser ?? "racing",
    createdSignature: signature(),
    createdSlot: ++slot,
    createdAt: ago(HOUR),
  });
  return { launch, mint, secret };
}

async function deposit(launch: string, wallet: string, kind: "deposit" | "withdraw", deposit: bigint) {
  await db.insert(fairOpenSeatEvents).values({ signature: signature(), eventIndex: 0, slot: ++slot, at: new Date(), launch, wallet, person: "00", kind, tier: kind === "deposit" ? "scored" : null, amount: 1n, deposit });
}

/** The evidence pack Bundle Radar keeps with a case (bundleRadar.ts, `evidencePack`), its wallets left out. */
const pack = (creatorWallet: string) => ({
  version: 1,
  cluster: "devnet",
  reviewedAt: ago(5 * DAY).toISOString(),
  rule: "Wallets directly linked to the Creator wallet bought 1% or more of the coin's supply between them, across the pot and the first hour of trading (spec 6.5).",
  creator: { wallet: creatorWallet },
  creation: { signature: signature(), explorer: "https://explorer.solana.com/tx/s?cluster=devnet", slot: 4242, blockIndex: 7 },
  floor: { supply: "1000000000000000", floor: "10000000000000", linkedCoins: "20000000000000", share: "2.00%" },
  wallets: [],
});

/** A published Bar on the coin's record (spec 6.5): its case confirmed and its 72-hour private window over. */
async function publishedBar(c: { mint: string; by: Creator }) {
  const [kase] = await db
    .insert(bundleCases)
    .values({ mint: c.mint, creatorWallet: c.by.wallet, creatorId: c.by.id, status: "confirmed", linkedWallets: 3, linkedCoins: 20_000_000_000_000n, supply: 1n, evidence: pack(c.by.wallet), evidenceKey: "k" })
    .returning();
  await db.insert(bars).values({ caseId: kase!.id, mint: c.mint, creatorId: c.by.id, creatorWallet: c.by.wallet, confirmedBy: "op@example.com", confirmedAt: ago(4 * DAY), publishAt: ago(DAY), note: "linked wallets" });
}

describe("the board", () => {
  it("lists Live now, Up next, Trending, New and Graduated from Heat's coins only, the calendar sealed", async () => {
    const maker = await creator("maker");
    const graduate = await coin("GRAD", { at: ago(3 * DAY), by: maker, graduatedAt: ago(2 * DAY) });
    const older = await coin("OLDR", { at: ago(20 * MIN), by: maker });
    const opened = await coin("OPND", { at: ago(5 * MIN), mode: "fair_open" });
    const around = await coin("ARND", { at: ago(MIN), heat: false });
    for (let i = 0; i < 3; i++) await buy(older);
    await buy(opened);
    for (let i = 0; i < 5; i++) await buy(around);
    await db.insert(coinRadar).values({ mint: older.mint, linkedWallets: [await addr()], linkedCoins: 12_000_000_000_000n, earlyBuys: 2 });

    const live = await scheduled(maker, ahead(6 * MIN), { teaser: "thunder" });
    const deposits = [await addr(), await addr(), await addr()];
    await deposit(live.launch, deposits[0]!, "deposit", 100_000_000n);
    await deposit(live.launch, deposits[1]!, "deposit", 200_000_000n);
    await deposit(live.launch, deposits[2]!, "deposit", 50_000_000n);
    await deposit(live.launch, deposits[2]!, "withdraw", 0n);
    const tomorrow = await scheduled(await creator(), ahead(DAY));
    const beyond = await scheduled(maker, ahead(8 * DAY));
    const cancelled = await scheduled(maker, ahead(2 * DAY), { cancelled: true });
    const unsent = await scheduled(maker, ahead(3 * DAY), { status: "prepared" });

    const res = await request("/board");
    const text = await res.clone().text();
    const shown = Board.parse(await res.json());

    expect(shown.liveNow.map((e) => e.launch)).toEqual([live.launch]);
    expect(shown.liveNow[0]).toMatchObject({ phase: "window", teaser: "thunder", pot: { total: "300000000", seats: 2 }, minRaise: "500000000", potCap: "1700000000", creator: { wallet: maker.wallet, handle: "maker" } });
    expect(shown.liveNow[0]!.record).toMatchObject({ coins: 2, graduations: 1, marks: { verifiedCreator: true } });
    expect(shown.upNext.map((e) => e.launch)).toEqual([tomorrow.launch]);
    expect(shown.upNext[0]).toMatchObject({ phase: "scheduled", pot: { total: "0", seats: 0 } });
    // Nothing about a sealed coin before its open: not its name, ticker, mint or image.
    for (const sealed of [live, tomorrow]) {
      expect(text).not.toContain(sealed.secret);
      expect(text).not.toContain(sealed.mint);
    }
    for (const left of [beyond, cancelled, unsent]) expect(text).not.toContain(left.launch);

    expect(shown.trending.map((c) => [c.ticker, c.trending?.buyers])).toEqual([
      ["OLDR", 3],
      ["OPND", 1],
    ]);
    expect(shown.trending[0]!.flags).toMatchObject({ linked: { wallets: 1, coins: "12000000000000" }, earlyBuys: 2, confirmedBundle: false });
    // New: an Instant launch at its creation, a Fair Open at its open, newest first.
    expect(shown.new.map((c) => c.ticker)).toEqual(["OPND", "OLDR", "GRAD"]);
    expect(shown.new[0]).toMatchObject({ launchMode: "fair_open", trending: null });
    expect(shown.graduated.map((c) => c.ticker)).toEqual(["GRAD"]);
    expect(shown.graduated[0]!.graduatedAt).not.toBeNull();
    // A pool made around Heat's flow is nowhere on the board, nor in search.
    expect(text).not.toContain(around.mint);
    expect(text).not.toContain("ARND");
    expect(await search("ARND")).toEqual([]);
    expect(graduate.mint).toBe(shown.graduated[0]!.mint);
  });

  it("takes a coin with a published confirmed creator bundle out of Trending, leaving it in New and search with its flag", async () => {
    const bundled = await coin("BNDL");
    const other = await coin("CLEN");
    for (let i = 0; i < 4; i++) await buy(bundled);
    await buy(other);
    expect((await board()).trending.map((c) => c.ticker)).toEqual(["BNDL", "CLEN"]);

    await publishedBar(bundled);
    const shown = await board();
    expect(shown.trending.map((c) => c.ticker)).toEqual(["CLEN"]);
    expect(shown.new.find((c) => c.ticker === "BNDL")!.flags.confirmedBundle).toBe(true);
    const found = SearchResults.parse(await (await request("/search?q=bndl")).json()).coins;
    expect(found.map((c) => [c.ticker, c.flags.confirmedBundle])).toEqual([["BNDL", true]]);
  });

  it("gives a good record's Fair Open its day's featured slot, never a first-time or barred creator's", async () => {
    const good = await creator("good");
    await coin("WON", { by: good, at: ago(5 * DAY), graduatedAt: ago(4 * DAY) });
    const barred = await creator("barred");
    const barredCoin = await coin("BAD", { by: barred, at: ago(5 * DAY), graduatedAt: ago(4 * DAY) });
    await publishedBar(barredCoin);
    const day = new Date(Math.floor(Date.now() / DAY) * DAY + 2 * DAY);
    const featured = await scheduled(good, new Date(day.getTime() + 12 * HOUR));
    const firstTime = await scheduled(await creator(), new Date(day.getTime() + 13 * HOUR));
    const fromBarred = await scheduled(barred, new Date(day.getTime() + 14 * HOUR));
    const shown = (await board()).upNext;
    expect(shown.map((e) => [e.launch, e.featured])).toEqual([
      [featured.launch, true],
      [firstTime.launch, false],
      [fromBarred.launch, false],
    ]);
    expect(shown[2]!.record!.barred).toMatchObject({ ticker: "BAD" });
  });

  it("orders each day's three featured slots by graduation rate, then the latest graduation", () => {
    const summary = (rate: number | null, last: string | null, verified = true): CreatorSummary => ({
      id: crypto.randomUUID(),
      wallet: null,
      x: null,
      coins: 1,
      graduations: rate ? 1 : 0,
      graduationRate: rate,
      lastGraduatedAt: last,
      handedOver: 0,
      quiet: 0,
      marks: { verifiedCreator: verified, verifiedHuman: false },
      barred: null,
      since: "2026-01-01T00:00:00.000Z",
    });
    const entry = (launch: string, opensAt: string, record: CreatorSummary | null) => ({ launch, opensAt, record });
    const featured = featuredOf([
      entry("a", "2026-11-20T01:00:00.000Z", summary(1, "2026-11-01T00:00:00.000Z")),
      entry("b", "2026-11-20T02:00:00.000Z", summary(1, "2026-11-10T00:00:00.000Z")),
      entry("c", "2026-11-20T03:00:00.000Z", summary(0.5, "2026-11-12T00:00:00.000Z")),
      entry("d", "2026-11-20T04:00:00.000Z", summary(0.25, "2026-11-12T00:00:00.000Z")),
      entry("e", "2026-11-20T05:00:00.000Z", summary(null, null, false)),
      entry("f", "2026-11-20T06:00:00.000Z", null),
      // Another UTC day has its own three.
      entry("g", "2026-11-21T00:30:00.000Z", summary(0.1, "2026-11-01T00:00:00.000Z")),
    ]);
    expect([...featured].sort()).toEqual(["a", "b", "c", "g"]);
  });
});

describe("search", () => {
  it("finds Heat coins by ticker, name or mint, an exact ticker first", async () => {
    const exact = await coin("RACE", { at: ago(30 * MIN) });
    await coin("RACER", { at: ago(5 * MIN) });
    await coin("ZOOM", { at: ago(MIN), name: "Drag race" });
    await coin("NOPE");
    expect(await search("race")).toEqual(["RACE", "RACER", "ZOOM"]);
    expect(await search("$RACE")).toEqual(["RACE", "RACER", "ZOOM"]);
    expect(await search(exact.mint)).toEqual(["RACE"]);
    expect(await search("%")).toEqual([]);
    expect(await search("")).toEqual([]);
  });
});

describe("the CoinRecord list", () => {
  /** The coin's `CoinRecord` on the fake chain, registered at `at`. */
  function onChain(c: { mint: string; pool: string }, at: Date, fairOpenLaunch?: string) {
    const data = getCoinRecordEncoder().encode({
      mint: c.mint as Address,
      pool: c.pool as Address,
      launchMode: fairOpenLaunch ? LaunchMode.FairOpen : LaunchMode.Instant,
      fairOpenLaunch: fairOpenLaunch ? some(fairOpenLaunch as Address) : none(),
      potFee: 0n,
      windowClaimed: true,
      earningsRecipient: none(),
      registeredAt: BigInt(Math.floor(at.getTime() / 1000)),
      bump: 255,
    });
    fakes.accounts.set(c.mint, { owner: FEE_PROGRAM_ADDRESS, data: new Uint8Array(data) });
  }

  it("mirrors the list page by page, and signs each finished day's snapshot, which verifies against the chain", async () => {
    const today = new Date(Math.floor(Date.now() / DAY) * DAY);
    const a = await coin("AAA", { at: new Date(today.getTime() - 20 * HOUR) });
    const b = await coin("BBB", { at: new Date(today.getTime() - 10 * HOUR), mode: "fair_open" });
    const launch = await addr();
    await db.insert(fairOpens).values({ ...(await fairOpenRow(launch)), mint: b.mint, pool: b.pool, status: "opened" });
    const c = await coin("CCC", { at: new Date(today.getTime() + MIN) });
    const around = await coin("DDD", { at: new Date(today.getTime() - 5 * HOUR), heat: false });
    onChain(a, a.createdAt);
    onChain(b, b.createdAt, launch);
    onChain(c, c.createdAt);

    const first = CoinRecordList.parse(await (await request("/coin-records?limit=2")).json());
    expect(first.coins.map((r) => r.mint)).toEqual([a.mint, b.mint]);
    expect(first.coins[1]).toMatchObject({ launchMode: "fair_open", fairOpenLaunch: launch });
    expect(first.launchKey).toBe(keeper().signer.address);
    const second = CoinRecordList.parse(await (await request(`/coin-records?limit=2&after=${first.next}`)).json());
    expect(second.coins.map((r) => r.mint)).toEqual([c.mint]);
    expect(second.next).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain(around.mint);

    const env = testBindings(url, { KEEPER_KEY: JSON.stringify(Array.from(keeper().secret)), BLOBS: new MemoryBlobs() });
    const made = await snapshotCoinRecords(db, config(env), { get: async () => env.KEEPER_KEY as string }, env.BLOBS);
    expect(made).toEqual({ day: new Date(today.getTime() - DAY).toISOString().slice(0, 10), coins: 2, chainCoins: 2, mismatches: { missing: [], extra: [], different: [] } });
    expect(await snapshotCoinRecords(db, config(env), { get: async () => env.KEEPER_KEY as string }, env.BLOBS)).toMatchObject({ skipped: "made already" });

    const res = await app.request("/coin-records/snapshots/latest", {}, env, ctx);
    const snapshot = CoinRecordSnapshot.parse(await res.json());
    const body = await verifySnapshot(snapshot, keeper().signer.address);
    expect(body.coins.map((r) => r.mint)).toEqual([a.mint, b.mint]);
    expect(body).toMatchObject({ cluster: "devnet", through: today.toISOString(), program: FEE_PROGRAM_ADDRESS });
    const byDay = CoinRecordSnapshot.parse(await (await app.request(`/coin-records/snapshots/${snapshot.day}`, {}, env, ctx)).json());
    expect(byDay.signature).toBe(snapshot.signature);
  });

  it("records how a snapshot differs from the chain", async () => {
    const today = new Date(Math.floor(Date.now() / DAY) * DAY);
    const a = await coin("EEE", { at: new Date(today.getTime() - 2 * HOUR) });
    const missed = { mint: await addr(), pool: await addr() };
    onChain(a, a.createdAt);
    onChain(missed, new Date(today.getTime() - HOUR));
    const env = testBindings(url, { KEEPER_KEY: JSON.stringify(Array.from(keeper().secret)), BLOBS: new MemoryBlobs() });
    const made = await snapshotCoinRecords(db, config(env), { get: async () => env.KEEPER_KEY as string }, env.BLOBS);
    expect(made).toMatchObject({ coins: 1, chainCoins: 2, mismatches: { missing: [missed.mint], extra: [], different: [] } });
  });
});

async function fairOpenRow(launch: string) {
  return {
    launch,
    creator: await addr(),
    nonce: await addr(),
    dbcConfig: fairOpenConfig,
    quoteMint: WSOL_MINT,
    identityHash: "cd".repeat(32),
    depositsOpenAt: ago(DAY),
    opensAt: ago(DAY),
    minRaise: 1n,
    potCap: 1n,
    lowestRung: 1n,
    step: 1n,
    createdSignature: signature(),
    createdSlot: ++slot,
    createdAt: ago(DAY),
  };
}
