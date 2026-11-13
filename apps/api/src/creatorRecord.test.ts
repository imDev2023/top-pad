import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DEVNET_USDC, WSOL_MINT } from "@top-pad/chain";
import { Coin, CreatorRecord } from "@top-pad/contract";
import {
  bundleCases,
  coins,
  creators,
  creatorWallets,
  createDb,
  fairOpens,
  feeClaims,
  graduations,
  lpFeeClaims,
  poolCreatorTransfers,
  pools,
  trades,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { orderKey } from "@top-pad/indexer";
import { eq } from "drizzle-orm";
import { app } from "./index";
import { Fakes, testBindings, testContext } from "./test/fakes";

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
const request = (path: string) => app.request(path, {}, testBindings(url), ctx);
const record = async (key: string) => {
  const res = await request(`/creators/${key}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return CreatorRecord.parse(await res.json());
};

const { instant, fairOpen } = CLUSTERS.devnet!.configs!;
const DAY = 24 * 3600_000;
const T0 = Date.now() - 30 * DAY;
const at = (days: number) => new Date(T0 + days * DAY);
const addr = async () => (await generateKeyPairSigner()).address as string;
/** A distinct transaction signature for each row. */
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));

async function coin(o: { creatorId: string | null; wallet: string; mode: "instant" | "fair_open"; createdAt: Date; slot: number; name: string }) {
  const [mint, pool] = await Promise.all([addr(), addr()]);
  const created = signature();
  await db.insert(pools).values({
    pool,
    mint,
    config: o.mode === "instant" ? instant : fairOpen,
    creator: o.wallet,
    quoteMint: WSOL_MINT,
    graduationTarget: 8_500_000_000n,
    startSqrtPrice: "1000",
    name: o.name,
    ticker: o.name.slice(0, 4).toUpperCase(),
    uri: "https://turbo-gateway.com/x",
    activatedAt: o.createdAt,
    createdSignature: created,
    createdSlot: o.slot,
    createdAt: o.createdAt,
    sqrtPrice: "1000",
    quoteReserve: 0n,
  });
  await db.insert(coins).values({
    mint,
    pool,
    config: o.mode === "instant" ? instant : fairOpen,
    launchMode: o.mode,
    creatorId: o.creatorId,
    creatorWallet: o.wallet,
    name: o.name,
    ticker: o.name.slice(0, 4).toUpperCase(),
    metadataUri: "https://turbo-gateway.com/x",
    imageUri: null,
    createdSignature: created,
    createdSlot: o.slot,
    createdAt: o.createdAt,
  });
  return { mint, pool };
}

let tradeIndex = 0;
async function trade(c: { mint: string; pool: string }, trader: string, side: "buy" | "sell", baseAmount: bigint, quoteAmount: bigint, when: Date, slot = 1_000 + tradeIndex) {
  tradeIndex++;
  await db.insert(trades).values({
    signature: signature(),
    eventIndex: 0,
    slot,
    blockIndex: 1,
    orderKey: orderKey(slot, 1, 0),
    at: when,
    pool: c.pool,
    mint: c.mint,
    trader,
    side,
    quoteAmount,
    baseAmount,
    fee: quoteAmount / 80n,
    sqrtPrice: "1000",
    price: "0.000000001",
    quoteReserve: 1n,
  });
}

const transfer = (pool: string, from: string, to: string, when: Date, slot: number) =>
  db.insert(poolCreatorTransfers).values({ signature: signature(), eventIndex: 0, slot, at: when, pool, fromWallet: from, toWallet: to });

describe("a Creator record", () => {
  it("lists every fact from the indexed rows, a coin handed over on both records, and the summary the coin page reuses", async () => {
    const [a, b, x, y, other] = await Promise.all([addr(), addr(), addr(), addr(), addr()]);
    const [r] = await db.insert(creators).values({ xUserId: "77", xHandle: "lumen_lab", xName: "Lumen Lab", createdAt: at(0) }).returning();
    const [s] = await db.insert(creators).values({ createdAt: at(0) }).returning();
    // R: A from day 0, handed over to B on day 20. S: X throughout.
    await db.insert(creatorWallets).values([
      { creatorId: r!.id, wallet: a, via: "sign_in", proof: "proof-a", proofMessage: "message-a", startedAt: at(0), endedAt: at(20) },
      { creatorId: r!.id, wallet: b, via: "handover", proof: "proof-b", proofMessage: "message-b", startedAt: at(20) },
      { creatorId: s!.id, wallet: x, via: "sign_in", proof: "proof-x", proofMessage: "message-x", startedAt: at(0) },
    ]);

    // R's coins: an Instant one, graduated, its role handed to S's wallet; a Fair Open, quiet, its role moved to R's own new
    // wallet; and one A made outside the launch service while it was R's Creator wallet. A coin A made after its tenure is not R's.
    const graduated = await coin({ creatorId: r!.id, wallet: a, mode: "instant", createdAt: at(1), slot: 100, name: "Graduate" });
    const quiet = await coin({ creatorId: r!.id, wallet: a, mode: "fair_open", createdAt: at(2), slot: 200, name: "Quietus" });
    const outside = await coin({ creatorId: null, wallet: a, mode: "instant", createdAt: at(3), slot: 300, name: "Outsider" });
    await coin({ creatorId: null, wallet: a, mode: "instant", createdAt: at(25), slot: 400, name: "Later" });
    // S's coin, its role handed to R's wallet B.
    const received = await coin({ creatorId: s!.id, wallet: x, mode: "instant", createdAt: at(4), slot: 500, name: "Gift" });

    await db.insert(graduations).values({
      mint: graduated.mint,
      curvePool: graduated.pool,
      pool: await addr(),
      config: instant,
      signature: signature(),
      slot: 150,
      graduatedAt: at(10),
      sqrtPrice: "1000",
      creatorPosition: await addr(),
      creatorPositionNftMint: await addr(),
      creatorPositionOwner: a,
      creatorLiquidity: "1",
      heatPosition: await addr(),
      heatPositionNftMint: await addr(),
      heatLiquidity: "1",
    });
    await db.insert(fairOpens).values([
      {
        launch: await addr(),
        creator: a,
        nonce: await addr(),
        dbcConfig: fairOpen,
        quoteMint: WSOL_MINT,
        identityHash: "00".repeat(32),
        depositsOpenAt: at(1.9),
        opensAt: at(2),
        minRaise: 1n,
        potCap: 10n,
        lowestRung: 1n,
        step: 1n,
        status: "closed",
        mint: quiet.mint,
        pool: quiet.pool,
        lockEscrow: await addr(),
        lockCoins: 5_000_000n,
        lockCliffAt: at(32),
        lockEndsAt: at(92),
        lockedAt: at(2),
        createdSignature: signature(),
        createdSlot: 190,
        createdAt: at(1.9),
      },
      ...(await Promise.all(
        (["failed", "scheduled"] as const).map(async (kind, i) => ({
          launch: await addr(),
          creator: kind === "failed" ? a : b,
          nonce: await addr(),
          dbcConfig: fairOpen,
          quoteMint: WSOL_MINT,
          identityHash: "00".repeat(32),
          depositsOpenAt: at(21 + i),
          opensAt: at(40),
          minRaise: 1n,
          potCap: 10n,
          lowestRung: 1n,
          step: 1n,
          status: kind === "failed" ? ("closed" as const) : ("scheduled" as const),
          failure: kind === "failed" ? ("min_raise_missed" as const) : null,
          createdSignature: signature(),
          createdSlot: 600 + i,
          createdAt: kind === "failed" ? at(5) : at(21),
        })),
      )),
    ]);

    // Trades: the Creator wallets' sells (A's and B's), a buy, another wallet's same-slot buy that Bundle Radar labels.
    await trade(graduated, a, "buy", 10_000_000n, 1_000_000n, at(1), 100);
    await trade(graduated, y, "buy", 3_000_000n, 300_000n, at(1), 100);
    await trade(graduated, a, "sell", 4_000_000n, 500_000n, at(5));
    await trade(graduated, b, "sell", 1_000_000n, 120_000n, at(21));
    await trade(graduated, other, "sell", 2_000_000n, 200_000n, at(29));
    await trade(quiet, other, "buy", 1_000_000n, 100_000n, at(8));
    await trade(outside, other, "buy", 1_000_000n, 100_000n, at(29));

    await transfer(graduated.pool, a, x, at(12), 700);
    await transfer(quiet.pool, a, b, at(21), 800);
    await transfer(received.pool, x, b, at(22), 900);

    // Creator Earnings claimed: to A and to B on curve fees, to A on LP fees.
    await db.insert(feeClaims).values([
      { signature: signature(), eventIndex: 0, slot: 1, at: at(9), pool: graduated.pool, mint: graduated.mint, creator: a, creatorAmount: 100n, treasuryAmount: 100n },
      { signature: signature(), eventIndex: 0, slot: 2, at: at(23), pool: received.pool, mint: received.mint, creator: b, creatorAmount: 50n, treasuryAmount: 50n },
      { signature: signature(), eventIndex: 0, slot: 3, at: at(23), pool: received.pool, mint: received.mint, creator: x, creatorAmount: 9n, treasuryAmount: 9n },
    ]);
    await db.insert(lpFeeClaims).values({
      signature: signature(),
      eventIndex: 0,
      slot: 4,
      at: at(11),
      pool: await addr(),
      mint: graduated.mint,
      position: await addr(),
      owner: a,
      quoteAmount: 7n,
      coinAmount: 0n,
    });

    const shown = await record(r!.id);
    expect(shown.summary).toEqual({
      id: r!.id,
      wallet: b,
      x: { handle: "lumen_lab", name: "Lumen Lab", avatarUrl: null },
      coins: 3,
      graduations: 1,
      graduationRate: 1 / 3,
      lastGraduatedAt: at(10).toISOString(),
      handedOver: 1,
      quiet: 1,
      marks: { verifiedCreator: true, verifiedHuman: false },
      barred: null,
      since: at(0).toISOString(),
    });
    expect(shown.launches).toEqual({ instant: 2, fairOpen: { opened: 1, failed: 1, scheduled: 1 } });
    expect(shown.wallets.map((w) => [w.wallet, w.via, w.from, w.until])).toEqual([
      [a, "sign_in", at(0).toISOString(), at(20).toISOString()],
      [b, "handover", at(20).toISOString(), null],
    ]);
    expect(shown.coins.map((c) => [c.name, c.launchMode, c.state])).toEqual([
      ["Outsider", "instant", "trading"],
      ["Quietus", "fair_open", "quiet"],
      ["Graduate", "instant", "graduated"],
    ]);
    const [out, still, grad] = shown.coins;
    expect(grad).toMatchObject({
      graduatedAt: at(10).toISOString(),
      lastTradeAt: at(29).toISOString(),
      lock: null,
      sells: { count: 2, coins: "5000000", quote: "620000" },
      role: { holder: x, handedOver: true, record: { id: s!.id, handle: null, wallet: x }, at: at(12).toISOString() },
      radar: { linked: 0, labelled: 1 },
    });
    expect(still).toMatchObject({
      lastTradeAt: at(8).toISOString(),
      lock: { status: "locked", coins: "5000000", cliffAt: at(32).toISOString(), endsAt: at(92).toISOString() },
      sells: { count: 0, coins: "0", quote: "0" },
      // Moved to the record's own new wallet: not handed over.
      role: { holder: b, handedOver: false, record: null, at: at(21).toISOString() },
    });
    expect(out).toMatchObject({ role: { holder: a, handedOver: false, record: null, at: null, explorer: null } });
    expect(shown.received).toEqual([
      expect.objectContaining({ mint: received.mint, name: "Gift", launcher: { id: s!.id, handle: null, wallet: x }, holder: b, at: at(22).toISOString() }),
    ]);
    expect(shown.earnings).toEqual([{ quote: expect.objectContaining({ mint: WSOL_MINT, symbol: "SOL" }), claimed: "157", curve: "150", lp: "7" }]);

    // The launcher's other side: S's record keeps its coin, handed over to R.
    const theirs = await record(x);
    expect(theirs.summary).toMatchObject({ id: s!.id, coins: 1, handedOver: 1, graduations: 0, marks: { verifiedCreator: false } });
    expect(theirs.coins[0]).toMatchObject({ name: "Gift", role: { holder: b, handedOver: true, record: { id: r!.id, handle: "lumen_lab", wallet: b } } });
    // And R's graduated coin, whose role R handed to S's wallet, shows on S's record as handed over to it, by R.
    expect(theirs.received).toEqual([
      expect.objectContaining({ mint: graduated.mint, launcher: { id: r!.id, handle: "lumen_lab", wallet: b }, holder: x, at: at(12).toISOString() }),
    ]);

    // The coin page carries the same summary.
    vi.stubGlobal("fetch", new Fakes().fetch);
    const page = Coin.parse(await (await request(`/coins/${graduated.mint}`)).json());
    expect(page.record).toEqual(shown.summary);
    // One made outside the launch service finds its record by the wallet's tenure.
    expect(Coin.parse(await (await request(`/coins/${outside.mint}`)).json()).record?.id).toBe(r!.id);

    // An open bundling case on any of its coins takes the verified-creator mark away.
    await db.insert(bundleCases).values({
      mint: outside.mint,
      creatorWallet: a,
      creatorId: null,
      linkedWallets: 1,
      linkedCoins: 1n,
      supply: 1n,
      evidence: {},
      evidenceKey: "k",
    });
    expect((await record(r!.id)).summary.marks.verifiedCreator).toBe(false);
  });

  it("counts what claims paid in each coin's own quote, SOL first (#99)", async () => {
    vi.stubGlobal("fetch", new Fakes().fetch);
    const wallet = await addr();
    const [r] = await db.insert(creators).values({ createdAt: at(0) }).returning();
    await db.insert(creatorWallets).values({ creatorId: r!.id, wallet, via: "sign_in", proof: "proof", proofMessage: "message", startedAt: at(0) });
    const dollar = await coin({ creatorId: r!.id, wallet, mode: "instant", createdAt: at(1), slot: 100, name: "Dollar" });
    await db.update(pools).set({ quoteMint: DEVNET_USDC }).where(eq(pools.pool, dollar.pool));
    await db.insert(feeClaims).values({ signature: signature(), eventIndex: 0, slot: 1, at: at(2), pool: dollar.pool, mint: dollar.mint, creator: wallet, creatorAmount: 45_000n, treasuryAmount: 45_000n });
    const shown = await record(r!.id);
    expect(shown.earnings).toEqual([
      { quote: expect.objectContaining({ symbol: "SOL" }), claimed: "0", curve: "0", lp: "0" },
      { quote: expect.objectContaining({ mint: DEVNET_USDC, symbol: "USDC", decimals: 6 }), claimed: "45000", curve: "45000", lp: "0" },
    ]);
  });

  it("answers 404 for a key with no record, and finds a record by any wallet it ever had", async () => {
    expect((await request(`/creators/${await addr()}`)).status).toBe(404);
    expect((await request("/creators/not-a-key")).status).toBe(404);
    expect((await request("/creators/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
