import {
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  partiallySignTransaction,
  verifySignature,
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLUSTERS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  FAIR_OPEN_PROGRAM_ADDRESS,
  fairOpenAccounts,
  fairOpenLookupTableAddresses,
  identityHash,
  potCapOf,
  rungAtOrBelow,
  rungs,
  Tier,
} from "@top-pad/chain";
import { parseInitializeVirtualPoolWithSplTokenInstruction } from "@top-pad/clients/dbc";
import { CREATE_LAUNCH_DISCRIMINATOR, getCreateLaunchInstructionDataDecoder } from "@top-pad/clients/fair-open";
import { FairOpen, FairOpenOutcome, FairOpenRefusal, LaunchRefusal, LaunchStatus, Platform, PreparedFairOpenTransaction, PreparedLaunch } from "@top-pad/contract";
import { createDb, creatorWallets, fairOpenRungs, launches, protectedCoins, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { candidateKeys, FOLD_VERSION } from "@top-pad/vamp-shield";
import { app } from "./index";
import { decode, Fakes, fairOpenLaunch, lookupTableAccount, MemoryBlobs, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";
import type { Bindings } from "./env";

// The keeper and admission keys the cluster records are swapped for test keys: the real ones live only in Secrets Store.
vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { testKeypair } = await import("./test/fakes");
  const [keeper, admission] = await Promise.all([testKeypair(), testKeypair()]);
  Object.assign(globalThis, { __testKeeper: keeper, __testAdmission: admission });
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, keeper: keeper.signer.address, admission: admission.signer.address } } } };
});
type TestKey = Awaited<ReturnType<typeof testKeypair>>;
const keeper = () => (globalThis as unknown as { __testKeeper: TestKey }).__testKeeper;
const admission = () => (globalThis as unknown as { __testAdmission: TestKey }).__testAdmission;

/** A 1x1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const devnet = CLUSTERS.devnet!;
const POT_CAP = potCapOf(devnet.graduationTarget);

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
let blobs: MemoryBlobs;
let started: string[];
let indexedNow: string[];
beforeEach(async () => {
  fakes = new Fakes();
  blobs = new MemoryBlobs();
  started = [];
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
  table = await fairOpenLookupTableAddresses(devnet);
  fakes.accounts.set(devnet.lookupTable!, lookupTableAccount(table));
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = {
  idFromName: () => "indexer",
  get: () => ({ indexNow: async (signatures: string[]) => void indexedNow.push(...signatures) }),
} as unknown as Bindings["INDEXER"];
// The keeper's Workflows stand in as a binding that records which launches it was asked to keep.
const workflows = { create: async ({ id }: { id: string }) => void started.push(id), get: async () => null } as unknown as Bindings["FAIR_OPENS"];
const bindings = () =>
  testBindings(url, {
    BLOBS: blobs,
    KEEPER_KEY: { get: async () => JSON.stringify(Array.from(keeper().secret)) },
    ADMISSION_KEY: { get: async () => JSON.stringify(Array.from(admission().secret)) },
    INDEXER: indexer,
    FAIR_OPENS: workflows,
  });
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);
const json = (path: string, body: unknown, cookie?: string) =>
  request(path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGINS.web, "content-type": "application/json", ...(cookie ? { cookie } : {}) } });

/** Links an X account and returns its session cookie. */
async function linkX(user: { id: string; username: string }) {
  fakes.xUser = { ...user, name: user.username };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  return res.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
type Schedule = { name?: string; ticker?: string; wallet: Address; depositsOpenAt?: number; minRaise?: bigint; teaser?: string };

function prepare(cookie: string, s: Schedule) {
  const form = new FormData();
  form.set("mode", "fair_open");
  form.set("name", s.name ?? "Lumen");
  form.set("ticker", s.ticker ?? "LUMEN");
  form.set("wallet", s.wallet);
  form.set("depositsOpenAt", `${s.depositsOpenAt ?? nowSeconds() + 3600}`);
  form.set("minRaise", `${s.minRaise ?? 0n}`);
  form.set("teaser", s.teaser ?? "The first coin with a heartbeat");
  form.set("image", new File([PNG], "lumen.png", { type: "image/png" }));
  return request("/launches", { method: "POST", body: form, headers: { origin: ORIGINS.web, cookie } });
}

async function prepared(res: Response) {
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  const launch = PreparedLaunch.parse(await res.json());
  if (launch.mode !== "fair_open") throw new Error("expected a Fair Open");
  return launch;
}
type Prepared = Awaited<ReturnType<typeof prepared>>;

const refusal = async (res: Response) => ({ status: res.status, ...LaunchRefusal.parse(await res.json()) });
const signed = async (wire: string, wallet: KeyPairSigner) => getBase64EncodedWireTransaction(await partiallySignTransaction([wallet.keyPair], decode(wire)));
let table: Address[] = [];
/** A transaction's instructions, its lookups resolved through Heat's shared table. */
const instructionsOf = (tx: Transaction) =>
  decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes), { addressesByLookupTableAddress: { [devnet.lookupTable!]: table } }).instructions;
