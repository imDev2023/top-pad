import {
  decompileTransactionMessage,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type SignatureBytes,
} from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admissionMessage, ED25519_PROGRAM_ADDRESS, FAIR_OPEN_PROGRAM_ADDRESS, fairOpenAccounts, seatAddress, Tier } from "@top-pad/chain";
import { DEPOSIT_DISCRIMINATOR, getDepositInstructionDataDecoder, MARK_FAILED_DISCRIMINATOR, WITHDRAW_FAILED_DISCRIMINATOR } from "@top-pad/clients/fair-open";
import { FairOpen, FairOpenRefusal, PreparedFairOpenTransaction } from "@top-pad/contract";
import { admissions, createDb, creators, creatorWallets, fairOpens, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import { decode, Fakes, fairOpenLaunch, fairOpenSeat, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";
import type { Bindings } from "./env";

// The admission key the cluster records is swapped for a test key: the real one lives only in Secrets Store (spec 10.3).
vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { testKeypair } = await import("./test/fakes");
  const admission = await testKeypair();
  (globalThis as { __testAdmission?: typeof admission }).__testAdmission = admission;
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, admission: admission.signer.address } } } };
});
const admissionKey = () => (globalThis as { __testAdmission?: Awaited<ReturnType<typeof testKeypair>> }).__testAdmission!;

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
let indexedNow: string[];
beforeEach(async () => {
  fakes = new Fakes();
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
  for (const table of [admissions, fairOpens, creatorWallets]) await db.delete(table);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = {
  idFromName: () => "indexer",
  get: () => ({ indexNow: async (signatures: string[]) => void indexedNow.push(...signatures) }),
} as unknown as Bindings["INDEXER"];
const bindings = () => testBindings(url, { ADMISSION_KEY: { get: async () => JSON.stringify(Array.from(admissionKey().secret)) }, INDEXER: indexer });
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);
const post = (path: string, body: unknown, cookie?: string) =>
  request(path, {
    method: "POST",
    headers: { origin: ORIGINS.web, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));
const STEP = 10_000_000n;

/** A launch on chain whose window opened `ago` seconds ago, with the seats `asks` counts. */
async function launchOnChain(o: { ago: bigint; minRaise?: bigint; asks?: [number, Tier][]; failure?: number; creator?: Address } = { ago: 60n }) {
  const nonce = random();
  const creator = o.creator ?? random();
  const { launch } = await fairOpenAccounts(nonce);
  fakes.accounts.set(launch, fairOpenLaunch({ creator, nonce, depositsOpenAt: nowSeconds() - o.ago, minRaise: o.minRaise, asks: o.asks, failure: o.failure }));
  return { launch, creator };
}

/** A browser that linked X as `user`. */
async function linkX(user: { id: string; username: string }) {
  fakes.xUser = { ...user, name: user.username };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  return res.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
}

async function view(launch: string, wallet?: string, cookie?: string) {
  const res = await request(`/fair-opens/${launch}${wallet ? `?wallet=${wallet}` : ""}`, cookie ? { headers: { cookie } } : {});
  expect(res.status).toBe(200);
  return FairOpen.parse(await res.json());
}

async function prepared(res: Response) {
  expect(res.status, await res.clone().text()).toBe(200);
  const body = PreparedFairOpenTransaction.parse(await res.json());
  const tx = decode(body.transaction);
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  return { body, message };
}

async function refusal(res: Response) {
  return { status: res.status, ...FairOpenRefusal.parse(await res.json()) };
}

describe("a Fair Open's page", () => {
  it("reads the pot from the launch account, with what it would buy if the window closed now", async () => {
    // 1.8 SOL asked of a 1.7 SOL pot: the two Verified seats of 0.6 SOL are cut to 0.55 each, the rest filled.
    const { launch } = await launchOnChain({ ago: 60n, asks: [[60, Tier.Verified], [60, Tier.Verified], [50, Tier.Scored], [10, Tier.Unverified]] });
    const page = await view(launch);
    expect(page).toMatchObject({
      launch,
      phase: "window",
      failure: null,
      quote: { symbol: "SOL", decimals: 9 },
      potCap: "1700000000",
      tierCaps: { unverified: "100000000", scored: "500000000", verified: "2000000000" },
      pot: { total: "1800000000", seats: 4, unverified: "100000000", scored: "500000000", verified: "1200000000" },
      allocation: { spend: "1700000000", others: { level: "550000000", limited: true }, rung: "1700000000" },
      rent: { seat: `${(178 + 128) * 6960}`, coinAccount: `${(165 + 128) * 6960}` },
      you: null,
    });
    expect(Date.parse(page.lateAt) - Date.parse(page.opensAt)).toBe(15 * 60_000);
  });

  it("knows a wallet with no linked X as Unverified, and shows its seat's fill and refund", async () => {
    const { launch } = await launchOnChain({ ago: 60n, asks: [[200, Tier.Verified], [10, Tier.Unverified]] });
    const wallet = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    const seat = await seatAddress(launch, person);
    fakes.accounts.set(seat, fairOpenSeat({ launch, wallet, person, tier: Tier.Unverified, deposit: 10n * STEP }));
    const page = await view(launch, wallet);
    expect(page.you).toEqual({
      wallet,
      admission: { admitted: true, tier: "unverified", cap: "100000000", via: "none", handle: null },
      // 2.1 SOL asked of a 1.7 SOL pot: the Unverified seat's 0.1 SOL fills, within a quarter of the spend.
      seat: { address: seat, tier: "unverified", cap: "100000000", deposit: "100000000", seatRent: "2000000", coinRent: "2039280", fill: "100000000", refund: "0" },
    });
  });

  it("knows a linked X account as Scored", async () => {
    const { launch } = await launchOnChain();
    const cookie = await linkX({ id: "7001", username: "depositor_one" });
    const page = await view(launch, random(), cookie);
    expect(page.you!.admission).toEqual({ admitted: true, tier: "scored", cap: "500000000", via: "x", handle: "depositor_one" });
  });

  it("says when a closed launch's every seat came back", async () => {
    const launch = random();
    await db.insert(fairOpens).values({
      launch,
      creator: random(),
      nonce: random(),
      dbcConfig: random(),
      quoteMint: random(),
      identityHash: "ab".repeat(32),
      depositsOpenAt: new Date(Date.now() - 3_600_000),
      opensAt: new Date(Date.now() - 3_000_000),
      minRaise: 0n,
      potCap: 1_700_000_000n,
      lowestRung: 67_148_451n,
      step: STEP,
      status: "closed",
      failure: "late",
      createdSignature: "created",
      createdSlot: 1,
      createdAt: new Date(),
    });
    expect(await view(launch)).toMatchObject({ phase: "closed", failure: "late", pot: { total: "0", seats: 0 } });
  });

  it("answers 404 for an address with no Fair Open", async () => {
    expect((await request(`/fair-opens/${random()}`)).status).toBe(404);
  });
});

describe("a deposit", () => {
  it("carries the admission our server signed, right before the program's deposit", async () => {
    const { launch } = await launchOnChain();
    const wallet = random();
    const { body, message } = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${5n * STEP}` }));
    expect(body.admission).toEqual({ tier: "unverified", cap: "100000000" });
    expect(message.feePayer.address).toBe(wallet);
    const at = message.instructions.findIndex((ix) => ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS);
    const precompile = message.instructions[at - 1]!;
    expect(precompile.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    const deposit = getDepositInstructionDataDecoder().decode(message.instructions[at]!.data!);
    expect(deposit.discriminator).toEqual(DEPOSIT_DISCRIMINATOR);
    expect(deposit).toMatchObject({ amount: 5n * STEP, tier: Tier.Unverified, cap: 10n * STEP });

    // The precompile's message is the one the program rebuilds, and the admission key signed it.
    const data = precompile.data!;
    const signed = admissionMessage(launch, wallet, { person: deposit.person, tier: deposit.tier, cap: deposit.cap, expiresAt: deposit.expiresAt });
    expect(data.slice(112)).toEqual(signed);
    const key = await getPublicKeyFromAddress(admissionKey().signer.address);
    expect(await verifySignature(key, data.slice(48, 112) as SignatureBytes, signed)).toBe(true);
    expect(deposit.expiresAt - nowSeconds()).toBeGreaterThan(100n);
  });

  it("gives a wallet the same person every time, and a higher tier once it links X", async () => {
    const { launch } = await launchOnChain();
    const wallet = random();
    const first = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }));
    const cookie = await linkX({ id: "7002", username: "depositor_two" });
    const second = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }, cookie));
    const person = (m: typeof first.message) => getDepositInstructionDataDecoder().decode(m.instructions.at(-1)!.data!).person;
    expect(person(second.message)).toEqual(person(first.message));
    expect(second.body.admission).toEqual({ tier: "scored", cap: "500000000" });
    // In another launch the same person has another pseudonym, so the chain cannot link their wallets.
    const other = await launchOnChain();
    const elsewhere = await prepared(await post(`/fair-opens/${other.launch}/deposit`, { wallet, amount: `${STEP}` }, cookie));
    expect(person(elsewhere.message)).not.toEqual(person(first.message));
  });

  it("refuses a person's second wallet while their first holds a seat", async () => {
    const { launch } = await launchOnChain();
    const cookie = await linkX({ id: "7003", username: "depositor_three" });
    const [first, second] = [random(), random()];
    const one = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: first, amount: `${STEP}` }, cookie));
    // Before the first deposit lands the person may still move to another wallet; once it has, they may not.
    const person = getDepositInstructionDataDecoder().decode(one.message.instructions.at(-1)!.data!).person;
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet: first, person: new Uint8Array(person), tier: Tier.Scored, deposit: STEP }));
    const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: second, amount: `${STEP}` }, cookie));
    expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
    expect(refused.error).toContain("one person, one seat, one wallet");
    expect((await view(launch, second, cookie)).you!.admission).toMatchObject({ admitted: false });
  });

  it("lets a person move to another wallet once their first holds no seat", async () => {
    const { launch } = await launchOnChain();
    const cookie = await linkX({ id: "7004", username: "depositor_four" });
    await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: random(), amount: `${STEP}` }, cookie));
    await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: random(), amount: `${STEP}` }, cookie));
  });

  it("refuses the creator's own X account through any wallet but the Creator wallet", async () => {
    const creatorWallet = random();
    const cookie = await linkX({ id: "7005", username: "the_creator_itself" });
    const [creator] = await db.select().from(creators).where((await import("drizzle-orm")).eq(creators.xUserId, "7005"));
    await db.insert(creatorWallets).values({ creatorId: creator!.id, wallet: creatorWallet, via: "first_launch", proof: "proof" });
    const { launch } = await launchOnChain({ ago: 60n, creator: creatorWallet });
    const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: random(), amount: `${STEP}` }, cookie));
    expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
    // The Creator wallet itself deposits, Scored by its record's X account, signed in or not.
    const own = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: creatorWallet, amount: `${STEP}` }));
    expect(own.body.admission).toEqual({ tier: "scored", cap: "500000000" });
  });

  it("refuses an amount off the step, over the cap, or outside the window", async () => {
    const { launch } = await launchOnChain();
    const wallet = random();
    expect(await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP + 1n}` }))).toMatchObject({ status: 400, code: "invalid" });
    expect(await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${11n * STEP}` }))).toMatchObject({ status: 409, code: "over_cap" });
    const early = await launchOnChain({ ago: -300n });
    expect(await refusal(await post(`/fair-opens/${early.launch}/deposit`, { wallet, amount: `${STEP}` }))).toMatchObject({ status: 409, code: "window" });
    const late = await launchOnChain({ ago: 601n });
    expect(await refusal(await post(`/fair-opens/${late.launch}/deposit`, { wallet, amount: `${STEP}` }))).toMatchObject({ status: 409, code: "window" });
  });
});

describe("the failure path", () => {
  it("refuses to mark a launch failed while its pot can still open", async () => {
    const { launch } = await launchOnChain({ ago: 700n, asks: [[50, Tier.Scored], [50, Tier.Scored]] });
    expect(await refusal(await post(`/fair-opens/${launch}/mark-failed`, { wallet: random() }))).toMatchObject({ status: 409, code: "cannot_fail" });
  });

  it("marks a late launch failed, and returns the sender's own seat in the same transaction", async () => {
    const { launch } = await launchOnChain({ ago: 600n + 900n, asks: [[50, Tier.Scored]] });
    const wallet = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet, person, tier: Tier.Scored, deposit: 50n * STEP }));
    const { message } = await prepared(await post(`/fair-opens/${launch}/mark-failed`, { wallet }));
    const ours = message.instructions.filter((ix) => ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS).map((ix) => ix.data!.slice(0, 8));
    expect(ours).toEqual([MARK_FAILED_DISCRIMINATOR, WITHDRAW_FAILED_DISCRIMINATOR]);
    // A stranger with no seat only marks it.
    const stranger = await prepared(await post(`/fair-opens/${launch}/mark-failed`, { wallet: random() }));
    expect(stranger.message.instructions.filter((ix) => ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS)).toHaveLength(1);
  });

  it("marks a launch failed at once when its pot misses the minimum raise", async () => {
    const { launch } = await launchOnChain({ ago: 601n, minRaise: 1_000_000_000n, asks: [[50, Tier.Scored]] });
    expect((await view(launch)).phase).toBe("failing");
    await prepared(await post(`/fair-opens/${launch}/mark-failed`, { wallet: random() }));
  });

  it("returns a seat once the launch has failed, and not before", async () => {
    const wallet = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    const open = await launchOnChain({ ago: 60n, asks: [[50, Tier.Scored]] });
    fakes.accounts.set(await seatAddress(open.launch, person), fairOpenSeat({ launch: open.launch, wallet, person, tier: Tier.Scored, deposit: 50n * STEP }));
    expect(await refusal(await post(`/fair-opens/${open.launch}/refund`, { wallet }))).toMatchObject({ status: 409, code: "not_failed" });

    const failed = await launchOnChain({ ago: 2_000n, asks: [[50, Tier.Scored]], failure: 2 });
    fakes.accounts.set(await seatAddress(failed.launch, person), fairOpenSeat({ launch: failed.launch, wallet, person, tier: Tier.Scored, deposit: 50n * STEP }));
    expect(await view(failed.launch)).toMatchObject({ phase: "failed", failure: "late" });
    const { message } = await prepared(await post(`/fair-opens/${failed.launch}/refund`, { wallet }));
    expect(message.instructions.at(-1)!.data!.slice(0, 8)).toEqual(WITHDRAW_FAILED_DISCRIMINATOR);
    expect(await refusal(await post(`/fair-opens/${failed.launch}/refund`, { wallet: random() }))).toMatchObject({ status: 404, code: "no_seat" });
  });
});

describe("a sent transaction", () => {
  it("is settled against the chain and handed to the indexer", async () => {
    const signature = "5".repeat(88);
    const res = await post("/fair-opens/transactions", { signature });
    expect(await res.json()).toMatchObject({ signature, status: "landed", error: null });
    await settle();
    expect(indexedNow).toEqual([signature]);
  });
});
