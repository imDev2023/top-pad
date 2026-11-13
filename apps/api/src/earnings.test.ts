import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DEVNET_USDC, FEE_PROGRAM_ADDRESS, positionAddresses, quoteAccount, TOKEN_PROGRAM_ADDRESS, WSOL_MINT } from "@top-pad/chain";
import {
  getPoolDecoder,
  getPoolEncoder,
  getPoolSize,
  getPositionDecoder,
  getPositionEncoder,
  getPositionSize,
  POOL_DISCRIMINATOR,
  POSITION_DISCRIMINATOR,
} from "@top-pad/clients/damm-v2";
import { CLAIM_FEES_DISCRIMINATOR, findCoinRecordPda } from "@top-pad/clients/fee";
import { ClaimOutcome, CreatorEarnings, PreparedClaim } from "@top-pad/contract";
import { coins, createDb, feeClaims, graduations, lpFeeClaims, pools, quoteConfigPairs, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { forgetHeatConfigs, type RawTransaction } from "@top-pad/indexer";
import { app } from "./index";
import { forgetQuotes } from "./quotes";
import { coinRecord, dbcPool, decode, Fakes, ORIGINS, seedQuoteSettings, splMintAccount, testBindings, testContext } from "./test/fakes";
import type { Bindings } from "./env";

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

const devnet = CLUSTERS.devnet!;
const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const WALLET = random();

let fakes: Fakes;
let indexedNow: string[];
beforeEach(async () => {
  fakes = new Fakes();
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
  forgetHeatConfigs();
  forgetQuotes();
  await db.delete(coins);
  await db.delete(pools);
  await db.delete(feeClaims);
  await db.delete(lpFeeClaims);
  await db.delete(graduations);
  await db.delete(quoteConfigPairs);
});

// Devnet USDC's pair as the band job named it on 2026-11-06 (#90): a coin on its Instant config is priced in USDC.
const USDC_INSTANT = "9aibHAP7PyCc5LKgEznkED7BteFbd7hrLiJehMWeFav6" as Address;
const USDC_FAIR_OPEN = "2tD6tB8HTbrhgaRbFfWXDDCZiZbyoHiniYhmCUGNmDSA" as Address;
/** USDC's mint and pair on the chain and in `quote_config_pairs`, as the band job leaves them. */
async function listUsdc() {
  fakes.accounts.set(DEVNET_USDC, splMintAccount(6));
  await seedQuoteSettings(fakes, devnet, { quoteMint: DEVNET_USDC, fairOpenConfig: USDC_FAIR_OPEN, instantConfig: USDC_INSTANT, step: 99_980n, graduationTarget: 84_983_000n });
  await db.insert(quoteConfigPairs).values({ fairOpenConfig: USDC_FAIR_OPEN, instantConfig: USDC_INSTANT, quoteMint: DEVNET_USDC, graduationTarget: 84_983_000n, step: 99_980n, origin: "made" });
}
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = {
  idFromName: () => "indexer",
  get: () => ({ indexNow: async (signatures: string[]) => void indexedNow.push(...signatures) }),
} as unknown as Bindings["INDEXER"];
const request = (path: string, init: RequestInit = {}) => app.request(path, init, testBindings(url, { INDEXER: indexer }), ctx);
const post = (path: string, body: unknown) =>
  request(path, { method: "POST", headers: { origin: ORIGINS.web, "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * A pool on Heat's Instant config, SOL's or USDC's, with its creator role held by `creator`, as the indexer has it, and
 * its coin, listed or not.
 */
async function coin(o: { creator: Address; partnerQuoteFee: bigint; record: "window claimed" | "window open" | "none"; name: string; quote?: "SOL" | "USDC" }) {
  const mint = random();
  const pool = random();
  const usdc = o.quote === "USDC";
  const config = usdc ? USDC_INSTANT : devnet.configs!.instant;
  fakes.accounts.set(pool, dbcPool({ config, creator: o.creator, mint, baseVault: random(), quoteVault: random(), partnerQuoteFee: o.partnerQuoteFee, activationPoint: 1_793_306_000n }));
  await db.insert(pools).values({
    pool,
    mint,
    config,
    creator: o.creator,
    quoteMint: usdc ? DEVNET_USDC : WSOL_MINT,
    graduationTarget: usdc ? 84_983_000n : 8_500_000_000n,
    startSqrtPrice: "1000",
    name: o.name,
    ticker: o.name.toUpperCase(),
    uri: `https://turbo-gateway.com/${o.name}`,
    activatedAt: new Date(),
    createdSignature: `created-${mint}`,
    createdSlot: 1,
    createdAt: new Date(),
    sqrtPrice: "1000",
    quoteReserve: 0n,
  });
  if (o.record !== "none") {
    fakes.accounts.set((await findCoinRecordPda({ mint }))[0], coinRecord({ mint, pool, windowClaimed: o.record === "window claimed" }));
    await db.insert(coins).values({
      mint,
      pool,
      config,
      launchMode: "instant",
      creatorWallet: o.creator,
      name: o.name,
      ticker: o.name.toUpperCase(),
      metadataUri: `https://turbo-gateway.com/${o.name}`,
      imageUri: `https://turbo-gateway.com/${o.name}.png`,
      createdSignature: `created-${mint}`,
      createdSlot: 1,
      createdAt: new Date(),
    });
  }
  return { mint, pool };
}

describe("a wallet's Creator Earnings", () => {
  it("lists every Heat coin whose creator role it holds, with half of each one's partner fees once its window claim has run", async () => {
    const claimed = await coin({ creator: WALLET, partnerQuoteFee: 1_001n, record: "window claimed", name: "ember" });
    const open = await coin({ creator: WALLET, partnerQuoteFee: 9_000n, record: "window open", name: "spark" });
    await coin({ creator: WALLET, partnerQuoteFee: 777n, record: "none", name: "around" });
    await coin({ creator: random(), partnerQuoteFee: 5_000n, record: "window claimed", name: "theirs" });
    await db.insert(feeClaims).values({ signature: "earlier", eventIndex: 0, slot: 1, at: new Date(), pool: claimed.pool, mint: claimed.mint, creator: WALLET, creatorAmount: 300n, treasuryAmount: 300n });

    const res = await request(`/earnings/${WALLET}`);
    expect(res.status).toBe(200);
    const earnings = CreatorEarnings.parse(await res.json());
    expect(earnings.quotes).toHaveLength(1);
    const [sol] = earnings.quotes;
    expect(sol!.quote).toMatchObject({ mint: WSOL_MINT, symbol: "SOL", decimals: 9, multiplier: 1 });
    expect(sol!.coins).toEqual([
      expect.objectContaining({ mint: claimed.mint, name: "ember", partnerFees: "1001", waiting: "500", windowClaimed: true, claimed: "300" }),
      // Until its window claim has run, what the pool holds may be its Tax window's, which never reaches the creator.
      expect.objectContaining({ mint: open.mint, partnerFees: "0", waiting: "0", windowClaimed: false, claimed: "0" }),
    ]);
    expect([sol!.waiting, sol!.claimed]).toEqual(["500", "300"]);
  });

  it("answers SOL alone, at nothing, for a wallet with no coin", async () => {
    const earnings = CreatorEarnings.parse(await (await request(`/earnings/${random()}`)).json());
    expect(earnings.quotes).toEqual([expect.objectContaining({ quote: expect.objectContaining({ symbol: "SOL" }), coins: [], waiting: "0", claimed: "0" })]);
  });

  it("groups the coins by quote, each amount in its own quote, SOL first (#99)", async () => {
    await listUsdc();
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 4_000n, record: "window claimed", name: "ember" });
    const dollar = await coin({ creator: WALLET, partnerQuoteFee: 90_000n, record: "window claimed", name: "dollar", quote: "USDC" });
    const cent = await coin({ creator: WALLET, partnerQuoteFee: 10_000n, record: "window claimed", name: "cent", quote: "USDC" });
    await db.insert(feeClaims).values({ signature: "earlier", eventIndex: 0, slot: 1, at: new Date(), pool: cent.pool, mint: cent.mint, creator: WALLET, creatorAmount: 2_500n, treasuryAmount: 2_500n });

    const earnings = CreatorEarnings.parse(await (await request(`/earnings/${WALLET}`)).json());
    expect(earnings.quotes.map((q) => q.quote.symbol)).toEqual(["SOL", "USDC"]);
    const [sol, usdc] = earnings.quotes;
    expect(sol).toMatchObject({ coins: [expect.objectContaining({ mint: ember.mint, waiting: "2000" })], waiting: "2000", claimed: "0" });
    expect(usdc!.quote).toMatchObject({ mint: DEVNET_USDC, decimals: 6, multiplier: 1 });
    expect(usdc).toMatchObject({
      coins: [expect.objectContaining({ mint: dollar.mint, waiting: "45000", claimed: "0" }), expect.objectContaining({ mint: cent.mint, waiting: "5000", claimed: "2500" })],
      waiting: "50000",
      claimed: "2500",
    });
  });

  it("keeps what a quote's claims paid after its coins were handed over", async () => {
    await listUsdc();
    const gone = await coin({ creator: random(), partnerQuoteFee: 10_000n, record: "window claimed", name: "gone", quote: "USDC" });
    await db.insert(feeClaims).values({ signature: "before", eventIndex: 0, slot: 1, at: new Date(), pool: gone.pool, mint: gone.mint, creator: WALLET, creatorAmount: 700n, treasuryAmount: 700n });
    const earnings = CreatorEarnings.parse(await (await request(`/earnings/${WALLET}`)).json());
    expect(earnings.quotes.map((q) => [q.quote.symbol, q.coins.length, q.claimed])).toEqual([
      ["SOL", 0, "0"],
      ["USDC", 0, "700"],
    ]);
  });

  it("refuses an address that is not one", async () => {
    expect((await request("/earnings/not-a-wallet")).status).toBe(400);
  });
});

describe("a graduated coin's LP fees (#51)", () => {
  /** The coin graduated, the creator's position NFT with `owner`, `accrued` lamports of fees on it. */
  async function graduated(c: { mint: Address; pool: Address }, owner: Address, accrued: bigint) {
    const dammPool = random();
    const nftMint = random();
    await db.insert(graduations).values({
      mint: c.mint,
      curvePool: c.pool,
      pool: dammPool,
      config: devnet.configs!.instant,
      signature: `migration-${c.mint}`,
      slot: 2,
      graduatedAt: new Date(),
      sqrtPrice: "1",
      creatorPosition: random(),
      creatorPositionNftMint: nftMint,
      creatorPositionOwner: owner,
      creatorLiquidity: "1",
      heatPosition: random(),
      heatPositionNftMint: random(),
      heatLiquidity: "1",
    });
    const blank = (size: number, discriminator: ArrayLike<number>) => Uint8Array.from({ length: size }, (_, i) => (i < 8 ? discriminator[i]! : 0));
    const { position } = await positionAddresses(nftMint);
    const damm = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
    fakes.accounts.set(dammPool, { owner: damm, data: new Uint8Array(getPoolEncoder().encode(getPoolDecoder().decode(blank(getPoolSize(), POOL_DISCRIMINATOR)))) });
    const state = { ...getPositionDecoder().decode(blank(getPositionSize(), POSITION_DISCRIMINATOR)), pool: dammPool, nftMint, feeBPending: accrued };
    fakes.accounts.set(position, { owner: damm, data: new Uint8Array(getPositionEncoder().encode(state)) });
    return { dammPool, position };
  }

  it("shows what the creator's position has accrued, and claims it with the curve earnings in one transaction", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 1_000n, record: "window claimed", name: "ember" });
    const { position } = await graduated(ember, WALLET, 7_777n);
    const earnings = CreatorEarnings.parse(await (await request(`/earnings/${WALLET}`)).json());
    expect(earnings.quotes[0]!.coins).toEqual([expect.objectContaining({ mint: ember.mint, partnerFees: "1000", lpFees: "7777", waiting: "8277" })]);

    const prepared = PreparedClaim.parse(await (await post(`/earnings/${WALLET}/claim`, { claims: [{ mint: ember.mint, partnerFees: "1000", lpFees: "7777" }] })).json());
    expect(prepared).toMatchObject({ quotes: [{ mint: WSOL_MINT, pays: "8277" }], coins: [{ mint: ember.mint, pays: "8277" }] });
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(prepared.transactions[0]!).messageBytes));
    expect(message.instructions.some((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS)).toBe(true);
    const [lp] = message.instructions.filter((ix) => ix.programAddress === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
    expect((lp!.accounts ?? []).map((a) => a.address)).toContain(position);
    // LP fees claimed meanwhile are refused, as a stale figure is.
    const stale = await post(`/earnings/${WALLET}/claim`, { claims: [{ mint: ember.mint, partnerFees: "1000", lpFees: "9000" }] });
    expect(stale.status).toBe(409);
  });

  it("are not the wallet's once the creator's position NFT is someone else's", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 1_000n, record: "window claimed", name: "ember" });
    await graduated(ember, random(), 7_777n);
    const earnings = CreatorEarnings.parse(await (await request(`/earnings/${WALLET}`)).json());
    expect(earnings.quotes[0]!.coins).toEqual([expect.objectContaining({ lpFees: "0", waiting: "500" })]);
  });
});

