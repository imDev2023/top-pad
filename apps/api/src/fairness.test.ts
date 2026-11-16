import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUSTERS, WSOL_MINT } from "@top-pad/chain";
import { FairnessCard } from "@top-pad/contract";
import { dayOf } from "@top-pad/contract/format";
import {
  bars,
  bundleCases,
  coins,
  createDb,
  creators,
  creatorWallets,
  fairOpens,
  fairOpenSeatEvents,
  graduations,
  pools,
  trades,
  windowClaims,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { cardImageKey } from "./fairness";
import { app } from "./index";
import { ORIGINS, testBindings, testContext } from "./test/fakes";

// The Fairness card (spec 9, #58) from what the indexer wrote and the Creator wallet's holdings on chain: each row from
// its facts, red rows first, the counts, and the image named by the card's version and kept in R2.

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
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());

/** R2 as the Worker binds it, in memory. */
const blobs = new Map<string, Uint8Array>();
const BLOBS = {
  put: async (key: string, value: Uint8Array) => void blobs.set(key, value),
  get: async (key: string) => {
    const b = blobs.get(key);
    return b ? { arrayBuffer: async () => b.slice().buffer } : null;
  },
};
const request = (path: string) => app.request(path, {}, testBindings(url, { BLOBS }), ctx);
const card = async (mint: string) => {
  const res = await request(`/coins/${mint}/fairness`);
  expect(res.status, await res.clone().text()).toBe(200);
  return FairnessCard.parse(await res.json());
};

const { instant, fairOpen: fairOpenConfig } = CLUSTERS.devnet!.configs!;
const KEEPER = CLUSTERS.devnet!.keys!.keeper;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms);
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
const addr = async () => (await generateKeyPairSigner()).address;
let slot = 10_000;
/** The Creator lock's cliff and end, ahead of the test's clock. */
const CLIFF = new Date(Date.now() + 5 * DAY);
const ENDS = new Date(Date.now() + 28 * DAY);

/**
 * The RPC as the card reads it: each wallet's token accounts of a mint, by `getTokenAccountsByOwner`, each amount as the
 * 8 bytes of the data slice the card asks for. A wallet missing from `held` holds no account.
 */
function chainHolds(held: Record<string, bigint[]>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    expect(input).toBe(ORIGINS.rpc);
    const { method, params } = JSON.parse(String(init.body));
    expect(method).toBe("getTokenAccountsByOwner");
    expect(params[2]).toMatchObject({ encoding: "base64", dataSlice: { offset: 64, length: 8 } });
    asked.push(params[0]);
    const value = (held[params[0]] ?? []).map((amount) => {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setBigUint64(0, amount, true);
      return { pubkey: "x", account: { data: [btoa(String.fromCharCode(...data)), "base64"] } };
    });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
  });
  return asked;
}

/** A Creator record with its Creator wallet. */
async function creator(handle: string | null) {
  const wallet = await addr();
  const [row] = await db.insert(creators).values({ xUserId: handle ? `x-${handle}` : null, xHandle: handle, xName: handle, createdAt: ago(30 * DAY) }).returning();
  await db.insert(creatorWallets).values({ creatorId: row!.id, wallet, via: "sign_in", proof: signature(), startedAt: ago(30 * DAY) });
  return { id: row!.id, wallet };
}
type Creator = Awaited<ReturnType<typeof creator>>;

