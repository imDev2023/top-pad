import {
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  signBytes,
  verifySignature,
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
} from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admissionMessage, ED25519_PROGRAM_ADDRESS, FAIR_OPEN_PROGRAM_ADDRESS, fairOpenAccounts, seatAddress, seatOutcome, Tier } from "@top-pad/chain";
import { CLAIM_DISCRIMINATOR, DEPOSIT_DISCRIMINATOR, getDepositInstructionDataDecoder, MARK_FAILED_DISCRIMINATOR, WITHDRAW_FAILED_DISCRIMINATOR } from "@top-pad/clients/fair-open";
import { FairOpen, FairOpenRefusal, PreparedFairOpenTransaction, VerifiedWallet, VerifyMessage, VerifyRefusal } from "@top-pad/contract";
import { admissionReviews, admissions, createDb, creators, creatorWallets, fairOpens, fairOpenSeatEvents, linkageHubs, pools, walletFundings, walletVerifications, type Db } from "@top-pad/db";
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
  for (const table of [admissions, admissionReviews, walletVerifications, walletFundings, linkageHubs, fairOpenSeatEvents, fairOpens, creatorWallets, pools]) await db.delete(table);
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
async function launchOnChain(
  o: { ago: bigint; minRaise?: bigint; asks?: [number, Tier][]; failure?: number; creator?: Address; opened?: Parameters<typeof fairOpenLaunch>[0]["opened"] } = { ago: 60n },
) {
  const nonce = random();
  const creator = o.creator ?? random();
  const { launch } = await fairOpenAccounts(nonce);
  fakes.accounts.set(launch, fairOpenLaunch({ creator, nonce, depositsOpenAt: nowSeconds() - o.ago, minRaise: o.minRaise, asks: o.asks, failure: o.failure, opened: o.opened }));
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

/** Verifies a wallet once for the X account `cookie`'s browser linked, the wallet signing Heat's message: its address. */
async function verified(cookie: string, signer?: KeyPairSigner) {
  signer ??= await generateKeyPairSigner();
  const asked = await post("/verify/message", { wallet: signer.address }, cookie);
  expect(asked.status, await asked.clone().text()).toBe(200);
  const { message } = VerifyMessage.parse(await asked.json());
  const signature = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message));
  const res = await post("/verify", { wallet: signer.address, message, signature: Buffer.from(signature).toString("base64") }, cookie);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(VerifiedWallet.parse(await res.json())).toMatchObject({ wallet: signer.address, tier: "scored" });
  return signer.address;
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
      // A seat's rent and a coin account's, 0.00155 and 0.00149 SOL, as devnet charged them on 2026-10-30.
      rent: { seat: "1554480", coinAccount: "1488440" },
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
      admission: { admitted: true, tier: "unverified", cap: "100000000", via: "none", handle: null, linked: null },
      // 2.1 SOL asked of a 1.7 SOL pot: the Unverified seat's 0.1 SOL fills, within a quarter of the spend.
      seat: {
        address: seat,
        tier: "unverified",
        cap: "100000000",
        deposit: "100000000",
        seatRent: "2000000",
        coinRent: "2039280",
        fill: "100000000",
        refund: "0",
        coins: null,
        delivered: false,
        taxShare: null,
        closed: false,
      },
    });
  });

  it("knows a wallet verified once for a linked X account as Scored, signed in or not", async () => {
    const { launch } = await launchOnChain();
    const cookie = await linkX({ id: "7001", username: "depositor_one" });
    // Linking X alone proves nothing about a wallet: until the wallet signs for it, it is Unverified.
    const signer = await generateKeyPairSigner();
    expect((await view(launch, signer.address, cookie)).you!.admission).toMatchObject({ admitted: true, tier: "unverified", via: "none" });
    const wallet = await verified(cookie, signer);
    const scored = { admitted: true, tier: "scored", cap: "500000000", via: "x", handle: "depositor_one", linked: null };
    expect((await view(launch, wallet, cookie)).you!.admission).toEqual(scored);
    expect((await view(launch, wallet)).you!.admission).toEqual(scored);
  });

  it("says when a closed launch's every seat came back", async () => {
    const launch = random();
    await db.insert(fairOpens).values({
      launch,
      creator: random(),
      nonce: random(),
      dbcConfig: random(),
      quoteMint: "So11111111111111111111111111111111111111112",
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

  it("tells a done launch, its account closed, from the indexer: the open, the Creator lock, the Tax Share and a closed seat", async () => {
    const [launch, creator, mint, pool, wallet] = [random(), random(), random(), random(), random()];
    const escrow = random();
    const opensAt = new Date(Date.now() - 3_000_000);
    await db.insert(fairOpens).values({
      launch,
      creator,
      nonce: random(),
      dbcConfig: random(),
      quoteMint: "So11111111111111111111111111111111111111112",
      identityHash: "ab".repeat(32),
      depositsOpenAt: new Date(opensAt.getTime() - 600_000),
      opensAt,
      minRaise: 0n,
      potCap: 1_700_000_000n,
      lowestRung: 67_148_451n,
      step: STEP,
      status: "opened",
      mint,
      pool,
      spent: 1_615_000_000n,
      coins: 300_000_000_000_000n,
      seats: 2,
      openedAt: opensAt,
      lockEscrow: escrow,
      lockCoins: 50_000_000_000n,
      lockCliffAt: new Date(opensAt.getTime() + 7 * 86_400_000),
      lockEndsAt: new Date(opensAt.getTime() + 30 * 86_400_000),
      lockedAt: opensAt,
      lockSignature: "lock",
      taxShare: 990_007n,
      taxShareFees: 990_000n,
      taxShareDust: 7n,
      taxShareBasis: 1_000_000_000n,
      taxShareToTreasury: false,
      taxShareCollectedAt: new Date(opensAt.getTime() + 61_000),
      taxShareSignature: "collect",
      closedAt: new Date(opensAt.getTime() + 90_000),
      createdSignature: "created",
      createdSlot: 1,
      createdAt: new Date(),
    });
    const person = "cd".repeat(32);
    const event = (n: number, kind: "deposit" | "delivery" | "lock" | "tax_share", who: string, amount: bigint, deposit: bigint, more = {}) => ({
      signature: `sig${n}`,
      eventIndex: 0,
      slot: n,
      at: new Date(),
      launch,
      wallet: who,
      person: who === wallet ? person : "ef".repeat(32),
      kind,
      tier: kind === "deposit" ? ("verified" as const) : null,
      amount,
      deposit,
      ...more,
    });
    await db.insert(fairOpenSeatEvents).values([
      event(1, "deposit", wallet, 1_000_000_000n, 1_000_000_000n),
      event(2, "deposit", creator, 300_000_000n, 300_000_000n),
      event(3, "delivery", wallet, 50_000_000n, 1_000_000_000n, { spent: 950_000_000n, coins: 200_000_000_000_000n, rent: 0n }),
      event(4, "lock", creator, 15_000_000n, 300_000_000n, { spent: 285_000_000n, coins: 50_000_000_000n, rent: 2_000_000n }),
      event(5, "tax_share", wallet, 990_007n, 1_000_000_000n, { spent: 950_000_000n, rent: 2_000_000n }),
    ]);
    const page = await view(launch, wallet);
    expect(page.phase).toBe("opened");
    expect(page.open).toMatchObject({
      mint,
      pool,
      seats: 2,
      delivered: 2,
      deposited: "1300000000",
      closed: true,
      lock: { status: "locked", deposit: "300000000", coins: "50000000000", escrow },
      taxShare: { total: "990007", fees: "990000", dust: "7", toTreasury: false, paidSeats: 1, paid: "990007" },
    });
    expect(page.you!.seat).toMatchObject({ deposit: "1000000000", fill: "950000000", refund: "50000000", coins: "200000000000000", taxShare: "990007", closed: true });
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

  it("gives a wallet the same person every time, and a higher tier once it is verified", async () => {
    const { launch } = await launchOnChain();
    const signer = await generateKeyPairSigner();
    const wallet = signer.address;
    const first = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }));
    const cookie = await linkX({ id: "7002", username: "depositor_two" });
    await verified(cookie, signer);
    const second = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }));
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
    const [first, second] = [await verified(cookie), await verified(cookie)];
    const one = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: first, amount: `${STEP}` }));
    // Before the first deposit lands the person may still move to another wallet; once it has, they may not.
    const person = getDepositInstructionDataDecoder().decode(one.message.instructions.at(-1)!.data!).person;
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet: first, person: new Uint8Array(person), tier: Tier.Scored, deposit: STEP }));
    const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: second, amount: `${STEP}` }));
    expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
    expect(refused.error).toContain("one person, one seat, one wallet");
    expect((await view(launch, second)).you!.admission).toMatchObject({ admitted: false });
    // A person's own second wallet is no case for the operator queue.
    expect(await db.select().from(admissionReviews)).toEqual([]);
  });

  it("lets a person move to another wallet once their first holds no seat", async () => {
    const { launch } = await launchOnChain();
    const cookie = await linkX({ id: "7004", username: "depositor_four" });
    await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: await verified(cookie), amount: `${STEP}` }));
    await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: await verified(cookie), amount: `${STEP}` }));
  });

  it("refuses the creator's own X account through any wallet but the Creator wallet", async () => {
    const creatorWallet = random();
    const cookie = await linkX({ id: "7005", username: "the_creator_itself" });
    const [creator] = await db.select().from(creators).where((await import("drizzle-orm")).eq(creators.xUserId, "7005"));
    await db.insert(creatorWallets).values({ creatorId: creator!.id, wallet: creatorWallet, via: "first_launch", proof: "proof" });
    const { launch } = await launchOnChain({ ago: 60n, creator: creatorWallet });
    const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: await verified(cookie), amount: `${STEP}` }));
    expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
    expect(refused.error).toContain("creator's own X account");
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

