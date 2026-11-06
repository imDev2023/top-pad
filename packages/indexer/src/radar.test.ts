import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS, COIN_SUPPLY } from "@top-pad/chain";
import { coins, createDb, fairOpens, fairOpenSeatEvents, fundingScans, indexedTransactions, jitoBundles, pools, trades, transfers, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { FundingSource } from "./funding";
import { orderKey } from "./heat";
import { CASE_FLOOR, radarOf, refreshRadar, type RadarWallet } from "./radar";

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
  for (const table of [trades, coins, pools, indexedTransactions, transfers, fundingScans, jitoBundles, fairOpens, fairOpenSeatEvents]) await db.delete(table);
});

const heat = CLUSTERS.devnet!;
const MINT = "Mint111111111111111111111111111111111111111";
const POOL = "Poo1111111111111111111111111111111111111111";
const CREATOR = "Cre8or1111111111111111111111111111111111111";
const KEEPER = heat.keys!.keeper;
const CREATION = "creation-signature";
const SLOT = 500_000;
const OPENED = new Date("2026-10-01T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(OPENED.getTime() + ms);

async function coin(launchMode: "instant" | "fair_open" = "instant", creationIndex: number | null = 10) {
  await db.insert(pools).values({
    pool: POOL,
    mint: MINT,
    config: launchMode === "instant" ? heat.configs!.instant : heat.configs!.fairOpen,
    quoteMint: "So11111111111111111111111111111111111111112",
    graduationTarget: 8_500_000_000n,
    startSqrtPrice: "35525023424642174",
    creator: CREATOR,
    name: "Radar",
    ticker: "RADAR",
    uri: "https://example.com/radar.json",
    activatedAt: OPENED,
    createdSignature: CREATION,
    createdSlot: SLOT,
    createdAt: OPENED,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    quoteReserve: 0n,
  });
  await db.insert(coins).values({
    mint: MINT,
    pool: POOL,
    config: launchMode === "instant" ? heat.configs!.instant : heat.configs!.fairOpen,
    launchMode,
    creatorWallet: CREATOR,
    name: "Radar",
    ticker: "RADAR",
    metadataUri: "https://example.com/radar.json",
    createdSignature: CREATION,
    createdSlot: SLOT,
    createdAt: OPENED,
  });
  await db.insert(indexedTransactions).values({ signature: CREATION, slot: SLOT, blockIndex: creationIndex, signers: [CREATOR, MINT, KEEPER] });
}

let n = 0;
/** A buy of `coins` raw units by `trader`, in its own transaction at `slot` and place `blockIndex`, signed by `signers`. */
async function buy(trader: string, coinsBought: bigint, o: { slot?: number; blockIndex?: number; ms?: number; signers?: string[]; signature?: string }) {
  const slot = o.slot ?? SLOT + 1_000;
  const blockIndex = o.blockIndex ?? 0;
  const signature = o.signature ?? `buy-${++n}`;
  await db.insert(indexedTransactions).values({ signature, slot, blockIndex, signers: o.signers ?? [trader] }).onConflictDoNothing();
  await db.insert(trades).values({
    signature,
    eventIndex: 0,
    slot,
    blockIndex,
    orderKey: orderKey(slot, blockIndex, 0),
    at: at(o.ms ?? 0),
    pool: POOL,
    mint: MINT,
    trader,
    side: "buy",
    quoteAmount: 10_000_000n,
    baseAmount: coinsBought,
    fee: 9_900_000n,
    sqrtPrice: heat.sqrtStartPrice.toString(),
    price: "0.000000003709",
    quoteReserve: 0n,
  });
  return signature;
}

async function transfer(source: string, destination: string, ms: number, amount = 150_000_000n) {
  await db.insert(transfers).values({ signature: `transfer-${++n}`, ordinal: 0, slot: SLOT - 10, at: at(ms), source, destination, asset: "SOL", amount: amount.toString() });
}

const byWallet = (wallets: RadarWallet[]) => Object.fromEntries(wallets.map((w) => [w.wallet, w]));

describe("Bundle Radar's labels on an Instant launch", () => {
  it("labels same-slot buys, the positions after the creation and creator links, and counts only linked wallets' first hour", async () => {
    await coin();
    // The Creator wallet buys right after its own creation: labelled, never counted (its buys are open, spec 6.5).
    await buy(CREATOR, 4_000_000_000_000n, { slot: SLOT, blockIndex: 11 });
    // A wallet the creator funded two days before the open, buying second after the creation.
    await transfer(CREATOR, "Funded1", -2 * DAY);
    await buy("Funded1", 3_000_000_000_000n, { slot: SLOT, blockIndex: 12 });
    // One that sends the creator its proceeds after the open; its first-hour buy counts, its later buy does not.
    await transfer("Funded2", CREATOR, 3 * DAY);
    await buy("Funded2", 5_000_000_000_000n, { ms: 10 * MIN });
    await buy("Funded2", 9_000_000_000_000n, { ms: 2 * 60 * MIN });
    // A buy the Creator wallet paid the fee for.
    await buy("Paid", 2_500_000_000_000n, { ms: 5 * MIN, signers: [CREATOR, "Paid"] });
    // A sniper in the creation slot, far down the block: timing only, a label.
    await buy("Sniper", 1_000_000_000_000n, { slot: SLOT, blockIndex: 40 });
    // A wallet the creator funded long before the window, and a stranger: neither is anything to Bundle Radar.
    await transfer(CREATOR, "LongAgo", -8 * DAY);
    await buy("LongAgo", 7_000_000_000_000n, { ms: MIN });
    await buy("Stranger", 7_000_000_000_000n, { ms: MIN });

    const radar = (await radarOf(db, MINT))!;
    expect(radar.wallets.map((w) => w.wallet)).toEqual(["Funded2", "Funded1", "Paid", "Cre8or1111111111111111111111111111111111111", "Sniper"]);
    const w = byWallet(radar.wallets);
    expect(w.Funded1).toMatchObject({ linked: true, labels: ["same_slot", "after_creation", "creator_funded"], counted: 3_000_000_000_000n });
    expect(w.Funded1!.buys[0]).toMatchObject({ position: 2, labels: ["same_slot", "after_creation"] });
    expect(w.Funded1!.transfers).toHaveLength(1);
    expect(w.Funded2).toMatchObject({ linked: true, labels: ["creator_funded"], counted: 5_000_000_000_000n });
    expect(w.Funded2!.buys.map((b) => b.firstHour)).toEqual([true, false]);
    expect(w.Paid).toMatchObject({ linked: true, labels: ["creator_signed"], counted: 2_500_000_000_000n });
    expect(w[CREATOR]).toMatchObject({ creator: true, linked: false, labels: ["same_slot", "after_creation"] });
    expect(w.Sniper).toMatchObject({ linked: false, labels: ["same_slot"], counted: 1_000_000_000_000n });
    expect(w.Sniper!.buys[0]!.position).toBe(30);
    expect(radar).toMatchObject({
      creatorWallet: CREATOR,
      creation: { signature: CREATION, slot: SLOT, blockIndex: 10, jitoBundle: null },
      supply: COIN_SUPPLY,
      floor: CASE_FLOOR,
      linkedWallets: 3,
      // Funded1's, Funded2's first hour and Paid's: 10.5M coins, 1.05% of supply.
      linkedCoins: 10_500_000_000_000n,
    });
  });

  it("counts every first-hour buy of a wallet linked by its position or the Creator wallet's signature, not only the linked buy", async () => {
    await coin();
    await buy("Positioned", 1_000_000_000_000n, { slot: SLOT, blockIndex: 13 });
    await buy("Positioned", 4_000_000_000_000n, { ms: 20 * MIN });
    await buy("Paid", 2_000_000_000_000n, { ms: 5 * MIN, signers: [CREATOR, "Paid"] });
    await buy("Paid", 3_000_000_000_000n, { ms: 6 * MIN });
    const w = byWallet((await radarOf(db, MINT))!.wallets);
    expect(w.Positioned).toMatchObject({ linked: true, labels: ["same_slot", "after_creation"], counted: 5_000_000_000_000n });
    expect(w.Positioned!.buys).toHaveLength(2);
    expect(w.Paid).toMatchObject({ linked: true, labels: ["creator_signed"], counted: 5_000_000_000_000n });
  });

  it("labels no position when the creation's place in its block is not known yet", async () => {
    await coin("instant", null);
    await buy("Early", 1_000_000_000_000n, { slot: SLOT, blockIndex: 11 });
    const radar = (await radarOf(db, MINT))!;
    expect(radar.wallets).toEqual([expect.objectContaining({ wallet: "Early", labels: ["same_slot"], linked: false })]);
  });

  it("is nothing for a pool our launch key never co-signed", async () => {
    expect(await radarOf(db, MINT)).toBeNull();
  });
});

describe("Bundle Radar on a Fair Open", () => {
  async function fairOpen() {
    await coin("fair_open");
    await db.insert(fairOpens).values({
      launch: "Launch1111111111111111111111111111111111111",
      creator: CREATOR,
      nonce: "Nonce11111111111111111111111111111111111111",
      dbcConfig: heat.configs!.fairOpen,
      quoteMint: heat.quote.mint,
      identityHash: "00",
      depositsOpenAt: at(-10 * MIN),
      opensAt: OPENED,
      minRaise: 100_000_000n,
      potCap: 1_700_000_000n,
      lowestRung: 85_000_000n,
      step: 10_000_000n,
      status: "opened",
      mint: MINT,
      pool: POOL,
      createdSignature: "schedule",
      createdSlot: SLOT - 2_000,
      createdAt: at(-20 * MIN),
    });
  }
  let e = 0;
  async function seat(wallet: string, kind: "deposit" | "delivery" | "lock", o: { coins?: bigint; signers?: string[] } = {}) {
    const signature = `seat-${++e}`;
    await db.insert(indexedTransactions).values({ signature, slot: SLOT - 100 + e, signers: o.signers ?? [wallet] });
    await db.insert(fairOpenSeatEvents).values({
      signature,
      eventIndex: 0,
      slot: SLOT - 100 + e,
      at: at(kind === "deposit" ? -5 * MIN : MIN),
      launch: "Launch1111111111111111111111111111111111111",
      wallet,
      person: "ab",
      kind,
      tier: kind === "deposit" ? "unverified" : null,
      amount: 100_000_000n,
      deposit: 100_000_000n,
      coins: o.coins ?? null,
    });
  }

  it("counts a linked depositor's coins from the pot toward the floor, never the creator's own seat", async () => {
    await fairOpen();
    // The creator's own seat: the Creator lock, open and locked.
    await seat(CREATOR, "deposit");
    await seat(CREATOR, "lock", { coins: 50_000_000_000_000n });
    // A depositor the creator funded the day before.
    await transfer(CREATOR, "Depositor1", -DAY);
    await seat("Depositor1", "deposit");
    await seat("Depositor1", "delivery", { coins: 6_000_000_000_000n });
    // A deposit the Creator wallet paid for.
    await seat("Depositor2", "deposit", { signers: [CREATOR, "Depositor2", heat.keys!.admission!] });
    await seat("Depositor2", "delivery", { coins: 4_000_000_000_000n });
    // A depositor with no link: nothing.
    await seat("Honest", "deposit");
    await seat("Honest", "delivery", { coins: 9_000_000_000_000n });
    // A depositor linked by its buy right after the creation: its seat counts too.
    await seat("Quick", "deposit");
    await seat("Quick", "delivery", { coins: 2_000_000_000_000n });
    await buy("Quick", 1_000_000_000n, { slot: SLOT, blockIndex: 11 });
    // And a linked buyer in the first hour, past the pot.
    await transfer(CREATOR, "Buyer", -DAY);
    await buy("Buyer", 500_000_000_000n, { ms: 20 * MIN });

    const radar = (await radarOf(db, MINT))!;
    const w = byWallet(radar.wallets);
    expect(Object.keys(w).sort()).toEqual(["Buyer", "Depositor1", "Depositor2", "Quick"]);
    expect(w.Quick).toMatchObject({ linked: true, labels: ["same_slot", "after_creation"], potCoins: 2_000_000_000_000n, counted: 2_001_000_000_000n });
    expect(w.Depositor1).toMatchObject({ linked: true, labels: ["creator_funded"], potCoins: 6_000_000_000_000n, counted: 6_000_000_000_000n });
    expect(w.Depositor1!.deposits).toHaveLength(1);
    expect(w.Depositor2).toMatchObject({ linked: true, labels: ["creator_signed"], counted: 4_000_000_000_000n });
    expect(radar.linkedCoins).toBe(12_501_000_000_000n);
    expect(radar.linkedCoins >= CASE_FLOOR).toBe(true);
  });
});

describe("bringing Bundle Radar up to date", () => {
  it("scans the Creator wallet's funding window, finds the creation's place, and records Jito bundles on mainnet", async () => {
    await coin("instant", null);
    await db.update(indexedTransactions).set({ blockIndex: null });
    const bundled = await buy("Bundled", 1_000_000_000_000n, { slot: SLOT, blockIndex: 13 });
    await buy("Later", 1_000_000_000_000n, { slot: SLOT, blockIndex: 90 });
    const scanned: string[] = [];
    const funding: FundingSource = {
      async listSignatures(account) {
        scanned.push(account);
        return [{ signature: "fund", slot: SLOT - 5, failed: false, blockTime: Math.floor(OPENED.getTime() / 1000) - 60 }];
      },
      async fetchParsed() {
        return {
          slot: SLOT - 5,
          blockTime: Math.floor(OPENED.getTime() / 1000) - 60,
          transaction: { signatures: ["fund"], message: { accountKeys: [{ pubkey: CREATOR }], instructions: [{ programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: CREATOR, destination: "Bundled", lamports: 5 } } }] } },
          meta: { err: null },
        };
      },
    };
    const jito = { bundleOf: async (signature: string) => (signature === CREATION || signature === bundled ? "bundle-1" : null) };
    expect(await refreshRadar(db, { funding, blockIndexOf: async () => 10, jito }, MINT)).toEqual({ recorded: 1, read: 1, complete: true });
    expect(scanned).toEqual([CREATOR]);
    const radar = (await radarOf(db, MINT))!;
    expect(radar.creation).toMatchObject({ blockIndex: 10, jitoBundle: "bundle-1" });
    expect(byWallet(radar.wallets).Bundled).toMatchObject({ linked: true, labels: ["same_slot", "after_creation", "jito_bundle", "creator_funded"] });
    expect(byWallet(radar.wallets).Later).toMatchObject({ linked: false, labels: ["same_slot"] });
    expect(await refreshRadar(db, { funding }, "Unknown111111111111111111111111111111111111")).toBeNull();
    // Live, the indexer leaves a buy past the first hour, and anything long past, to the case job.
    expect(await refreshRadar(db, { funding }, MINT, { boughtAt: at(61 * MIN) })).toBeNull();
    expect(await refreshRadar(db, { funding }, MINT, { recentMs: 10 * MIN })).toBeNull();
    expect(scanned).toEqual([CREATOR]);
  });
});
