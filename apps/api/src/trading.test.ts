import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, decompileTransactionMessage, getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, referralAccountOf, tokenAccountOf } from "@top-pad/chain";
import {
  getPoolConfigDecoder,
  getPoolConfigEncoder,
  getPoolConfigSize,
  getSwap2InstructionDataDecoder,
  getVirtualPoolDecoder,
  getVirtualPoolEncoder,
  POOL_CONFIG_DISCRIMINATOR,
} from "@top-pad/clients/dbc";
import {
  CP_AMM_PROGRAM_ADDRESS,
  getPoolDecoder,
  getPoolEncoder,
  getPoolSize,
  getSwap2InstructionDataDecoder as getDammSwap2InstructionDataDecoder,
  POOL_DISCRIMINATOR,
} from "@top-pad/clients/damm-v2";
import { Holdings, PreparedSwap, SwapOutcome, SwapQuote } from "@top-pad/contract";
import { coins, createDb, graduations, pools, type Db } from "@top-pad/db";
import { quoteDammSwap } from "@top-pad/meteora/damm";
import { createTestDatabase } from "@top-pad/db/testing";
import { heatHandler, indexTransactions, provisionalOrderKey, type RawTransaction } from "@top-pad/indexer";
import recorded from "../../../packages/meteora/src/fixtures/swaps.json" with { type: "json" };
import { quoteSwap } from "@top-pad/meteora/quote";
import { app } from "./index";
import { dbcPool, decode, Fakes, ORIGINS, testBindings, testContext } from "./test/fakes";
import type { Bindings } from "./env";

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;

// A real devnet launch whose creator bought in the same transaction (packages/indexer's fixture): a Heat coin, its pool
// on the Instant config, and a swap to read back.
const launch = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/launch-with-creator-buy.json"), "utf8"),
) as RawTransaction;
const MINT = address("EcQZjuhGWVjF3GjSPj6e9XzCchMy7B338Ug9VNgraf1L");
const POOL = address("HLzYgbHReBQxdungMNakZT72MFQrjmkDWhJk773CWKkw");
const ACTIVATION = 1_793_247_380n;
const devnet = CLUSTERS.devnet!;
const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL = 1_000_000_000n;

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
  await indexTransactions(db, heatHandler({ heat: devnet, blockIndexOf: async () => 17 }), [launch]);
});
afterAll(async () => {
  await closeDb();
  await drop();
});

let fakes: Fakes;
let indexedNow: string[];
beforeEach(async () => {
  fakes = new Fakes();
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
  // Heat's referral account, the treasury's account of wrapped SOL, which a swap names only once it exists.
  const treasury = devnet.keys!.treasury;
  fakes.accounts.set(await referralAccountOf(treasury, devnet.quote.mint), tokenAccount(treasury, devnet.quote.mint, 0n));
});
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

// The Instant config as devnet holds it, from the swaps recorded there.
const instant = recorded.pools.find((p) => p.config.address === devnet.configs!.instant)!.config;

/** Devnet's Instant config, as DBC lays it out: the fields a quote reads, every other one zero. */
function configAccount() {
  const zero = new Uint8Array(getPoolConfigSize());
  zero.set(POOL_CONFIG_DISCRIMINATOR, 0);
  const blank = getPoolConfigDecoder().decode(zero);
  const curve = instant.curve.map((p) => ({ sqrtPrice: BigInt(p.sqrtPrice), liquidity: BigInt(p.liquidity) }));
  const data = getPoolConfigEncoder().encode({
    ...blank,
    collectFeeMode: instant.collectFeeMode,
    sqrtStartPrice: BigInt(instant.sqrtStartPrice),
    migrationQuoteThreshold: BigInt(instant.migrationQuoteThreshold),
    migrationSqrtPrice: BigInt(instant.migrationSqrtPrice),
    curve: [...curve, ...blank.curve.slice(curve.length)],
    poolFees: {
      ...blank.poolFees,
      baseFee: {
        ...blank.poolFees.baseFee,
        cliffFeeNumerator: BigInt(instant.baseFee.cliffFeeNumerator),
        firstFactor: instant.baseFee.firstFactor,
        secondFactor: BigInt(instant.baseFee.secondFactor),
        thirdFactor: BigInt(instant.baseFee.thirdFactor),
        baseFeeMode: instant.baseFee.baseFeeMode,
      },
    },
  });
  return { owner: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS as string, data: new Uint8Array(data) };
}