describe("a creator's claim", () => {
  it("pays exactly what the page showed, in a transaction the wallet signs and pays for", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 4_600n, record: "window claimed", name: "ember" });
    // The page showed 4,000 of partner fees; 600 more accrued before the claim.
    const res = await post(`/earnings/${WALLET}/claim`, { claims: [{ mint: ember.mint, partnerFees: "4000" }] });
    expect(res.status).toBe(200);
    const prepared = PreparedClaim.parse(await res.json());
    expect(prepared).toMatchObject({ quotes: [{ mint: WSOL_MINT, pays: "2000" }], coins: [{ mint: ember.mint, pays: "2000" }] });
    expect(prepared.transactions).toHaveLength(1);

    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(prepared.transactions[0]!).messageBytes));
    expect(message.feePayer.address).toBe(WALLET);
    const claims = message.instructions.filter((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS);
    expect(claims).toHaveLength(1);
    const data = claims[0]!.data!;
    expect([...data.slice(0, 8)]).toEqual([...CLAIM_FEES_DISCRIMINATOR]);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(8, true)).toBe(4_000n);
  });

  it("claims each quote's coins in transactions of their own, each paying its quote (#99)", async () => {
    await listUsdc();
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 4_000n, record: "window claimed", name: "ember" });
    const dollar = await coin({ creator: WALLET, partnerQuoteFee: 90_000n, record: "window claimed", name: "dollar", quote: "USDC" });
    const res = await post(`/earnings/${WALLET}/claim`, {
      claims: [
        { mint: dollar.mint, partnerFees: "90000" },
        { mint: ember.mint, partnerFees: "4000" },
      ],
    });
    expect(res.status).toBe(200);
    const prepared = PreparedClaim.parse(await res.json());
    expect(prepared).toMatchObject({
      quotes: [
        { mint: DEVNET_USDC, pays: "45000" },
        { mint: WSOL_MINT, pays: "2000" },
      ],
      coins: [
        { mint: dollar.mint, pays: "45000" },
        { mint: ember.mint, pays: "2000" },
      ],
    });
    expect(prepared.transactions).toHaveLength(2);
    const [inUsdc, inSol] = prepared.transactions.map((tx) => decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(tx).messageBytes)));
    const named = (message: typeof inUsdc) => (message!.instructions as readonly { accounts?: readonly { address: string }[] }[]).flatMap((ix) => (ix.accounts ?? []).map((a) => a.address));
    // The USDC claim pays the creator's USDC account and leaves it open; the SOL claim unwraps into the wallet.
    expect(named(inUsdc)).toEqual(expect.arrayContaining([dollar.pool, await quoteAccount(WALLET, DEVNET_USDC, TOKEN_PROGRAM_ADDRESS)]));
    expect(named(inUsdc)).not.toContain(ember.pool);
    expect(named(inSol)).toEqual(expect.arrayContaining([ember.pool, await quoteAccount(WALLET, WSOL_MINT, TOKEN_PROGRAM_ADDRESS)]));
    expect(named(inSol)).not.toContain(dollar.pool);
    expect(inUsdc!.instructions.at(-1)!.programAddress).toBe(FEE_PROGRAM_ADDRESS);
    expect(inSol!.instructions.at(-1)!.programAddress).not.toBe(FEE_PROGRAM_ADDRESS);
    // A coin named twice would be claimed twice.
    expect((await post(`/earnings/${WALLET}/claim`, { claims: [{ mint: ember.mint, partnerFees: "4000" }, { mint: ember.mint, partnerFees: "4000" }] })).status).toBe(400);
  });

  it("is refused when the figure is gone, the window claim has not run, or the coin is not the wallet's or not Heat's", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 1_000n, record: "window claimed", name: "ember" });
    const open = await coin({ creator: WALLET, partnerQuoteFee: 9_000n, record: "window open", name: "spark" });
    const around = await coin({ creator: WALLET, partnerQuoteFee: 777n, record: "none", name: "around" });
    const theirs = await coin({ creator: random(), partnerQuoteFee: 5_000n, record: "window claimed", name: "theirs" });
    for (const [mint, partnerFees] of [
      [ember.mint, "2000"],
      [ember.mint, "1"],
      [open.mint, "9000"],
      [around.mint, "777"],
      [theirs.mint, "5000"],
    ] as const) {
      const res = await post(`/earnings/${WALLET}/claim`, { claims: [{ mint, partnerFees }] });
      expect(res.status, `${mint} ${partnerFees}`).toBe(409);
    }
    expect((await post(`/earnings/${WALLET}/claim`, { claims: [] })).status).toBe(400);
  });

  it("reports what a sent claim paid, from the fee program's own event, and indexes it at once", async () => {
    // The creator's first claim on devnet (packages/indexer's fixture): 400,000 lamports to the creator role holder.
    const landed = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/creator-claim.json"), "utf8"),
    ) as RawTransaction;
    const signature = landed.transaction.signatures[0]!;
    fakes.transactions.set(signature, landed);
    const res = await post("/earnings/claims", { signatures: [signature] });
    expect(res.status).toBe(200);
    const outcome = ClaimOutcome.parse(await res.json());
    expect(outcome).toMatchObject({
      quotes: [{ mint: WSOL_MINT, paid: "400000" }],
      coins: [{ mint: address("BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593"), paid: "400000" }],
      transactions: [{ signature, status: "landed", error: null }],
    });
    await settle();
    expect(indexedNow).toEqual([signature]);
  });

  it("says when a sent claim failed on chain", async () => {
    fakes.signatureStatus = "failed";
    const signature = "5".repeat(87);
    const outcome = ClaimOutcome.parse(await (await post("/earnings/claims", { signatures: [signature] })).json());
    expect(outcome.transactions[0]).toMatchObject({ status: "failed" });
    expect(outcome.quotes).toEqual([]);
  });
});