const valid = async (tx: Transaction, signer: string) =>
  verifySignature(await getPublicKeyFromAddress(signer as Address), (tx.signatures as Record<string, SignatureBytes>)[signer]!, tx.messageBytes);

/** Submits a prepared Fair Open signed by the wallet: the schedule, and the whole ladder unless `atOpen`. */
async function submit(cookie: string, launch: Prepared, wallet: KeyPairSigner, o: { atOpen?: boolean; rungs?: string[] } = {}) {
  const rungs = o.atOpen ? null : (o.rungs ?? (await Promise.all(launch.rungs.map((r) => signed(r.transaction, wallet)))));
  return json(`/launches/${launch.id}/submit`, { transaction: await signed(launch.transaction, wallet), rungs }, cookie);
}

// Each prepare signs a 64-rung ladder, about a second's work.
describe("scheduling a Fair Open", { timeout: 30_000 }, () => {
  it("is offered on the platform with its terms", async () => {
    const platform = Platform.parse(await (await request("/platform")).json());
    expect(platform.launchModes.fairOpen).toBe(true);
    expect(platform.fairOpen).toMatchObject({ potCap: `${POT_CAP}`, windowSeconds: 600, maxAheadSeconds: 604_800, teaserMaxLength: 80 });
    expect(platform.fairOpen!.rungs).toEqual(rungs(POT_CAP).map(String));
  });

  it("prepares the schedule on a nonce our keeper made, and the 64-rung ladder signed by the mint key alone", async () => {
    const cookie = await linkX({ id: "4001", username: "lumen_lab" });
    const wallet = (await testKeypair()).signer;
    const opensIn = nowSeconds() + 3600;
    const launch = await prepared(await prepare(cookie, { wallet: wallet.address, depositsOpenAt: opensIn, minRaise: 500_000_000n }));
    expect(launch.cost).toBe(`${fakes.balance - fakes.balanceAfter}`);
    expect(launch.launch).toBe((await fairOpenAccounts(launch.nonce as Address)).launch);
    expect(launch.opensAt).toBe(new Date((opensIn + 600) * 1000).toISOString());

    // Our keeper made the nonce, holding it, before anything was handed to the creator.
    expect(fakes.sent).toHaveLength(1);
    const nonceTx = fakes.sent[0]!;
    expect(Object.keys(nonceTx.signatures)).toEqual([keeper().signer.address, launch.nonce]);

    // The schedule: the creator pays, our keeper co-signs last; the creator pays the keeper back the nonce's rent.
    const schedule = decode(launch.transaction);
    expect(Object.keys(schedule.signatures)).toEqual([wallet.address, keeper().signer.address]);
    expect(Object.values(schedule.signatures).every((s) => s === null)).toBe(true);
    const create = instructionsOf(schedule).find((i) => i.programAddress === FAIR_OPEN_PROGRAM_ADDRESS)!;
    expect(create.data!.slice(0, 8)).toEqual(CREATE_LAUNCH_DISCRIMINATOR);
    const params = getCreateLaunchInstructionDataDecoder().decode(create.data!);
    const [row] = await db.select().from(launches).where(eq(launches.id, launch.id));
    expect(params).toMatchObject({ depositsOpenAt: BigInt(opensIn), minRaise: 500_000_000n });
    expect(params.identityHash).toEqual(await identityHash({ name: "Lumen", ticker: "LUMEN", uri: row!.metadataUri }));

    // The ladder: 64 rungs, largest first, each the coin's creation on the nonce, signed so far by the mint key alone.
    expect(launch.rungs.map((r) => r.rung)).toEqual(rungs(POT_CAP).map(String));
    for (const r of launch.rungs) {
      const tx = decode(r.transaction);
      // Our keeper pays, so it signs first; the writable mint key comes before the creator, as a compiled message orders them.
      expect(Object.keys(tx.signatures)).toEqual([keeper().signer.address, row!.mint, wallet.address]);
      expect(await valid(tx, row!.mint)).toBe(true);
      expect((tx.signatures as Record<string, SignatureBytes | null>)[wallet.address]).toBeNull();
    }
    const init = instructionsOf(decode(launch.rungs[0]!.transaction)).find((i) => i.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)!;
    const pool = parseInitializeVirtualPoolWithSplTokenInstruction(init as never);
    expect(pool.accounts.creator.address).toBe(wallet.address);
    expect(pool.data.params).toMatchObject({ name: "Lumen", symbol: "LUMEN", uri: row!.metadataUri });

    // The ticker is reserved, the teaser kept, and the coin's metadata waits in R2, not yet on Arweave.
    expect(row).toMatchObject({ mode: "fair_open", status: "prepared", tickerKey: "LUMEN", teaser: "The first coin with a heartbeat", fairOpen: launch.launch });
    expect(await db.select().from(fairOpenRungs).where(eq(fairOpenRungs.launchId, launch.id))).toHaveLength(64);
    expect(blobs.objects.has(`launches/${launch.id}/metadata`)).toBe(true);
    expect(fakes.uploads).toHaveLength(0);
  });

  it("refuses a window in the past or more than 7 days ahead, and a minimum raise above the pot's cap", async () => {
    const cookie = await linkX({ id: "4002", username: "rules" });
    const wallet = (await testKeypair()).signer.address;
    expect(await refusal(await prepare(cookie, { wallet, depositsOpenAt: nowSeconds() - 600 }))).toMatchObject({ status: 422, code: "schedule" });
    expect(await refusal(await prepare(cookie, { wallet, depositsOpenAt: nowSeconds() + 8 * 86_400 }))).toMatchObject({ status: 422, code: "schedule" });
    expect(await refusal(await prepare(cookie, { wallet, minRaise: POT_CAP + 1n }))).toMatchObject({ status: 422, code: "schedule" });
    expect(fakes.sent).toHaveLength(0);
  });

  it("refuses a teaser with a link or a cashtag, or one that names a Protected coin", async () => {
    const cookie = await linkX({ id: "4003", username: "teaser" });
    const wallet = (await testKeypair()).signer.address;
    expect(await refusal(await prepare(cookie, { wallet, teaser: "join t.me/lumen" }))).toMatchObject({ status: 422, code: "teaser" });
    expect(await refusal(await prepare(cookie, { wallet, teaser: "better than $WIF" }))).toMatchObject({ status: 422, code: "teaser" });
    const keys = candidateKeys("BONK", "Bonk Inu");
    await db.insert(protectedCoins).values({
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      ticker: "BONK",
      name: "Bonk Inu",
      source: "jupiter_verified",
      tickerStrict: keys.ticker.strict,
      tickerLoose: keys.ticker.loose,
      tickerCore: keys.ticker.core,
      nameStrict: keys.name.strict,
      nameLoose: keys.name.loose,
      nameCore: keys.name.core,
      foldVersion: FOLD_VERSION,
    });
    try {
      for (const teaser of ["the next Bonk Inu", "bigger than b0nk", "a BONK killer"]) {
        expect(await refusal(await prepare(cookie, { wallet, teaser })), teaser).toMatchObject({ status: 422, code: "teaser" });
      }
      // Ordinary words still pass.
      expect((await prepare(cookie, { wallet, ticker: "TEASE", teaser: "the bonfire of the season" })).status).toBe(201);
    } finally {
      await db.delete(protectedCoins);
    }
  });

  it("reserves the ticker's strict key: a second Fair Open of it is refused until the first is released", async () => {
    const first = await linkX({ id: "4004", username: "first" });
    const second = await linkX({ id: "4005", username: "second" });
    const launch = await prepared(await prepare(first, { ticker: "GLOW", wallet: (await testKeypair()).signer.address }));
    const other = (await testKeypair()).signer.address;
    expect(await refusal(await prepare(second, { ticker: "GLOW", wallet: other }))).toMatchObject({ status: 409, code: "ticker_reserved" });
    // The strict key folds lookalikes together (UTS #39): a zero for the O is not another ticker.
    expect(await refusal(await prepare(second, { ticker: "GL0W", wallet: other }))).toMatchObject({ status: 409, code: "ticker_reserved" });
    expect(fakes.sent).toHaveLength(1);

    // The database refuses a second holder even when the check before it raced: the partial unique index.
    const [row] = await db.select().from(launches).where(eq(launches.id, launch.id));
    await expect(db.insert(launches).values({ ...row!, id: crypto.randomUUID(), mint: "m", pool: "p", fairOpen: "f", nonce: "n", signature: null })).rejects.toThrow();

    // A launch that fails releases its key.
    await db.update(launches).set({ status: "failed", tickerKey: null }).where(eq(launches.id, launch.id));
    expect((await prepare(second, { ticker: "GLOW", wallet: other })).status).toBe(201);
  });

  it("is signed in one approval and sent with our keeper's signatures on the schedule and every rung, then kept by its Workflow", async () => {
    const cookie = await linkX({ id: "4006", username: "kettle" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "KETTLE", name: "Kettle", wallet: wallet.address }));
    const res = await submit(cookie, launch, wallet);
    expect(res.status, await res.clone().text()).toBe(200);
    const status = LaunchStatus.parse(await res.json());
    expect(status).toMatchObject({ mode: "fair_open", status: "landed", fairOpen: { launch: launch.launch, ladder: "signed", teaser: "The first coin with a heartbeat" } });

    const schedule = fakes.sent.at(-1)!;
    expect(await valid(schedule, wallet.address)).toBe(true);
    expect(await valid(schedule, keeper().signer.address)).toBe(true);
    const stored = await db.select().from(fairOpenRungs).where(eq(fairOpenRungs.launchId, launch.id));
    expect(stored.every((r) => r.creatorSignature && r.keeperSignature)).toBe(true);
    // Every rung is now complete: our keeper only broadcasts at the open.
    const { wireOf } = await import("./rungs");
    const [row] = await db.select().from(launches).where(eq(launches.id, launch.id));
    for (const r of stored.slice(0, 3)) {
      const tx = decode(wireOf(r, { keeper: keeper().signer.address, creator: wallet.address, mint: row!.mint }));
      for (const signer of Object.keys(tx.signatures)) expect(await valid(tx, signer)).toBe(true);
    }
    // The wallet became the record's Creator wallet; the Workflow and the indexer were asked to keep it.
    expect(await db.select().from(creatorWallets).where(eq(creatorWallets.wallet, wallet.address))).toHaveLength(1);
    await settle();
    expect(started).toContain(launch.launch);
    expect(indexedNow).toContain(status.signature);
  });

  it("refuses a ladder whose rung is not the one prepared", async () => {
    const cookie = await linkX({ id: "4007", username: "tamper" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "TAMPER", wallet: wallet.address }));
    const rungs = await Promise.all(launch.rungs.map((r) => signed(r.transaction, wallet)));
    [rungs[0], rungs[1]] = [rungs[1]!, rungs[0]!];
    expect(await refusal(await submit(cookie, launch, wallet, { rungs }))).toMatchObject({ status: 400, code: "transaction_changed" });
    expect(await refusal(await submit(cookie, launch, wallet, { rungs: rungs.slice(0, 10) }))).toMatchObject({ status: 400, code: "invalid" });
    expect(fakes.sent).toHaveLength(1);
  });

  it("can leave the open to be signed at the open, by a wallet that cannot sign a batch", async () => {
    const cookie = await linkX({ id: "4008", username: "single" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "SINGLE", wallet: wallet.address }));
    const status = LaunchStatus.parse(await (await submit(cookie, launch, wallet, { atOpen: true })).json());
    expect(status.fairOpen).toMatchObject({ ladder: "at_open" });
    const stored = await db.select().from(fairOpenRungs).where(and(eq(fairOpenRungs.launchId, launch.id), isNotNull(fairOpenRungs.creatorSignature)));
    expect(stored).toHaveLength(0);
  });

  it("renews a schedule whose signing window closed, keeping the ladder", async () => {
    const cookie = await linkX({ id: "4009", username: "slow" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "SLOW", wallet: wallet.address }));
    const rungs = await Promise.all(launch.rungs.map((r) => signed(r.transaction, wallet)));
    fakes.blockHeight = fakes.lastValidBlockHeight + 1n;
    expect(await refusal(await submit(cookie, launch, wallet, { rungs }))).toMatchObject({ status: 410, code: "expired" });

    fakes.lastValidBlockHeight += 1_000n;
    const renewed = PreparedLaunch.parse(await (await json(`/launches/${launch.id}/renew`, {}, cookie)).json());
    if (renewed.mode !== "fair_open") throw new Error("expected a Fair Open");
    expect(renewed.transaction).not.toBe(launch.transaction);
    expect(renewed.rungs.map((r) => r.rung)).toEqual(launch.rungs.map((r) => r.rung));
    const res = await submit(cookie, renewed, wallet, { rungs });
    expect(LaunchStatus.parse(await res.json()).status).toBe("landed");
  });
});