/** The coin's pool on chain, at the curve's start unless a reserve and price are given. */
function poolAccount(o: { quoteReserve?: bigint; sqrtPrice?: bigint } = {}) {
  const base = dbcPool({ config: devnet.configs!.instant, creator: random(), mint: MINT, baseVault: random(), quoteVault: random(), partnerQuoteFee: 0n, activationPoint: ACTIVATION });
  const zero = getVirtualPoolDecoder().decode(base.data);
  const data = getVirtualPoolEncoder().encode({
    ...zero,
    poolState: { ...zero.poolState, sqrtPrice: o.sqrtPrice ?? BigInt(instant.sqrtStartPrice), quoteReserve: o.quoteReserve ?? 0n, hasSwap: 1 },
  });
  return { owner: base.owner, data: new Uint8Array(data) };
}

/** An SPL token account holding `amount`. */
function tokenAccount(owner: Address, mint: Address, amount: bigint) {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { owner: TOKEN_PROGRAM, data, lamports: 2_039_280n };
}

/** The chain as a quote reads it: the pool, its config and the clock, `seconds` after the coin opened. */
function chainAt(seconds: number, pool = poolAccount()) {
  fakes.accounts.set(POOL, pool);
  fakes.accounts.set(devnet.configs!.instant, configAccount());
  fakes.clock = ACTIVATION + BigInt(seconds);
}

