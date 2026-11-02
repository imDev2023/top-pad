import { decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DAMM_V2_MIGRATION_CONFIG, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS, MIGRATION_PROGRESS, positionAddresses } from "@top-pad/chain";
import { getPoolEncoder, getPoolSize, getPositionEncoder, getPositionSize, getPoolDecoder, getPositionDecoder, POOL_DISCRIMINATOR, POSITION_DISCRIMINATOR } from "@top-pad/clients/damm-v2";
import {
  getPoolConfigDecoder,
  getPoolConfigEncoder,
  getPoolConfigSize,
  getVirtualPoolDecoder,
  getVirtualPoolEncoder,
  MIGRATION_DAMM_V2_DISCRIMINATOR,
  POOL_CONFIG_DISCRIMINATOR,
} from "@top-pad/clients/dbc";
import { BURN_LEFTOVER_DISCRIMINATOR, CLAIM_LP_FEES_DISCRIMINATOR, CLAIM_SURPLUS_DISCRIMINATOR, findCoinRecordPda } from "@top-pad/clients/fee";
import { coins, createDb, graduations, pools, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { config, type Bindings } from "./env";
import { claimHeatLpFees, LP_FEE_CLAIM_MINIMUM, sendLeftoverBurn, sendMigration, sendSurplusClaim, startGraduation, sweepGraduations } from "./graduation";
import { coinRecord, dbcPool, Fakes, lookupTableAccount, testBindings, testKeypair } from "./test/fakes";

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
const keeperKey = () => ({ get: async () => JSON.stringify(Array.from(keeper().secret)) });

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
let fakes: Fakes;
beforeEach(() => {
  fakes = new Fakes();
  vi.stubGlobal("fetch", fakes.fetch);
  fakes.accounts.set(devnet.lookupTable!, lookupTableAccount([DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS]));
});
afterEach(() => vi.unstubAllGlobals());

const TARGET = devnet.graduationTarget;

/** The Instant config on chain with its Graduation Target; every other field zero. */
function configAccount() {
  const zero = new Uint8Array(getPoolConfigSize());
  zero.set(POOL_CONFIG_DISCRIMINATOR, 0);
  const data = getPoolConfigEncoder().encode({ ...getPoolConfigDecoder().decode(zero), migrationQuoteThreshold: TARGET });
  return { owner: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS as string, data: new Uint8Array(data) };
}

type Curve = { quoteReserve: bigint; migrationProgress: number; surplusSplit?: boolean; leftoverBurnt?: boolean };

/** A Heat coin whose curve stands as given: its record, its pool and its config. */
async function heatCoin(c: Curve) {
  const mint = random();
  const pool = random();
  const base = dbcPool({ config: devnet.configs!.instant, creator: random(), mint, baseVault: random(), quoteVault: random(), partnerQuoteFee: 0n, activationPoint: 1_793_306_000n });
  const zero = getVirtualPoolDecoder().decode(base.data);
  const data = getVirtualPoolEncoder().encode({
    ...zero,
    poolState: {
      ...zero.poolState,
      quoteReserve: c.quoteReserve,
      migrationProgress: c.migrationProgress,
      isMigrated: c.migrationProgress === MIGRATION_PROGRESS.createdPool ? 1 : 0,
      isPartnerWithdrawSurplus: c.surplusSplit ? 1 : 0,
      isWithdrawLeftover: c.leftoverBurnt ? 1 : 0,
    },
  });
  fakes.accounts.set(pool, { owner: base.owner, data: new Uint8Array(data) });
  fakes.accounts.set(devnet.configs!.instant, configAccount());
  fakes.accounts.set((await findCoinRecordPda({ mint }))[0], coinRecord({ mint, pool, windowClaimed: true }));
  return { mint, pool };
}

const complete = { quoteReserve: TARGET, migrationProgress: MIGRATION_PROGRESS.lockedVesting };
const migrated = { quoteReserve: TARGET, migrationProgress: MIGRATION_PROGRESS.createdPool };

/** The one transaction the keeper sent: its fee payer, signers and instructions. */
function sentOnly() {
  expect(fakes.sent).toHaveLength(1);
  const tx = fakes.sent[0]!;
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes), {
    addressesByLookupTableAddress: { [devnet.lookupTable!]: [DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS] },
  });
  return { message, signers: Object.keys(tx.signatures) };
}
const startsWith = (data: ArrayLike<number> | undefined, discriminator: ArrayLike<number>) => Array.from(discriminator).every((b, i) => data?.[i] === b);