describe("signing the open at the open", { timeout: 30_000 }, () => {
  /** A scheduled Fair Open signed at the open, with its launch account on chain `ago` seconds into its window. */
  async function scheduledAtOpen(ago: bigint, asks: [number, Tier][]) {
    const cookie = await linkX({ id: `${4100 + Math.floor(Math.random() * 800)}`, username: "late_signer" });
    const wallet = (await testKeypair()).signer;
    const ticker = `L${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const launch = await prepared(await prepare(cookie, { ticker, wallet: wallet.address }));
    await submit(cookie, launch, wallet, { atOpen: true });
    const depositsOpenAt = BigInt(nowSeconds()) - ago;
    fakes.accounts.set(launch.launch, fairOpenLaunch({ creator: wallet.address, nonce: launch.nonce as Address, depositsOpenAt, asks }));
    return { launch, wallet };
  }

  it("hands the Creator wallet the rung the pot covers once the window has closed, and our keeper co-signs and sends it", async () => {
    const asks: [number, Tier][] = [[60, Tier.Verified], [10, Tier.Unverified]];
    const { launch, wallet } = await scheduledAtOpen(605n, asks);
    const page = FairOpen.parse(await (await request(`/fair-opens/${launch.launch}`)).json());
    expect(page.ladder).toBe("at_open");

    const prepared = PreparedFairOpenTransaction.parse(await (await json(`/fair-opens/${launch.launch}/open`, { wallet: wallet.address })).json());
    const rung = rungAtOrBelow(POT_CAP, 700_000_000n)!;
    expect(prepared.transaction).toBe(launch.rungs.find((r) => r.rung === `${rung}`)!.transaction);

    const before = fakes.sent.length;
    const outcome = FairOpenOutcome.parse(await (await json(`/fair-opens/${launch.launch}/open/submit`, { transaction: await signed(prepared.transaction, wallet) })).json());
    expect(outcome.status).toBe("landed");
    const sent = fakes.sent.slice(before);
    expect(sent).toHaveLength(1);
    for (const signer of Object.keys(sent[0]!.signatures)) expect(await valid(sent[0]!, signer)).toBe(true);
    expect(FairOpen.parse(await (await request(`/fair-opens/${launch.launch}`)).json()).ladder).toBe("at_open_signed");
    expect(FairOpenRefusal.parse(await (await json(`/fair-opens/${launch.launch}/open`, { wallet: wallet.address })).json()).code).toBe("already_signed");
  });

  it("refuses before the window closes, and refuses any wallet but the creator's", async () => {
    const { launch, wallet } = await scheduledAtOpen(60n, [[60, Tier.Verified]]);
    expect(FairOpenRefusal.parse(await (await json(`/fair-opens/${launch.launch}/open`, { wallet: wallet.address })).json()).code).toBe("not_due");
    fakes.accounts.set(launch.launch, fairOpenLaunch({ creator: wallet.address, nonce: launch.nonce as Address, depositsOpenAt: BigInt(nowSeconds()) - 605n, asks: [[60, Tier.Verified]] }));
    const someone = (await testKeypair()).signer.address;
    expect(FairOpenRefusal.parse(await (await json(`/fair-opens/${launch.launch}/open`, { wallet: someone })).json()).code).toBe("not_the_creator");
  });
});

describe("the calendar's teaser", () => {
  it("reaches the Fair Open's page from the schedule", async () => {
    const cookie = await linkX({ id: "4010", username: "calendar" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "CAL", wallet: wallet.address, teaser: "Ten minutes, one price" }));
    await submit(cookie, launch, wallet);
    fakes.accounts.set(launch.launch, fairOpenLaunch({ creator: wallet.address, nonce: launch.nonce as Address, depositsOpenAt: BigInt(nowSeconds()) + 600n }));
    const page = FairOpen.parse(await (await request(`/fair-opens/${launch.launch}`)).json());
    expect(page).toMatchObject({ teaser: "Ten minutes, one price", ladder: "signed" });
  });
});