/** A Heat coin, or a pool around Heat's flow with `heat: false`. */
async function coin(ticker: string, by: Creator, o: { mode?: "instant" | "fair_open"; heat?: boolean; at?: Date; mint?: string } = {}) {
  const [mint, pool] = await Promise.all([o.mint ?? addr(), addr()]);
  const mode = o.mode ?? "instant";
  const at = o.at ?? ago(2 * DAY);
  const created = { createdSignature: signature(), createdSlot: ++slot, createdAt: at };
  const config = mode === "instant" ? instant : fairOpenConfig;
  const uri = `https://turbo-gateway.com/${ticker}`;
  await db.insert(pools).values({
    pool,
    mint,
    config,
    creator: by.wallet,
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
  if (o.heat !== false) {
    await db
      .insert(coins)
      .values({ mint, pool, config, launchMode: mode, creatorId: by.id, creatorWallet: by.wallet, name: `${ticker} coin`, ticker, metadataUri: uri, imageUri: null, ...created });
  }
  return { mint, pool, ticker, by, ...created };
}
type Coin = Awaited<ReturnType<typeof coin>>;

async function trade(c: Coin, trader: string, side: "buy" | "sell", baseAmount: bigint, signatureOf = signature()) {
  const s = ++slot;
  await db.insert(trades).values({
    signature: signatureOf,
    eventIndex: 0,
    slot: s,
    blockIndex: 1,
    orderKey: (BigInt(s) * 10n ** 10n + 10n ** 4n).toString(),
    at: ago(DAY),
    pool: c.pool,
    mint: c.mint,
    trader,
    side,
    quoteAmount: 10_000_000n,
    baseAmount,
    fee: 0n,
    sqrtPrice: "1000",
    price: "0.000000028",
    quoteReserve: 0n,
  });
}

/** A Fair Open that opened on `c`: 4 seats, the pot's 1.7 SOL buying 100M coins, the creator's coins locked, the Tax Share paid to 3. */
async function openedFairOpen(c: Coin) {
  const [launch, nonce] = await Promise.all([addr(), addr()]);
  const opened = signature();
  const taxShareSignature = signature();
  await db.insert(fairOpens).values({
    launch,
    creator: c.by.wallet,
    nonce,
    dbcConfig: fairOpenConfig,
    quoteMint: WSOL_MINT,
    identityHash: "ab".repeat(32),
    depositsOpenAt: ago(2 * DAY + 10 * MIN),
    opensAt: c.createdAt,
    minRaise: 500_000_000n,
    potCap: 1_700_000_000n,
    lowestRung: 100_000_000n,
    step: 10_000_000n,
    status: "closed",
    mint: c.mint,
    pool: c.pool,
    spent: 1_700_000_000n,
    coins: 100_000_000_000_000n,
    seats: 4,
    openedSignature: opened,
    openedAt: c.createdAt,
    lockEscrow: "Escrow1111111111111111111111111111111111111",
    lockCoins: 20_618_441_700_336n,
    lockCliffAt: CLIFF,
    lockEndsAt: ENDS,
    lockedAt: c.createdAt,
    lockSignature: signature(),
    taxShare: 23_108_335n,
    taxShareFees: 23_000_000n,
    taxShareDust: 108_335n,
    taxShareBasis: 1_200_000_000n,
    taxShareToTreasury: false,
    taxShareCollectedAt: new Date("2026-11-13T07:02:00Z"),
    taxShareSignature,
    createdSignature: signature(),
    createdSlot: ++slot,
    createdAt: ago(3 * DAY),
  });
  const event = (wallet: string, kind: "lock" | "tax_share", amount: bigint, deposit: bigint) =>
    db.insert(fairOpenSeatEvents).values({ signature: signature(), eventIndex: 0, slot: ++slot, at: c.createdAt, launch, wallet, person: "00", kind, amount, deposit });
  await event(c.by.wallet, "lock", 1n, 500_000_000n);
  for (let i = 0; i < 3; i++) await event(await addr(), "tax_share", i === 0 ? 7_702_779n : 7_702_778n, 400_000_000n);
  return { launch, opened, taxShareSignature };
}

describe("a Fair Open coin's Fairness card", () => {
  it("states each row from its facts, in the spec's order, with what the Creator wallet holds on chain", async () => {
    const by = await creator("pixelpigeon");
    const c = await coin("PIGEON", by, { mode: "fair_open" });
    const { launch, opened, taxShareSignature } = await openedFairOpen(c);
    // The Creator wallet bought 2M coins on the pool after the open and holds 1.5M of them, across two accounts.
    await trade(c, by.wallet, "buy", 2_000_000_000_000n);
    await trade(c, by.wallet, "sell", 500_000_000_000n);
    const asked = chainHolds({ [by.wallet]: [1_000_000_000_000n, 500_000_000_000n] });

    const got = await card(c.mint);
    expect(asked).toEqual([by.wallet]);
    expect(got.rows.map((r) => [r.key, r.flag])).toEqual([
      ["launch", "green"],
      ["creator_lock", "green"],
      ["holdings", "yellow"],
      ["liquidity", "green"],
      ["radar", "neutral"],
      ["creator", "neutral"],
      ["keeper", "green"],
      ["tax", "green"],
    ]);
    expect(got.counts).toEqual({ green: 5, yellow: 1, red: 0 });
    expect(got.facts).toMatchObject({
      launch: { mode: "fair_open", launch, people: 4, spent: "1700000000", coins: "100000000000000", price: "0.000000017000000000", identityHash: "ab".repeat(32), opened },
      creatorLock: { status: "locked", deposit: "500000000", coins: "20618441700336", cliffAt: CLIFF.toISOString(), endsAt: ENDS.toISOString() },
      holdings: { wallet: by.wallet, coins: "1500000000000", bought: "2000000000000" },
      liquidity: { curve: c.pool, graduated: null },
      radar: { linkedWallets: 0, linkedCoins: "0", earlyBuys: 0 },
      finding: null,
      record: { id: by.id, x: { handle: "pixelpigeon" }, coins: 1 },
      keeper: { address: KEEPER, signature: opened },
      tax: { to: "depositors", collected: { total: "23108335", paidSeats: 3, toTreasury: false, signature: taxShareSignature } },
    });
    const row = Object.fromEntries(got.rows.map((r) => [r.key, r]));
    expect(row.launch!.value).toBe("Fair Open: 4 people bought at one price, 0.017 SOL a million coins");
    expect(row.launch!.links).toEqual([
      { label: "The open", href: `https://explorer.solana.com/tx/${opened}?cluster=devnet` },
      { label: "The Fair Open", href: `/fair-open/${launch}` },
    ]);
    expect(row.creator_lock!.value).toBe(`The creator's 0.5\u{a0}SOL deposit bought 20.62M $PIGEON, locked until ${dayOf(CLIFF.toISOString())}`);
    expect(row.creator_lock!.short).toBe(`Creator locked until ${dayOf(CLIFF.toISOString())}`);
    expect(row.holdings!.value).toBe("The Creator wallet holds 1.5M $PIGEON, 0.15% of supply outside the lock");
    expect(row.holdings!.detail).toContain("It bought 2M $PIGEON on the pool since the open.");
    expect(row.liquidity!.value).toBe("Liquidity sits in Meteora's bonding curve; nobody can withdraw it");
    expect(row.keeper!.value).toContain(`${KEEPER.slice(0, 4)}\u{2026}${KEEPER.slice(-4)}`);
    expect(row.tax!.value).toBe("The first minute's tax, 0.0231\u{a0}SOL, went to 3 depositors as their Tax Share");
    expect(got.version).toMatch(/^[0-9a-f]{16}$/);
    expect(got.image).toBe(`${ORIGINS.api}/coins/${c.mint}/card.png?v=${got.version}`);
  });

  it("says a Creator lock past its cliff is releasing, and one past its end ran its course", async () => {
    const c = await coin("RLSE", await creator(null), { mode: "fair_open" });
    await openedFairOpen(c);
    chainHolds({});
    await db.update(fairOpens).set({ lockCliffAt: ago(DAY), lockEndsAt: new Date(Date.now() + DAY) }).where(eq(fairOpens.mint, c.mint));
    const releasing = (await card(c.mint)).rows.find((r) => r.key === "creator_lock")!;
    expect(releasing.short).toBe(`Creator lock releasing until ${dayOf(new Date(Date.now() + DAY).toISOString())}`);
    expect(releasing.value).toMatch(/, releasing steadily until /);
    expect(releasing.detail).toContain(`Locked until ${dayOf(ago(DAY).toISOString())} in a Jupiter Lock escrow`);
  });

  it("says a creator who bought nothing has nothing locked, and that holdings could not be read when the chain fails", async () => {
    const by = await creator(null);
    const c = await coin("BARE", by, { mode: "fair_open" });
    await openedFairOpen(c);
    await db.update(fairOpens).set({ lockEscrow: null, lockCoins: 0n, lockCliffAt: null, lockEndsAt: null }).where(eq(fairOpens.mint, c.mint));
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const got = await card(c.mint);
    const row = Object.fromEntries(got.rows.map((r) => [r.key, r]));
    expect(row.creator_lock).toMatchObject({ flag: "green", value: "The creator bought nothing in the Fair Open, so nothing is locked" });
    expect(row.holdings).toMatchObject({ flag: "neutral", value: "The Creator wallet's holdings could not be read from the chain just now" });
    expect(got.facts.holdings.coins).toBeNull();
    // A record with no X is named by its Creator wallet.
    expect(row.creator!.short).toBe(`Creator ${by.wallet.slice(0, 4)}\u{2026}${by.wallet.slice(-4)} · 1 coin`);
  });
});

describe("an Instant launch's Fairness card", () => {
  it("says it had no creator buy, that its tax went to Heat, and once graduated that its liquidity is locked forever, checkered", async () => {
    const by = await creator("instant_maker");
    const c = await coin("QUICK", by);
    const claim = signature();
    await db.insert(windowClaims).values({ pool: c.pool, mint: c.mint, heat: true, destination: await addr(), amount: 450_000_000n, windowEndedAt: ago(DAY), claimedAt: new Date("2026-11-13T19:01:00Z"), signature: claim, slot: ++slot });
    const [pool, creatorPosition, heatPosition] = await Promise.all([addr(), addr(), addr()]);
    await db.insert(graduations).values({
      mint: c.mint,
      curvePool: c.pool,
      pool,
      config: instant,
      signature: signature(),
      slot: ++slot,
      graduatedAt: new Date("2026-11-14T05:53:30Z"),
      sqrtPrice: "1000",
      creatorPosition,
      creatorPositionNftMint: await addr(),
      creatorPositionOwner: by.wallet,
      creatorLiquidity: "1",
      heatPosition,
      heatPositionNftMint: await addr(),
      heatLiquidity: "1",
    });
    chainHolds({});

    const got = await card(c.mint);
    expect(got.rows.map((r) => [r.key, r.flag])).toEqual([
      ["launch", "green"],
      ["holdings", "green"],
      ["liquidity", "checkered"],
      ["radar", "neutral"],
      ["creator", "neutral"],
      ["tax", "neutral"],
    ]);
    // Checkered is proven on chain, so it counts green.
    expect(got.counts).toEqual({ green: 3, yellow: 0, red: 0 });
    expect(got.facts.launch).toEqual({ mode: "instant", creation: c.createdSignature, creationBuy: "0" });
    expect(got.facts.creatorLock).toBeNull();
    expect(got.facts.keeper).toBeNull();
    expect(got.facts.tax).toEqual({ to: "heat", claimed: { amount: "450000000", at: "2026-11-13T19:01:00.000Z", signature: claim } });
    const row = Object.fromEntries(got.rows.map((r) => [r.key, r]));
    expect(row.launch!.value).toBe("Instant launch with no creator buy");
    expect(row.holdings!.value).toBe("The Creator wallet holds none of $QUICK");
    expect(row.liquidity!).toMatchObject({ value: "100% of liquidity locked forever", short: "Graduated · liquidity locked forever" });
    expect(row.liquidity!.links.map((l) => l.label)).toEqual(["The creator's position", "Heat's position", "The pool"]);
    expect(row.liquidity!.links[0]!.href).toContain(creatorPosition);
    expect(row.tax!.value).toBe("The first minute's sniper tax, 0.45\u{a0}SOL, went to Heat");
  });

  it("flags a buy in the creation transaction, which Heat's launch service never builds", async () => {
    const by = await creator(null);
    const c = await coin("BUYER", by);
    await trade(c, by.wallet, "buy", 3_000_000_000n, c.createdSignature);
    chainHolds({ [by.wallet]: [3_000_000_000n] });
    const got = await card(c.mint);
    expect(got.facts.launch).toEqual({ mode: "instant", creation: c.createdSignature, creationBuy: "3000000000" });
    expect(got.rows.find((r) => r.key === "launch")).toMatchObject({ flag: "yellow", value: "Instant launch whose creation bought 3,000 $BUYER" });
  });
});

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

describe("a coin with a finding", () => {
  it("puts its red rows first, counts them, and names the record barred", async () => {
    const by = await creator("hatdrop");
    const c = await coin("BABYWIF", by);
    const [kase] = await db
      .insert(bundleCases)
      .values({ mint: c.mint, creatorWallet: by.wallet, creatorId: by.id, status: "confirmed", linkedWallets: 3, linkedCoins: 20_000_000_000_000n, supply: 1n, evidence: pack(by.wallet), evidenceKey: "k" })
      .returning();
    await db.insert(bars).values({ caseId: kase!.id, mint: c.mint, creatorId: by.id, creatorWallet: by.wallet, confirmedBy: "op@example.com", confirmedAt: ago(4 * DAY), publishAt: ago(DAY), note: "linked" });
    chainHolds({});
    const got = await card(c.mint);
    expect(got.rows.map((r) => [r.key, r.flag])).toEqual([
      ["finding", "red"],
      ["creator", "red"],
      ["launch", "green"],
      ["holdings", "green"],
      ["liquidity", "green"],
      ["radar", "neutral"],
      ["tax", "neutral"],
    ]);
    expect(got.counts).toEqual({ green: 3, yellow: 0, red: 2 });
    expect(got.rows[0]!.links).toEqual([{ label: "Evidence on the creator's record", href: `/creator/${by.id}` }]);
    expect(got.rows[1]!.value).toBe("@hatdrop is barred from launching on Heat: 1 coin, 0 graduated");
  });
});

describe("the card's image and its absence", () => {
  it("has no card for a pool made around Heat's flow, nor for an address that is no coin", async () => {
    const c = await coin("ARND", await creator(null), { heat: false });
    expect((await request(`/coins/${c.mint}/fairness`)).status).toBe(404);
    expect((await request(`/coins/${c.mint}/card.png`)).status).toBe(404);
    expect((await request("/coins/not-a-mint/fairness")).status).toBe(404);
  });

  it("answers a coin's card as soon as the indexer has the coin, keeping no 404 from a moment before (#110)", async () => {
    // KV as the Worker binds it, in memory: the card is a public read through it.
    const kept = new Map<string, string>();
    const CACHE = {
      get: async (key: string) => (kept.has(key) ? JSON.parse(kept.get(key)!) : null),
      put: async (key: string, value: string) => void kept.set(key, value),
    };
    const throughKv = (path: string) => app.request(path, {}, testBindings(url, { BLOBS, CACHE }), ctx);
    // The coin page's server render asks a moment before the indexer has written the coin.
    const mint = await addr();
    expect((await throughKv(`/coins/${mint}/fairness`)).status).toBe(404);
    await settle();
    expect(kept.size).toBe(0);
    await coin("SOON", await creator(null), { mint });
    chainHolds({});
    expect((await throughKv(`/coins/${mint}/fairness`)).status).toBe(200);
    // A card found is kept, as before.
    await settle();
    expect([...kept.keys()]).toEqual([`fairness:v1:${mint}`]);
  });

  it("serves a version R2 keeps as it was, for good", async () => {
    const c = await coin("KEPT", await creator(null));
    chainHolds({});
    const { version } = await card(c.mint);
    const png = new TextEncoder().encode("a kept image");
    blobs.set(cardImageKey("devnet", c.mint, version), png);
    const res = await request(`/coins/${c.mint}/card.png?v=${version}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });
});