describe("a coin's Graduation", () => {
  it("is migrated by the keeper once its curve is complete, the keeper and two new position NFT keys signing", async () => {
    const cfg = config(testBindings(url));
    const coin = await heatCoin(complete);
    const sent = await sendMigration(cfg, keeperKey(), coin.mint);
    expect(sent.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    const { message, signers } = sentOnly();
    expect(message.feePayer.address).toBe(keeper().signer.address);
    // The keeper and both NFT mints.
    expect(signers).toHaveLength(3);
    const [migrate] = message.instructions.filter((ix) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS);
    expect(startsWith(migrate!.data, MIGRATION_DAMM_V2_DISCRIMINATOR)).toBe(true);
    const named = (migrate!.accounts ?? []).map((a) => a.address);
    expect(named[0]).toBe(coin.pool);
    // Meteora's customizable DAMM v2 config, last, for the market-cap fee schedule.
    expect(named.at(-1)).toBe(DAMM_V2_MIGRATION_CONFIG);
  });

  it("sends nothing once the coin has migrated, so a step tried again is safe, and refuses a curve that is not complete", async () => {
    const cfg = config(testBindings(url));
    expect(await sendMigration(cfg, keeperKey(), (await heatCoin(migrated)).mint)).toEqual({ signature: null });
    expect(fakes.sent).toEqual([]);
    const running = await heatCoin({ quoteReserve: TARGET - 1n, migrationProgress: MIGRATION_PROGRESS.preBondingCurve });
    await expect(sendMigration(cfg, keeperKey(), running.mint)).rejects.toThrow("of its 8500000000 target");
    await expect(sendMigration(cfg, keeperKey(), random())).rejects.toThrow("has no CoinRecord");
  });

  it("splits the surplus once the curve is complete, and only once", async () => {
    const cfg = config(testBindings(url));
    const coin = await heatCoin({ ...complete, quoteReserve: TARGET + 1_000n });
    await sendSurplusClaim(cfg, keeperKey(), coin.mint);
    const { message } = sentOnly();
    expect(message.instructions.some((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS && startsWith(ix.data, CLAIM_SURPLUS_DISCRIMINATOR))).toBe(true);
    fakes.sent = [];
    expect(await sendSurplusClaim(cfg, keeperKey(), (await heatCoin({ ...complete, surplusSplit: true })).mint)).toEqual({ signature: null });
    expect(fakes.sent).toEqual([]);
  });

  it("burns the leftover once the coin has migrated, and only once", async () => {
    const cfg = config(testBindings(url));
    await expect(sendLeftoverBurn(cfg, keeperKey(), (await heatCoin(complete)).mint)).rejects.toThrow("has not migrated");
    await sendLeftoverBurn(cfg, keeperKey(), (await heatCoin(migrated)).mint);
    const { message } = sentOnly();
    expect(message.instructions.some((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS && startsWith(ix.data, BURN_LEFTOVER_DISCRIMINATOR))).toBe(true);
    fakes.sent = [];
    expect(await sendLeftoverBurn(cfg, keeperKey(), (await heatCoin({ ...migrated, leftoverBurnt: true })).mint)).toEqual({ signature: null });
    expect(fakes.sent).toEqual([]);
  });
});

/** A stand-in for the Workflow binding: the instances made, and what was asked of each. */
function workflows(existing: Record<string, string> = {}) {
  const created: string[] = [];
  const restarted: string[] = [];
  const binding = {
    create: async ({ id }: { id: string }) => {
      if (id in existing) throw new Error(`instance ${id} already exists`);
      created.push(id);
      return { id };
    },
    get: async (id: string) => {
      if (!(id in existing)) throw new Error(`no instance ${id}`);
      return { id, status: async () => ({ status: existing[id] }), restart: async () => void restarted.push(id) };
    },
  } as unknown as NonNullable<Bindings["GRADUATIONS"]>;
  return { binding, created, restarted };
}

/** A coin as the indexer writes it, its pool holding `quoteReserve`. */
async function indexedCoin(o: { quoteReserve: bigint; completed?: boolean; graduated?: "fully" | "leftover pending" }) {
  const mint = random();
  const pool = random();
  const now = new Date();
  await db.insert(pools).values({
    pool,
    mint,
    config: devnet.configs!.instant,
    creator: random(),
    name: "Coin",
    ticker: "COIN",
    uri: "https://example.com",
    activatedAt: now,
    createdSignature: random(),
    createdSlot: 1,
    createdAt: now,
    sqrtPrice: "1",
    quoteReserve: o.quoteReserve,
    curveCompletedAt: o.completed ? now : null,
    surplusSignature: o.graduated ? random() : null,
  });
  await db.insert(coins).values({
    mint,
    pool,
    config: devnet.configs!.instant,
    launchMode: "instant",
    creatorWallet: random(),
    name: "Coin",
    ticker: "COIN",
    metadataUri: "https://example.com",
    createdSignature: random(),
    createdSlot: 1,
    createdAt: now,
  });
  if (o.graduated) await db.insert(graduations).values(graduationRow(mint, pool, o.graduated === "fully" ? random() : null));
  return mint;
}

function graduationRow(mint: string, curvePool: string, leftoverSignature: string | null) {
  return {
    mint,
    curvePool,
    pool: random(),
    config: devnet.configs!.instant,
    signature: random(),
    slot: 1,
    graduatedAt: new Date(),
    sqrtPrice: "120258058333485015",
    creatorPosition: random(),
    creatorPositionNftMint: random(),
    creatorPositionOwner: random(),
    creatorLiquidity: "1",
    heatPosition: random(),
    heatPositionNftMint: random(),
    heatLiquidity: "1",
    leftoverBurnt: leftoverSignature ? 0n : null,
    leftoverSignature,
  };
}

describe("the Graduation Workflow", () => {
  it("starts once per coin, and starts again only if it failed", async () => {
    const w = workflows({ running: "running", done: "complete", failed: "errored" });
    const env = testBindings(url, { GRADUATIONS: w.binding });
    for (const mint of ["new", "running", "done", "failed"]) await startGraduation(env, mint);
    expect(w.created).toEqual(["new"]);
    expect(w.restarted).toEqual(["failed"]);
  });

  it("is started by the cron for every coin whose curve completed and whose Graduation is not done", async () => {
    await db.delete(graduations);
    await db.delete(coins);
    await db.delete(pools);
    const due = [await indexedCoin({ quoteReserve: TARGET }), await indexedCoin({ quoteReserve: 0n, completed: true }), await indexedCoin({ quoteReserve: TARGET, graduated: "leftover pending" })];
    await indexedCoin({ quoteReserve: TARGET - 1n });
    await indexedCoin({ quoteReserve: TARGET, completed: true, graduated: "fully" });
    const w = workflows();
    expect(await sweepGraduations(db, testBindings(url, { GRADUATIONS: w.binding }))).toEqual({ due: 3 });
    expect(w.created.sort()).toEqual([...due].sort());
  });
});

describe("Heat's LP fees", () => {
  /** A graduated pool and Heat's position in it, `accrued` lamports of fees waiting. */
  async function graduatedWithFees(accrued: bigint) {
    await db.delete(graduations);
    const row = graduationRow(random(), random(), random());
    await db.insert(graduations).values(row);
    const { position } = await positionAddresses(row.heatPositionNftMint as Address);
    const blankPool = getPoolDecoder().decode(Uint8Array.from({ length: getPoolSize() }, (_, i) => (i < 8 ? POOL_DISCRIMINATOR[i]! : 0)));
    fakes.accounts.set(row.pool, { owner: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", data: new Uint8Array(getPoolEncoder().encode(blankPool)) });
    const blankPosition = getPositionDecoder().decode(Uint8Array.from({ length: getPositionSize() }, (_, i) => (i < 8 ? POSITION_DISCRIMINATOR[i]! : 0)));
    const state = getPositionEncoder().encode({ ...blankPosition, pool: row.pool as Address, feeBPending: accrued });
    fakes.accounts.set(position, { owner: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", data: new Uint8Array(state) });
  }

  it("are claimed to the treasury once they are worth a transaction", async () => {
    const env = testBindings(url, { KEEPER_KEY: JSON.stringify(Array.from(keeper().secret)) });
    await graduatedWithFees(LP_FEE_CLAIM_MINIMUM - 1n);
    expect(await claimHeatLpFees(db, env)).toEqual({ graduated: 1, claimed: 0 });
    expect(fakes.sent).toEqual([]);
    await graduatedWithFees(LP_FEE_CLAIM_MINIMUM);
    expect(await claimHeatLpFees(db, env)).toEqual({ graduated: 1, claimed: 1 });
    const { message } = sentOnly();
    expect(message.instructions.some((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS && startsWith(ix.data, CLAIM_LP_FEES_DISCRIMINATOR))).toBe(true);
  });
});