const quoteOf = (body: unknown) => post(`/coins/${MINT}/quote`, body);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("a quick trade's quote", () => {
  it("gives the fee of every second the sniper tax still runs, falling to the trading fee, each DBC's own figure", async () => {
    chainAt(20);
    const res = await quoteOf({ side: "buy", amount: `${SOL / 10n}`, slippageBps: 100 });
    expect(res.status).toBe(200);
    const quote = SwapQuote.parse(await res.json());
    expect(quote).toMatchObject({ side: "buy", amountIn: `${SOL / 10n}`, amountLeft: "0", chainTime: Number(ACTIVATION) + 20, taxEndsAt: Number(ACTIVATION) + 60 });
    // One step a second from now to the end of the tax, the last holding from then on.
    expect(quote.steps.map((s) => s.from)).toEqual(Array.from({ length: 41 }, (_, i) => Number(ACTIVATION) + 20 + i));
    const rates = quote.steps.map((s) => Number(s.fee) / Number(s.quoteAmount));
    rates.slice(1).forEach((rate, i) => expect(rate).toBeLessThan(rates[i]!));
    expect(rates.at(-1)).toBeCloseTo(0.0125, 9);
    // Each step is the quote for its second: here the twentieth.
    const pool = getVirtualPoolDecoder().decode(poolAccount().data).poolState;
    const config = getPoolConfigDecoder().decode(configAccount().data);
    const at20 = quoteSwap({ pool, config, side: "buy", amountIn: SOL / 10n, currentPoint: ACTIVATION + 20n, hasReferral: true });
    expect(quote.steps[0]).toEqual({ from: Number(ACTIVATION) + 20, fee: `${at20.fee}`, quoteAmount: `${at20.quoteAmount}`, amountOut: `${at20.amountOut}` });
    // The least it may return allows the slippage on the fee of two seconds before, where a lagging node may simulate it.
    const at18 = quoteSwap({ pool, config, side: "buy", amountIn: SOL / 10n, currentPoint: ACTIVATION + 18n, hasReferral: true });
    expect(quote.minimumOut).toBe(`${(at18.amountOut * 9_900n) / 10_000n}`);
    expect(at18.amountOut).toBeLessThan(at20.amountOut);
  });

  it("is one step once the tax has ended", async () => {
    chainAt(600);
    const quote = SwapQuote.parse(await (await quoteOf({ side: "buy", amount: `${SOL}`, slippageBps: 50 })).json());
    expect(quote.steps).toHaveLength(1);
    expect(Number(quote.steps[0]!.fee) / Number(quote.steps[0]!.quoteAmount)).toBeCloseTo(0.0125, 9);
  });

  it("refuses what it cannot quote, and says why", async () => {
    chainAt(600);
    expect((await quoteOf({ side: "buy", amount: "0", slippageBps: 100 })).status).toBe(400);
    expect((await quoteOf({ side: "buy", amount: "100", slippageBps: 9_000 })).status).toBe(400);
    expect((await post(`/coins/${random()}/quote`, { side: "buy", amount: "100", slippageBps: 100 })).status).toBe(404);
    // A sell larger than the curve has bought.
    const tooMuch = await quoteOf({ side: "sell", amount: `${10n ** 17n}`, slippageBps: 100 });
    expect(tooMuch.status).toBe(400);
    expect(await errorOf(tooMuch)).toMatch(/^This trade cannot run/);
    // A curve that has completed trades on Meteora once it graduates (#51).
    chainAt(600, poolAccount({ quoteReserve: BigInt(instant.migrationQuoteThreshold) }));
    const complete = await quoteOf({ side: "buy", amount: "100", slippageBps: 100 });
    expect(complete.status).toBe(409);
    expect(await errorOf(complete)).toMatch(/curve is complete/);
  });

  it("is quoted and built on the coin's DAMM v2 pool once it has graduated, its fee set by its price (#51)", async () => {
    const graduatedMint = random();
    const curve = random();
    const dammPool = random();
    const now = new Date();
    await db.insert(pools).values({
      pool: curve,
      mint: graduatedMint,
      config: devnet.configs!.instant,
      quoteMint: "So11111111111111111111111111111111111111112",
      graduationTarget: 8_500_000_000n,
      startSqrtPrice: "35525023424642174",
      creator: random(),
      name: "Graduated",
      ticker: "GRAD",
      uri: "https://example.com/g.json",
      activatedAt: now,
      createdSignature: "graduated",
      createdSlot: 1,
      createdAt: now,
      sqrtPrice: "120258058333485015",
      quoteReserve: BigInt(instant.migrationQuoteThreshold),
    });
    await db.insert(coins).values({
      mint: graduatedMint,
      pool: curve,
      config: devnet.configs!.instant,
      launchMode: "instant",
      creatorWallet: random(),
      name: "Graduated",
      ticker: "GRAD",
      metadataUri: "https://example.com/g.json",
      createdSignature: "graduated-coin",
      createdSlot: 1,
      createdAt: now,
    });
    const graduation = 120_258_058_333_485_015n;
    await db.insert(graduations).values({
      mint: graduatedMint,
      curvePool: curve,
      pool: dammPool,
      config: devnet.configs!.instant,
      signature: "migration",
      slot: 2,
      graduatedAt: now,
      sqrtPrice: `${graduation}`,
      creatorPosition: random(),
      creatorPositionNftMint: random(),
      creatorPositionOwner: random(),
      creatorLiquidity: "1",
      heatPosition: random(),
      heatPositionNftMint: random(),
      heatLiquidity: "1",
    });
    // The graduated pool a little above its graduation price, as DAMM v2 lays it out.
    const scheduler = new Uint8Array(32);
    const view = new DataView(scheduler.buffer);
    view.setBigUint64(0, 12_500_000n, true);
    view.setUint8(8, 3);
    view.setUint16(14, 100, true);
    view.setUint32(16, 900, true);
    view.setUint32(20, 315_360_000, true);
    view.setBigUint64(24, 100_000n, true);
    const blank = getPoolDecoder().decode(Uint8Array.from({ length: getPoolSize() }, (_, i) => (i < 8 ? POOL_DISCRIMINATOR[i]! : 0)));
    const state = {
      ...blank,
      tokenAMint: graduatedMint,
      tokenBMint: devnet.quote.mint,
      sqrtMinPrice: 4_295_048_016n,
      sqrtMaxPrice: 79_226_673_521_066_979_257_578_248_091n,
      sqrtPrice: (graduation * 125n) / 100n,
      liquidity: (8_483_000_000n << 128n) / (graduation - 4_295_048_016n),
      activationPoint: ACTIVATION,
      collectFeeMode: 1,
      feeVersion: 1,
      poolFees: { ...blank.poolFees, protocolFeePercent: 20, referralFeePercent: 20, initSqrtPrice: graduation, baseFee: { ...blank.poolFees.baseFee, baseFeeInfo: { data: scheduler } } },
    };
    fakes.accounts.set(dammPool, { owner: CP_AMM_PROGRAM_ADDRESS, data: new Uint8Array(getPoolEncoder().encode(state)) });
    fakes.clock = ACTIVATION + 86_400n;

    const quote = SwapQuote.parse(await (await post(`/coins/${graduatedMint}/quote`, { side: "buy", amount: `${SOL / 10n}`, slippageBps: 100 })).json());
    const expected = quoteDammSwap({ pool: getPoolDecoder().decode(fakes.accounts.get(dammPool)!.data), side: "buy", amountIn: SOL / 10n, currentPoint: ACTIVATION + 86_400n, hasReferral: true });
    // One step: a graduated pool's fee follows its price, here two 9% steps up, at 1.23%.
    expect(quote.steps).toEqual([{ from: Number(ACTIVATION) + 86_400, fee: `${expected.fee}`, quoteAmount: `${expected.quoteAmount}`, amountOut: `${expected.amountOut}` }]);
    expect(Number(expected.fee) / Number(SOL / 10n)).toBeCloseTo(0.0123, 6);
    expect(quote.minimumOut).toBe(`${(expected.amountOut * 9_900n) / 10_000n}`);

    const wallet = random();
    fakes.accounts.set(wallet, { owner: "11111111111111111111111111111111", data: new Uint8Array(), lamports: SOL });
    const prepared = PreparedSwap.parse(await (await post(`/coins/${graduatedMint}/swap`, { side: "buy", amount: `${SOL / 10n}`, slippageBps: 100, wallet })).json());
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(prepared.transaction).messageBytes));
    expect(message.instructions.some((ix) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)).toBe(false);
    const [swap] = message.instructions.filter((ix) => ix.programAddress === CP_AMM_PROGRAM_ADDRESS);
    const named = (swap!.accounts ?? []).map((a) => a.address);
    expect(named[1]).toBe(dammPool);
    // Heat's referral account takes Meteora's referral share on the graduated pool too.
    expect(named).toContain(await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint));
    expect(getDammSwap2InstructionDataDecoder().decode(swap!.data!).params).toEqual({ amount0: SOL / 10n, amount1: BigInt(quote.minimumOut), swapMode: 0 });
  });

  it("is built only for coins launched through Heat", async () => {
    const around = random();
    await db.insert(pools).values({
      pool: random(),
      mint: around,
      config: devnet.configs!.instant,
      quoteMint: "So11111111111111111111111111111111111111112",
      graduationTarget: 8_500_000_000n,
      startSqrtPrice: "35525023424642174",
      creator: random(),
      name: "Around",
      ticker: "AROUND",
      uri: "https://example.com/a.json",
      activatedAt: new Date(),
      createdSignature: "around",
      createdSlot: 1,
      createdAt: new Date(),
      sqrtPrice: "1",
      quoteReserve: 0n,
    });
    const res = await post(`/coins/${around}/quote`, { side: "buy", amount: "100", slippageBps: 100 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("Heat builds trades only for coins launched through Heat.");
  });
});