describe("verifying a wallet once", () => {
  it("refuses a browser with no X account linked, a message not Heat's, a stale one, and a signature not the wallet's", async () => {
    const signer = await generateKeyPairSigner();
    expect(VerifyRefusal.parse(await (await post("/verify/message", { wallet: signer.address })).json())).toMatchObject({ code: "signed_out" });
    const cookie = await linkX({ id: "7101", username: "verifier" });
    const { message } = VerifyMessage.parse(await (await post("/verify/message", { wallet: signer.address }, cookie)).json());
    expect(message).toContain(`Wallet: ${signer.address}\nX account: @verifier`);
    const sign = async (text: string, by = signer) => Buffer.from(await signBytes(by.keyPair.privateKey, new TextEncoder().encode(text))).toString("base64");
    const attempt = async (text: string, signature: string) => {
      const res = await post("/verify", { wallet: signer.address, message: text, signature }, cookie);
      return { status: res.status, ...(res.status === 200 ? {} : VerifyRefusal.parse(await res.json())) };
    };
    // Another wallet's signature, a message edited after it was given, and one issued an hour ago.
    expect(await attempt(message, await sign(message, await generateKeyPairSigner()))).toMatchObject({ status: 400, code: "invalid" });
    const edited = message.replace("@verifier", "@someone_else");
    expect(await attempt(edited, await sign(edited))).toMatchObject({ status: 400, code: "invalid" });
    const stale = message.replace(/Issued: .*/, `Issued: ${new Date(Date.now() - 3_600_000).toISOString()}`);
    expect(await attempt(stale, await sign(stale))).toMatchObject({ status: 400, code: "invalid" });
    expect(await db.select().from(walletVerifications)).toEqual([]);
    expect(await attempt(message, await sign(message))).toMatchObject({ status: 200 });
    // Again is fine; verified, the wallet belongs to that person.
    expect(await attempt(message, await sign(message))).toMatchObject({ status: 200 });
    expect(await db.select({ wallet: walletVerifications.wallet }).from(walletVerifications)).toEqual([{ wallet: signer.address }]);
  });

  it("refuses a wallet already another person's: verified for another X account, or another record's Creator wallet", async () => {
    const first = await linkX({ id: "7102", username: "first_person" });
    const signer = await generateKeyPairSigner();
    await verified(first, signer);
    const second = await linkX({ id: "7103", username: "second_person" });
    const { message } = VerifyMessage.parse(await (await post("/verify/message", { wallet: signer.address }, second)).json());
    const signature = Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message))).toString("base64");
    const res = await post("/verify", { wallet: signer.address, message, signature }, second);
    expect({ status: res.status, ...VerifyRefusal.parse(await res.json()) }).toMatchObject({ status: 409, code: "taken" });

    const creatorSigner = await generateKeyPairSigner();
    const [record] = await db.select().from(creators).where((await import("drizzle-orm")).eq(creators.xUserId, "7102"));
    await db.insert(creatorWallets).values({ creatorId: record!.id, wallet: creatorSigner.address, via: "first_launch", proof: "proof" });
    const asked = VerifyMessage.parse(await (await post("/verify/message", { wallet: creatorSigner.address }, second)).json());
    const signed = Buffer.from(await signBytes(creatorSigner.keyPair.privateKey, new TextEncoder().encode(asked.message))).toString("base64");
    expect((await post("/verify", { wallet: creatorSigner.address, message: asked.message, signature: signed }, second)).status).toBe(409);
  });
});

