import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CLUSTERS } from "@top-pad/chain";
import { bars, bundleCases, coinRadar, coins, createDb, indexedTransactions, knownBots, pools, trades, transfers, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { refreshKnownBots, summarizeMissingRadars, summarizeRadar, trendingOf } from "./board";
import { orderKey } from "./heat";

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
  for (const table of [bars, bundleCases, trades, coins, pools, indexedTransactions, coinRadar, knownBots, transfers]) await db.delete(table);
});

const heat = CLUSTERS.devnet!;
const NOW = new Date("2026-11-13T12:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SOL = "So11111111111111111111111111111111111111112";
const TARGET = 8_500_000_000n;

/** A base58-looking address unique to `name`, padded to 32 characters. */
const addr = (name: string) => `${name}${"1".repeat(Math.max(0, 43 - name.length))}`;

let slot = 1_000_000;
/** A Heat coin opened `openedAgo` before NOW (or a pool made around Heat's flow, with `heat: false`). */
async function coin(name: string, o: { openedAgo?: number; heat?: boolean; creator?: string; at?: Date } = {}) {
  const mint = addr(`M${name}`);
  const opened = o.at ?? ago(o.openedAgo ?? 30 * MIN);
  const created = { createdSignature: `create-${name}`, createdSlot: ++slot, createdAt: opened };
  const creator = o.creator ?? addr(`C${name}`);
  await db.insert(pools).values({
    pool: addr(`P${name}`),
    mint,
    config: heat.configs!.instant,
    quoteMint: SOL,
    graduationTarget: TARGET,
    startSqrtPrice: heat.sqrtStartPrice.toString(),
    creator,
    name,
    ticker: name.toUpperCase(),
    uri: `https://example.com/${name}.json`,
    activatedAt: opened,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    quoteReserve: 0n,
    ...created,
  });
  if (o.heat !== false) {
    await db.insert(coins).values({
      mint,
      pool: addr(`P${name}`),
      config: heat.configs!.instant,
      launchMode: "instant",
      creatorWallet: creator,
      name,
      ticker: name.toUpperCase(),
      metadataUri: `https://example.com/${name}.json`,
      ...created,
    });
  }
  await db.insert(indexedTransactions).values({ signature: `create-${name}`, slot: created.createdSlot, blockIndex: 0, signers: [creator] });
  return { mint, creator, opened };
}

let n = 0;
/** A swap of `amount` raw units of the coin (and as many lamports) by `trader`, at `at`, in its own transaction unless given one. */
async function swap(mint: string, trader: string, side: "buy" | "sell", at: Date, o: { amount?: bigint; quote?: bigint; signature?: string; eventIndex?: number; signers?: string[] } = {}) {
  const signature = o.signature ?? `swap-${++n}`;
  const s = ++slot;
  await db.insert(indexedTransactions).values({ signature, slot: s, blockIndex: 1, signers: o.signers ?? [trader] }).onConflictDoNothing();
  await db.insert(trades).values({
    signature,
    eventIndex: o.eventIndex ?? 0,
    slot: s,
    blockIndex: 1,
    orderKey: orderKey(s, 1, o.eventIndex ?? 0).toString(),
    at,
    pool: (await db.select({ pool: pools.pool }).from(pools).where(eq(pools.mint, mint)))[0]!.pool,
    mint,
    trader,
    side,
    quoteAmount: o.quote ?? 10_000_000n,
    baseAmount: o.amount ?? 1_000_000n,
    fee: 0n,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    price: "0.000000028",
    quoteReserve: 0n,
  });
}

const buyers = (k: number, prefix: string) => Array.from({ length: k }, (_, i) => addr(`${prefix}${i}`));
const ranked = async () => (await trendingOf(db, { now: NOW })).map((t) => t.mint);

describe("Trending", () => {
  it("ranks coins by their unique net buyers of the last hour, not by volume", async () => {
    const a = await coin("alpha");
    const b = await coin("bravo");
    const c = await coin("charlie");
    for (const w of buyers(5, "a")) await swap(a.mint, w, "buy", ago(5 * MIN));
    for (const w of buyers(3, "b")) await swap(b.mint, w, "buy", ago(5 * MIN));
    // One whale buying a hundred times as much counts once.
    await swap(c.mint, addr("whale"), "buy", ago(5 * MIN), { amount: 100_000_000n, quote: 5_000_000_000n });
    const trending = await trendingOf(db, { now: NOW });
    expect(trending.map((t) => t.mint)).toEqual([a.mint, b.mint, c.mint]);
    expect(trending.map((t) => t.buyers)).toEqual([5, 3, 1]);
  });

  it("decays each buyer by the age of their latest buy, and forgets buys older than an hour", async () => {
    const fresh = await coin("fresh");
    const stale = await coin("stale", { openedAgo: 3 * 60 * MIN });
    const old = await coin("old", { openedAgo: 3 * 60 * MIN });
    for (const w of buyers(3, "f")) await swap(fresh.mint, w, "buy", ago(1 * MIN));
    // Four buyers 50 minutes ago weigh less than three a minute ago (a half-life of 20 minutes).
    for (const w of buyers(4, "s")) await swap(stale.mint, w, "buy", ago(50 * MIN));
    for (const w of buyers(9, "o")) await swap(old.mint, w, "buy", ago(61 * MIN));
    const trending = await trendingOf(db, { now: NOW });
    expect(trending.map((t) => t.mint)).toEqual([fresh.mint, stale.mint]);
    expect(trending[1]!.buyers).toBe(4);
    expect(trending[1]!.score).toBeCloseTo(4 * 0.5 ** 2.5, 6);
  });

  it("counts only net buyers: a wallet that sold all it bought, or more, is not one", async () => {
    const a = await coin("net");
    await swap(a.mint, addr("keeps"), "buy", ago(10 * MIN), { amount: 1_000n });
    await swap(a.mint, addr("flips"), "buy", ago(10 * MIN), { amount: 1_000n });
    await swap(a.mint, addr("flips"), "sell", ago(9 * MIN), { amount: 1_000n });
    await swap(a.mint, addr("dumps"), "sell", ago(9 * MIN), { amount: 5_000n });
    expect((await trendingOf(db, { now: NOW }))[0]!.buyers).toBe(1);
  });

  it("breaks ties on buy volume capped at 1% of the Graduation Target a wallet", async () => {
    const whale = await coin("whale");
    const spread = await coin("spread");
    const at = ago(5 * MIN);
    // Same buyers at the same moment: the whale's 10 SOL counts as 0.085, below the two 0.06 SOL buys.
    await swap(whale.mint, addr("w1"), "buy", at, { quote: 10_000_000_000n });
    await swap(whale.mint, addr("w2"), "buy", at, { quote: 1_000_000n });
    await swap(spread.mint, addr("s1"), "buy", at, { quote: 60_000_000n });
    await swap(spread.mint, addr("s2"), "buy", at, { quote: 60_000_000n });
    const trending = await trendingOf(db, { now: NOW });
    expect(trending.map((t) => t.mint)).toEqual([spread.mint, whale.mint]);
    expect(trending[1]!.volume).toBeCloseTo(0.01 + 1_000_000 / Number(TARGET), 9);
  });

  it("never counts the creator, wallets Bundle Radar ties to the creator, or a trade the creator signed", async () => {
    const a = await coin("tied");
    const b = await coin("clean");
    for (const w of buyers(2, "c")) await swap(b.mint, w, "buy", ago(5 * MIN));
    await swap(a.mint, a.creator, "buy", ago(5 * MIN));
    // Funded by the Creator wallet the day before the open: a direct link.
    const funded = addr("funded");
    await db.insert(transfers).values({ signature: "fund-1", ordinal: 0, slot: 1, at: new Date(a.opened.getTime() - 24 * 60 * MIN), source: a.creator, destination: funded, asset: "SOL", amount: "1000000000" });
    await swap(a.mint, funded, "buy", ago(5 * MIN));
    // Paid for by the Creator wallet.
    await swap(a.mint, addr("sponsored"), "buy", ago(5 * MIN), { signers: [a.creator, addr("sponsored")] });
    await swap(a.mint, addr("honest"), "buy", ago(5 * MIN));
    // Before Bundle Radar's summary is written, only the creator and its signed trade are left out.
    expect((await trendingOf(db, { now: NOW })).find((t) => t.mint === a.mint)!.buyers).toBe(2);
    await summarizeRadar(db, a.mint);
    expect((await db.select().from(coinRadar).where(eq(coinRadar.mint, a.mint)))[0]!.linkedWallets.sort()).toEqual([funded, addr("sponsored")].sort());
    const trending = await trendingOf(db, { now: NOW });
    expect(trending.map((t) => [t.mint, t.buyers])).toEqual([
      [b.mint, 2],
      [a.mint, 1],
    ]);
  });

  it("never counts a buy and sell inside one transaction, nor a wallet on the known-bot list until an operator removes it", async () => {
    const a = await coin("bots");
    await swap(a.mint, addr("looper"), "buy", ago(5 * MIN), { signature: "loop", eventIndex: 0, amount: 2_000n });
    await swap(a.mint, addr("looper"), "sell", ago(5 * MIN), { signature: "loop", eventIndex: 1, amount: 1_000n });
    await swap(a.mint, addr("listed"), "buy", ago(5 * MIN));
    await swap(a.mint, addr("person"), "buy", ago(5 * MIN));
    await db.insert(knownBots).values({ wallet: addr("listed"), earlyLaunches: 3, roundTrips: 0, evidence: {} });
    expect((await trendingOf(db, { now: NOW }))[0]!.buyers).toBe(1);
    await db.update(knownBots).set({ removedAt: NOW, removedBy: "operator@example.com", removedNote: "a person" }).where(eq(knownBots.wallet, addr("listed")));
    expect((await trendingOf(db, { now: NOW }))[0]!.buyers).toBe(2);
  });

  it("lists only Heat coins: a pool made around Heat's flow never trends", async () => {
    const around = await coin("around", { heat: false });
    for (const w of buyers(4, "x")) await swap(around.mint, w, "buy", ago(5 * MIN));
    expect(await ranked()).toEqual([]);
  });

  it("leaves out a coin with a published confirmed creator bundle, and only once it is published and while it stands", async () => {
    const a = await coin("bundled");
    for (const w of buyers(2, "y")) await swap(a.mint, w, "buy", ago(5 * MIN));
    const [kase] = await db
      .insert(bundleCases)
      .values({ mint: a.mint, creatorWallet: a.creator, status: "confirmed", linkedWallets: 2, linkedCoins: 1n, supply: 1n, evidence: {}, evidenceKey: "k" })
      .returning();
    // Inside its 72-hour private window, the coin still ranks: the finding is the creator's alone.
    const [bar] = await db
      .insert(bars)
      .values({ caseId: kase!.id, mint: a.mint, creatorWallet: a.creator, confirmedBy: "op", publishAt: new Date(NOW.getTime() + 60 * MIN), note: "n" })
      .returning();
    expect(await ranked()).toEqual([a.mint]);
    await db.update(bars).set({ publishAt: ago(1) }).where(eq(bars.id, bar!.id));
    expect(await ranked()).toEqual([]);
    await db.update(bars).set({ liftedAt: NOW, liftedBy: "op2" }).where(eq(bars.id, bar!.id));
    expect(await ranked()).toEqual([a.mint]);
  });
});

describe("radar summaries", () => {
  it("backfills the summary of each Heat coin without one, and no pool made around Heat's flow", async () => {
    const a = await coin("first");
    const b = await coin("second");
    await coin("outside", { heat: false });
    await summarizeRadar(db, a.mint);
    expect(await summarizeMissingRadars(db)).toEqual({ summarized: 1 });
    expect((await db.select({ mint: coinRadar.mint }).from(coinRadar)).map((r) => r.mint).sort()).toEqual([a.mint, b.mint].sort());
    expect(await summarizeMissingRadars(db)).toEqual({ summarized: 0 });
  });
});

describe("the known-bot list", () => {
  it("lists a wallet that bought in the first 2 seconds of 3 launches, and not one that did so twice", async () => {
    const launches = [await coin("one"), await coin("two"), await coin("three")];
    const sniper = addr("sniper");
    const twice = addr("twice");
    for (const [i, l] of launches.entries()) {
      await swap(l.mint, sniper, "buy", new Date(l.opened.getTime() + (i === 2 ? 1_000 : 0)));
      // A second copy of the snipe in the same launch: still one launch, one piece of evidence.
      await swap(l.mint, sniper, "buy", new Date(l.opened.getTime() + 1_000));
      if (i < 2) await swap(l.mint, twice, "buy", new Date(l.opened.getTime() + 1_000));
      // Two seconds after the open is the third second: not "the first 2 seconds".
      await swap(l.mint, addr("late"), "buy", new Date(l.opened.getTime() + 2_000));
    }
    const { listed } = await refreshKnownBots(db, NOW);
    expect(listed).toEqual([sniper]);
    const [row] = await db.select().from(knownBots).where(eq(knownBots.wallet, sniper));
    expect(row!.earlyLaunches).toBe(3);
    expect((row!.evidence as { early: { mint: string }[] }).early.map((e) => e.mint).sort()).toEqual(launches.map((l) => l.mint).sort());
    // Running again finds nothing new.
    expect(await refreshKnownBots(db, NOW)).toEqual({ listed: [], updated: 0 });
  });

  it("never counts the pot's own buy in a Fair Open's creation, nor a pool made around Heat's flow", async () => {
    const keeper = heat.keys!.keeper;
    for (const name of ["p1", "p2", "p3"]) {
      const l = await coin(name);
      await swap(l.mint, keeper, "buy", l.opened, { signature: `create-${name}` });
    }
    const arounds = [await coin("a1", { heat: false }), await coin("a2", { heat: false })];
    const l = await coin("p4");
    for (const p of [...arounds, l]) await swap(p.mint, addr("aroundSniper"), "buy", p.opened);
    expect((await refreshKnownBots(db, NOW)).listed).toEqual([]);
  });

  it("lists a wallet that bought and sold inside one transaction", async () => {
    const a = await coin("trip");
    await swap(a.mint, addr("tripper"), "buy", ago(MIN), { signature: "trip-1", eventIndex: 0 });
    await swap(a.mint, addr("tripper"), "sell", ago(MIN), { signature: "trip-1", eventIndex: 1 });
    // A buy and a later sell in another transaction is trading, not a round trip.
    await swap(a.mint, addr("trader"), "buy", ago(2 * MIN));
    await swap(a.mint, addr("trader"), "sell", ago(MIN));
    expect((await refreshKnownBots(db, NOW)).listed).toEqual([addr("tripper")]);
    const [row] = await db.select().from(knownBots).where(eq(knownBots.wallet, addr("tripper")));
    expect(row).toMatchObject({ earlyLaunches: 0, roundTrips: 1, evidence: { early: [], roundTrips: ["trip-1"] } });
  });

  it("keeps a removed wallet removed when it is found again, its counts still rising", async () => {
    const a = await coin("again");
    await swap(a.mint, addr("removed"), "buy", ago(2 * MIN), { signature: "r-1", eventIndex: 0 });
    await swap(a.mint, addr("removed"), "sell", ago(2 * MIN), { signature: "r-1", eventIndex: 1 });
    await refreshKnownBots(db, NOW);
    await db.update(knownBots).set({ removedAt: NOW, removedBy: "op", removedNote: "market maker" }).where(eq(knownBots.wallet, addr("removed")));
    await swap(a.mint, addr("removed"), "buy", ago(MIN), { signature: "r-2", eventIndex: 0 });
    await swap(a.mint, addr("removed"), "sell", ago(MIN), { signature: "r-2", eventIndex: 1 });
    expect(await refreshKnownBots(db, NOW)).toEqual({ listed: [], updated: 1 });
    const [row] = await db.select().from(knownBots).where(eq(knownBots.wallet, addr("removed")));
    expect(row).toMatchObject({ roundTrips: 2, removedBy: "op" });
    expect(row!.removedAt).not.toBeNull();
  });
});