describe("a quick trade", () => {
  const swapOf = async (body: unknown) => post(`/coins/${MINT}/swap`, body);
  /** The prepared transaction's DBC swap: its accounts and its amounts. */
  function dbcSwap(wire: string) {
    const tx = decode(wire);
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
    const swap = message.instructions.find((ix) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)!;
    return { message, accounts: swap.accounts!.map((a) => a.address), params: getSwap2InstructionDataDecoder().decode(swap.data!).params };
  }

  it("buys as a partial fill the wallet pays for, naming Heat's referral account, at least the quote's minimum", async () => {
    chainAt(30);
    const wallet = random();
    fakes.accounts.set(wallet, { owner: "11111111111111111111111111111111", data: new Uint8Array(), lamports: SOL });
    const res = await swapOf({ side: "buy", amount: `${SOL / 10n}`, slippageBps: 200, wallet });
    expect(res.status).toBe(200);
    const { quote, transaction } = PreparedSwap.parse(await res.json());
    const { message, accounts, params } = dbcSwap(transaction);
    expect(message.feePayer.address).toBe(wallet);
    expect(params).toEqual({ amount0: SOL / 10n, amount1: BigInt(quote.minimumOut), swapMode: 1 });
    expect(accounts[2]).toBe(POOL);
    expect(accounts[12]).toBe(await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint));
  });

  it("sells exactly the coins asked, and refuses more than the wallet holds", async () => {
    // The curve as it stood after a buy of about a tenth of a SOL.
    chainAt(600, poolAccount({ quoteReserve: 98_750_000n, sqrtPrice: 35_662_000_000_000_000n }));
    const wallet = random();
    fakes.accounts.set(wallet, { owner: "11111111111111111111111111111111", data: new Uint8Array(), lamports: SOL / 100n });
    fakes.accounts.set(await tokenAccountOf(wallet, MINT), tokenAccount(wallet, MINT, 1_000_000_000_000n));
    const res = await swapOf({ side: "sell", amount: "1000000000000", slippageBps: 100, wallet });
    expect(res.status).toBe(200);
    const { params } = dbcSwap(PreparedSwap.parse(await res.json()).transaction);
    expect(params.swapMode).toBe(0);
    expect(params.amount0).toBe(1_000_000_000_000n);
    const more = await swapOf({ side: "sell", amount: "1000000000001", slippageBps: 100, wallet });
    expect(more.status).toBe(400);
    expect(await errorOf(more)).toBe("This wallet does not hold that many of the coin.");
  });

  it("refuses a buy the wallet cannot pay for, its accounts' rent and network fee included", async () => {
    chainAt(600);
    const wallet = random();
    // A tenth of a SOL, but nothing for the coin account's and the wrapped SOL account's rent.
    fakes.accounts.set(wallet, { owner: "11111111111111111111111111111111", data: new Uint8Array(), lamports: SOL / 10n });
    const res = await swapOf({ side: "buy", amount: `${SOL / 10n}`, slippageBps: 100, wallet });
    expect(res.status).toBe(400);
    // Two accounts' rent as the cluster charges it, 1,488,440 lamports each, and the network fee.
    expect(await errorOf(res)).toBe("This wallet holds 0.1 SOL; the buy needs 0.10298688 SOL, with its accounts' rent and the network fee.");
  });

  it("says what a wallet holds to trade with", async () => {
    const wallet = random();
    fakes.accounts.set(wallet, { owner: "11111111111111111111111111111111", data: new Uint8Array(), lamports: 123n });
    fakes.accounts.set(await tokenAccountOf(wallet, MINT), tokenAccount(wallet, MINT, 456n));
    const holdings = Holdings.parse(await (await request(`/coins/${MINT}/holdings/${wallet}`)).json());
    expect(holdings).toEqual({ wallet, sol: "123", quote: "123", coins: "456" });
    // A wallet that has never held the coin.
    const fresh = random();
    expect(Holdings.parse(await (await request(`/coins/${MINT}/holdings/${fresh}`)).json())).toEqual({ wallet: fresh, sol: "0", quote: "0", coins: "0" });
  });
});

describe("a sent trade's report, the browser's fast path", () => {
  const signature = launch.transaction.signatures[0]!;

  it("reads the trade back from the chain the moment it confirms, with a provisional order key, and hands it to the indexer", async () => {
    fakes.transactions.set(signature, launch);
    const res = await post(`/coins/${MINT}/trades`, { signature });
    expect(res.status).toBe(200);
    const outcome = SwapOutcome.parse(await res.json());
    expect(outcome).toMatchObject({ signature, status: "landed", error: null });
    expect(outcome.trades).toHaveLength(1);
    expect(outcome.trades[0]).toMatchObject({
      signature,
      eventIndex: 0,
      orderKey: provisionalOrderKey(launch.slot, 0),
      side: "buy",
      quoteAmount: "10000000",
      trader: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8",
    });
    await settle();
    expect(indexedNow).toEqual([signature]);
  });

  it("says in plain words why a trade failed on chain", async () => {
    fakes.signatureStatus = "failed";
    fakes.failedWith = 6002;
    const outcome = SwapOutcome.parse(await (await post(`/coins/${MINT}/trades`, { signature })).json());
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/^The price moved more than your slippage allows/);
    expect(outcome.trades).toEqual([]);
  });
});