describe("the linkage pipeline at admission", () => {
  /** Funds `to` from `from` through `hops` single-use wallets, each passing on all but a fee. */
  function through(from: string, to: string, hops: number) {
    let at = from;
    for (let i = 0; i < hops; i++) {
      const hop = random();
      fakes.fund(at, hop, 1_000_000_000 - i * 5_000);
      at = hop;
    }
    fakes.fund(at, to, 1_000_000_000 - hops * 5_000);
  }
  const personIn = (m: Awaited<ReturnType<typeof prepared>>["message"]) => getDepositInstructionDataDecoder().decode(m.instructions.at(-1)!.data!).person;

  it("merges five wallets funded from one source, directly and through hop wallets, into one person with one seat", async () => {
    const { launch } = await launchOnChain();
    const exchange = random();
    fakes.busy(exchange);
    const source = random();
    fakes.fund(exchange, source, 6_000_000_000);
    const wallets = [random(), random(), random(), random(), random()];
    fakes.fund(source, wallets[0]!);
    fakes.fund(source, wallets[1]!);
    through(source, wallets[2]!, 1);
    through(source, wallets[3]!, 2);
    through(source, wallets[4]!, 3);
    // Someone else the exchange funded is their own person.
    const stranger = random();
    fakes.fund(exchange, stranger);

    // Before any seat exists, each of the five is told it shares the source's person, and is admitted as it.
    const page = await view(launch, wallets[4]!);
    expect(page.you!.admission).toMatchObject({ admitted: true, tier: "unverified", via: "linked" });
    const linked = (page.you!.admission as { linked: string }).linked;
    expect(linked).toContain(`its SOL came from ${source.slice(0, 4)}…${source.slice(-4)}, through 3 pass-through wallets in between`);
    const first = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: wallets[0]!, amount: `${STEP}` }));
    const person = personIn(first.message);
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet: wallets[0]!, person: new Uint8Array(person), tier: Tier.Unverified, deposit: STEP }));

    // Once the first holds the seat, the other four are refused with why, and can still buy after the open.
    for (const wallet of wallets.slice(1)) {
      const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }));
      expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
      expect(refused.error).toMatch(/^Heat counts this wallet as one person with \S+: both got their SOL from \S+, this wallet (directly|through \d pass-through wallets? in between)\. .* holds this Fair Open's seat: one person, one seat, one wallet\. You can still buy the coin once it opens\.$/);
      expect((await view(launch, wallet)).you!.admission).toMatchObject({ admitted: false, reason: refused.error });
    }
    // The source itself is the same person.
    expect((await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: source, amount: `${STEP}` }))).error).toContain(`this wallet funded ${wallets[0]!.slice(0, 4)}`);
    // The stranger is not.
    const theirs = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: stranger, amount: `${STEP}` }));
    expect(personIn(theirs.message)).not.toEqual(person);

    // The operator queue holds every merge, with the funding chain behind it.
    const reviews = await db.select().from(admissionReviews).orderBy(admissionReviews.wallet);
    expect(new Set(reviews.map((r) => r.wallet))).toEqual(new Set([...wallets, source]));
    expect(reviews.every((r) => r.kind === "merged" && r.cluster === `wallet:${source}`)).toBe(true);
    const w5 = reviews.find((r) => r.wallet === wallets[4] && r.reason.startsWith("Heat counts this wallet as one person with "))!;
    expect((w5.evidence as { wallet: { chain: unknown[] } }).wallet.chain).toHaveLength(4);
  });

  it("refuses a wallet the Creator wallet funded, and says why, while the creator deposits", async () => {
    const creator = random();
    const { launch } = await launchOnChain({ ago: 60n, creator });
    const funded = random();
    through(creator, funded, 2);
    const refused = await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: funded, amount: `${STEP}` }));
    expect(refused).toMatchObject({ status: 403, code: "not_admitted" });
    expect(refused.error).toBe(
      "The Creator wallet funded this wallet, through 2 pass-through wallets in between. Wallets tied to the creator cannot deposit in their Fair Open. You can still buy the coin once it opens.",
    );
    expect((await view(launch, funded)).you!.admission).toEqual({ admitted: false, reason: refused.error });
    // So is one that funded the Creator wallet, and one whose SOL came from where the creator's did.
    const backer = random();
    const sibling = random();
    fakes.fund(backer, sibling);
    const other = await launchOnChain({ ago: 60n });
    fakes.fund(backer, other.creator);
    expect((await refusal(await post(`/fair-opens/${other.launch}/deposit`, { wallet: backer, amount: `${STEP}` }))).error).toMatch(/^This wallet funded the Creator wallet, directly\./);
    expect((await refusal(await post(`/fair-opens/${other.launch}/deposit`, { wallet: sibling, amount: `${STEP}` }))).error).toMatch(/^This wallet's SOL came from \S+, as the Creator wallet's did\./);
    // The creator deposits from the Creator wallet itself.
    await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: creator, amount: `${STEP}` }));
    const reviews = await db.select().from(admissionReviews).where((await import("drizzle-orm")).eq(admissionReviews.kind, "refused"));
    expect(new Set(reviews.map((r) => r.wallet))).toEqual(new Set([funded, backer, sibling]));
  });

  it("ties nobody through a hub, even when the hub is the creator: Heat's devnet bank funds every test wallet", async () => {
    const bank = "Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933" as Address;
    const { launch } = await launchOnChain({ ago: 60n, creator: bank });
    const [a, b] = [random(), random()];
    fakes.fund(bank, a);
    fakes.fund(bank, b);
    const one = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: a, amount: `${STEP}` }));
    const two = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: b, amount: `${STEP}` }));
    expect(personIn(one.message)).not.toEqual(personIn(two.message));
    // An operator's hub ties nobody either.
    const faucet = random();
    await db.insert(linkageHubs).values({ address: faucet, label: "a faucet" });
    const [c, d] = [random(), random()];
    fakes.fund(faucet, c);
    fakes.fund(faucet, d);
    expect((await view(launch, c)).you!.admission).toMatchObject({ admitted: true, via: "none", linked: null });
  });

  it("counts a wallet funded from where a verified wallet's SOL came from as that person, Scored", async () => {
    const { launch } = await launchOnChain();
    const source = random();
    const signer = await generateKeyPairSigner();
    fakes.fund(source, signer.address);
    const cookie = await linkX({ id: "7201", username: "farm_owner" });
    await verified(cookie, signer);
    const other = random();
    through(source, other, 1);
    const admission = (await view(launch, other)).you!.admission;
    expect(admission).toMatchObject({ admitted: true, tier: "scored", via: "linked", handle: "farm_owner" });
    expect((admission as { linked: string }).linked).toMatch(/^Heat counts this wallet as @farm_owner's person/);
    const first = await prepared(await post(`/fair-opens/${launch}/deposit`, { wallet: signer.address, amount: `${STEP}` }));
    const person = personIn(first.message);
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet: signer.address, person: new Uint8Array(person), tier: Tier.Scored, deposit: STEP }));
    expect((await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet: other, amount: `${STEP}` }))).error).toContain("one person, one seat, one wallet");
  });

  it("concludes nothing from a chain it cannot read: the wallet is asked to try again", async () => {
    const { launch } = await launchOnChain();
    const wallet = random();
    const signature = fakes.fund(random(), wallet);
    fakes.transactions.delete(signature);
    expect((await view(launch, wallet)).you!.admission).toEqual({ admitted: false, reason: "Heat could not read where this wallet's SOL came from just now. Try again in a moment." });
    expect(await refusal(await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${STEP}` }))).toMatchObject({ status: 503, code: "unavailable" });
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

describe("an opened launch", () => {
  // 2.1 SOL asked of a 1.7 SOL pot that opened on its full rung for 300 million coins.
  const opened = (mint: Address) => ({ mint, spend: 1_700_000_000n, spent: 1_700_000_000n, coins: 300_000_000_000_000n, othersLevel: 1_600_000_000n, unverifiedLevel: 1_600_000_000n, delivered: 1 });
  const asks: [number, Tier][] = [[200, Tier.Verified], [10, Tier.Unverified]];

  it("shows the coin it opened and what the visitor's seat bought", async () => {
    const mint = random();
    const { launch } = await launchOnChain({ ago: 700n, asks, opened: opened(mint) });
    const wallet = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    const seat = await seatAddress(launch, person);
    fakes.accounts.set(seat, fairOpenSeat({ launch, wallet, person, tier: Tier.Unverified, deposit: 10n * STEP }));
    const before = await view(launch, wallet);
    expect(before.phase).toBe("opened");
    // The indexer has not seen the open yet: the coin is known by its address alone.
    expect(before.open).toMatchObject({ mint, spent: "1700000000", coins: "300000000000000", coinDecimals: 6, delivered: 1, coin: null });
    const o = seatOutcome(opened(mint), Tier.Unverified, 10n * STEP);
    expect(before.you!.seat).toMatchObject({ fill: `${o.spent}`, refund: `${o.refund}`, coins: `${o.coins}`, delivered: false });

    await db.insert(pools).values({
      pool: before.open!.pool,
      mint,
      config: "rPqMj6mwJp9qnZBMeawF8s2iC74EkhpbUSvhWd9XTnC",
      quoteMint: "So11111111111111111111111111111111111111112",
      graduationTarget: 8_500_000_000n,
      startSqrtPrice: "35525023424642174",
      creator: random(),
      name: "Opened Coin",
      ticker: "OPEN",
      uri: "https://turbo-gateway.com/opened",
      activatedAt: new Date(),
      createdSignature: "sig",
      createdSlot: 1,
      createdAt: new Date(),
      sqrtPrice: "1",
      quoteReserve: 0n,
    });
    // The coin as the creation transaction carried it, the identity hash's three parts; no launch here, so no image.
    expect((await view(launch, wallet)).open!.coin).toEqual({ name: "Opened Coin", ticker: "OPEN", uri: "https://turbo-gateway.com/opened", imageUri: null });
  });

  it("builds a seat's own claim, and refuses one before the open, the creator's, a delivered one and a wallet with no seat", async () => {
    const mint = random();
    const { launch, creator } = await launchOnChain({ ago: 700n, asks, opened: opened(mint) });
    const wallet = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    fakes.accounts.set(await seatAddress(launch, person), fairOpenSeat({ launch, wallet, person, tier: Tier.Unverified, deposit: 10n * STEP }));
    const claim = (launchAddress: string, from: string) => post(`/fair-opens/${launchAddress}/claim`, { wallet: from });
    const { message } = await prepared(await claim(launch, wallet));
    const ours = message.instructions.filter((ix) => ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS);
    expect(ours.map((ix) => Array.from(ix.data!.slice(0, 8)))).toEqual([Array.from(CLAIM_DISCRIMINATOR)]);

    expect(await refusal(await claim(launch, creator))).toMatchObject({ status: 409, code: "creators_seat" });
    expect(await refusal(await claim(launch, random()))).toMatchObject({ status: 404, code: "no_seat" });
    const delivered = random();
    const theirs = crypto.getRandomValues(new Uint8Array(32));
    fakes.accounts.set(await seatAddress(launch, theirs), fairOpenSeat({ launch, wallet: delivered, person: theirs, tier: Tier.Verified, deposit: 200n * STEP, delivered: { spent: 1n, coins: 1n, refund: 1n } }));
    expect(await refusal(await claim(launch, delivered))).toMatchObject({ status: 409, code: "delivered" });
    const { launch: scheduled } = await launchOnChain({ ago: 60n, asks });
    expect(await refusal(await claim(scheduled, wallet))).toMatchObject({ status: 409, code: "not_opened" });
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
