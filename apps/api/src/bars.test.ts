// Bars from the creator's side and the public's (spec 6.5, 7, 9; #56): the private view with its evidence, replies and
// appeals, only for the barred record's own creator; publication after 72 hours on the record, the coin's page and its
// summary; an upheld appeal clearing all of it; the counts "How this is enforced" publishes; and the X direct message.
import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, WSOL_MINT } from "@top-pad/chain";
import { Coin, CreatorRecord, EnforcementCounts, PrivateBars } from "@top-pad/contract";
import { barAppeals, barReplies, bars, bundleCases, coins, creators, createDb, graduations, pools, xMessages, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { eq } from "drizzle-orm";
import { sendBarNotices } from "./bars";
import { config } from "./env";
import { app } from "./index";
import { Fakes, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";
import { signInWallet } from "./test/signIn";

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
const request = (path: string, init: RequestInit = {}) => app.request(path, init, testBindings(url), ctx);
const post = (path: string, cookie: string, body: unknown) =>
  request(path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGINS.web, cookie, "content-type": "application/json" } });
const record = async (key: string) => CreatorRecord.parse(await (await request(`/creators/${key}`)).json());
const privateView = async (key: string, cookie: string) => {
  const res = await request(`/creators/${key}/bars`, { headers: { cookie } });
  expect(res.status, await res.clone().text()).toBe(200);
  return PrivateBars.parse(await res.json()).bars;
};

const HOUR = 3_600_000;
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
const { instant } = CLUSTERS.devnet!.configs!;

/** The evidence pack Bundle Radar keeps with a case (bundleRadar.ts, `evidencePack`). */
const pack = (creatorWallet: string, linked: string) => ({
  version: 1,
  cluster: "devnet",
  reviewedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
  rule: "Wallets directly linked to the Creator wallet bought 1% or more of the coin's supply between them, across the pot and the first hour of trading (spec 6.5).",
  coin: { mint: "x", pool: "y", launchMode: "instant", explorer: "https://explorer.solana.com/address/x?cluster=devnet" },
  creator: { wallet: creatorWallet, explorer: "https://explorer.solana.com/address/c?cluster=devnet", recordId: null, xHandle: null },
  openedAt: new Date(Date.now() - 6 * HOUR).toISOString(),
  creation: { signature: signature(), explorer: "https://explorer.solana.com/tx/s?cluster=devnet", slot: 4242, blockIndex: 7, jitoBundle: null },
  jito: false,
  floor: { supply: "1000000000000000", floor: "10000000000000", linkedCoins: "21000000000000", share: "2.10%" },
  wallets: [
    {
      wallet: linked,
      explorer: `https://explorer.solana.com/address/${linked}?cluster=devnet`,
      creator: false,
      linked: true,
      labels: ["same_slot", "creator_funded"],
      counted: "21000000000000",
      potCoins: "0",
      buys: [],
      deposits: [],
      transfers: [
        { signature: signature(), explorer: "https://explorer.solana.com/tx/t?cluster=devnet", at: new Date(Date.now() - 7 * HOUR).toISOString(), direction: "from_creator", asset: "SOL", amount: "35000000" },
      ],
    },
  ],
});

type Barred = { creatorId: string; wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>; cookie: string; mint: string; barId: string };

/** A creator signed in with their wallet, their coin (graduated, so the record would be good), and a Bar confirmed `ago` ms back. */
async function barred(ago: number, o: { x?: boolean } = {}): Promise<Barred> {
  const { signer: wallet } = await testKeypair();
  const cookie = await signInWallet(request, wallet);
  const [{ id: creatorId }] = (await db.select({ id: creators.id }).from(creators).orderBy(creators.createdAt)).slice(-1) as [{ id: string }];
  if (o.x) await db.update(creators).set({ xUserId: `${Date.now()}`, xHandle: "bundler_on_x_long", xName: "Bundler" }).where(eq(creators.id, creatorId));
  const [mint, pool] = [(await generateKeyPairSigner()).address as string, (await generateKeyPairSigner()).address as string];
  const createdAt = new Date(Date.now() - ago - 2 * HOUR);
  const created = signature();
  await db.insert(pools).values({
    pool, mint, config: instant, creator: wallet.address, quoteMint: WSOL_MINT, graduationTarget: 8_500_000_000n, startSqrtPrice: "1000",
    name: "Frog Bundle", ticker: "FROG", uri: "https://turbo-gateway.com/x", activatedAt: createdAt, createdSignature: created, createdSlot: 10, createdAt, sqrtPrice: "1000", quoteReserve: 0n,
  });
  await db.insert(coins).values({
    mint, pool, config: instant, launchMode: "instant", creatorId, creatorWallet: wallet.address, name: "Frog Bundle", ticker: "FROG",
    metadataUri: "https://turbo-gateway.com/x", imageUri: null, createdSignature: created, createdSlot: 10, createdAt,
  });
  const addr = async () => (await generateKeyPairSigner()).address as string;
  await db.insert(graduations).values({
    mint, curvePool: pool, pool: await addr(), config: instant, signature: signature(), slot: 11, graduatedAt: createdAt, sqrtPrice: "1000",
    creatorPosition: await addr(), creatorPositionNftMint: await addr(), creatorPositionOwner: wallet.address, creatorLiquidity: "1",
    heatPosition: await addr(), heatPositionNftMint: await addr(), heatLiquidity: "1",
  });
  const linked = (await generateKeyPairSigner()).address;
  const [c] = await db
    .insert(bundleCases)
    .values({ mint, creatorWallet: wallet.address, creatorId, status: "confirmed", linkedWallets: 1, linkedCoins: 21000000000000n, supply: 1000000000000000n, evidence: pack(wallet.address, linked), evidenceKey: `bundle-radar/cases/${mint}.json` })
    .returning();
  const confirmedAt = new Date(Date.now() - ago);
  const [bar] = await db
    .insert(bars)
    .values({ caseId: c!.id, mint, creatorId, creatorWallet: wallet.address, confirmedBy: "operator@heat.test", confirmedAt, publishAt: new Date(confirmedAt.getTime() + 72 * HOUR), note: "confirmed" })
    .returning();
  return { creatorId, wallet, cookie, mint, barId: bar!.id };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", new Fakes().fetch);
  for (const t of [xMessages, barAppeals, barReplies, bars, bundleCases]) await db.delete(t);
});

describe("the private 72-hour window", () => {
  it("shows the Bar only to its own creator, with the evidence pack, and nothing of it in public", async () => {
    const b = await barred(HOUR);
    expect((await request(`/creators/${b.creatorId}/bars`)).status).toBe(401);
    const stranger = await signInWallet(request, (await testKeypair()).signer);
    expect((await request(`/creators/${b.creatorId}/bars`, { headers: { cookie: stranger } })).status).toBe(403);

    const [bar] = await privateView(b.wallet.address, b.cookie);
    expect(bar).toMatchObject({ id: b.barId, coin: { mint: b.mint, ticker: "FROG" }, published: false, liftedAt: null, canAppeal: "first", message: null });
    expect(bar!.evidence.floor.share).toBe("2.10%");
    expect(bar!.evidence.wallets[0]!.labels).toEqual(["same_slot", "creator_funded"]);
    expect(Date.parse(bar!.publishAt) - Date.parse(bar!.confirmedAt)).toBe(72 * HOUR);

    // Nothing public yet: not on the record, not on the coin, not in the counts.
    const shown = await record(b.creatorId);
    expect(shown.bars).toEqual([]);
    expect(shown.summary.barred).toBeNull();
    // A Bar, even a private one, is no good record: the verified-creator mark goes at once (spec 7), though the coin graduated.
    expect(shown.summary.graduations).toBe(1);
    expect(shown.summary.marks.verifiedCreator).toBe(false);
    expect(Coin.parse(await (await request(`/coins/${b.mint}`)).json()).finding).toBeNull();
    expect(EnforcementCounts.parse(await (await request("/enforcement")).json())).toMatchObject({ bars: 0, appeals: 0, overturned: 0 });
  });

  it("takes the creator's replies, for the operator", async () => {
    const b = await barred(HOUR);
    expect((await post(`/bars/${b.barId}/replies`, b.cookie, { body: "  " })).status).toBe(400);
    const res = await post(`/bars/${b.barId}/replies`, b.cookie, { body: "Those wallets are my friends'; they bought on their own." });
    expect(res.status).toBe(201);
    const stranger = await signInWallet(request, (await testKeypair()).signer);
    expect((await post(`/bars/${b.barId}/replies`, stranger, { body: "not mine" })).status).toBe(404);
    const [bar] = await privateView(b.creatorId, b.cookie);
    expect(bar!.replies.map((r) => r.body)).toEqual(["Those wallets are my friends'; they bought on their own."]);
  });
});

describe("appeals", () => {
  it("takes one appeal within 30 days, one at a time, and another only with new evidence once denied", async () => {
    const b = await barred(HOUR);
    const appeal = { grounds: "shared_exchange", statement: "The SOL came from Binance withdrawals, not from me.", evidence: "https://explorer.solana.com/tx/abc" };
    const first = await post(`/bars/${b.barId}/appeals`, b.cookie, appeal);
    expect(first.status).toBe(201);
    expect(Date.parse(((await first.json()) as { dueAt: string }).dueAt) - Date.now()).toBeGreaterThan(47 * HOUR);
    expect((await post(`/bars/${b.barId}/appeals`, b.cookie, appeal)).status).toBe(409);
    expect((await privateView(b.creatorId, b.cookie))[0]).toMatchObject({ canAppeal: null, appeals: [{ status: "open", grounds: "shared_exchange" }] });

    // Denied by an operator: another appeal needs evidence the last ones did not bring.
    await db.update(barAppeals).set({ status: "denied", decidedAt: new Date(), decidedBy: "second@heat.test", decisionNote: "Direct transfers from the Creator wallet." });
    const [denied] = await privateView(b.creatorId, b.cookie);
    expect(denied).toMatchObject({ canAppeal: "new_evidence", appeals: [{ status: "denied", decision: "Direct transfers from the Creator wallet." }] });
    expect((await post(`/bars/${b.barId}/appeals`, b.cookie, { grounds: "other", statement: "Again." })).status).toBe(409);
    expect((await post(`/bars/${b.barId}/appeals`, b.cookie, { ...appeal, evidence: " HTTPS://explorer.solana.com/tx/ABC " })).status).toBe(409);
    expect((await post(`/bars/${b.barId}/appeals`, b.cookie, { ...appeal, evidence: "Binance's statement that the four wallets are its customers'." })).status).toBe(201);
  });

  it("is closed once 30 days have passed with none filed", async () => {
    const b = await barred(31 * 24 * HOUR);
    expect((await privateView(b.creatorId, b.cookie))[0]!.canAppeal).toBeNull();
    expect((await post(`/bars/${b.barId}/appeals`, b.cookie, { grounds: "other", statement: "Late." })).status).toBe(409);
  });
});

describe("publication", () => {
  it("shows a Bar past its 72 hours on the record, its summary and the coin's page, with its evidence and appeal status", async () => {
    const b = await barred(73 * HOUR);
    await db.insert(barAppeals).values({ barId: b.barId, creatorId: b.creatorId, grounds: "launch_service", statement: "A launch service bundled for me." });
    const shown = await record(b.creatorId);
    expect(shown.bars).toHaveLength(1);
    expect(shown.bars[0]).toMatchObject({ coin: { ticker: "FROG", mint: b.mint }, appeal: { status: "open" } });
    expect(shown.bars[0]!.evidence.wallets).toHaveLength(1);
    expect(shown.summary.barred).toMatchObject({ ticker: "FROG", mint: b.mint });
    const coin = Coin.parse(await (await request(`/coins/${b.mint}`)).json());
    expect(coin.finding).toMatchObject({ kind: "confirmed_creator_bundle", appeal: "open" });
    expect(coin.record!.barred).toMatchObject({ ticker: "FROG" });
    expect(EnforcementCounts.parse(await (await request("/enforcement")).json())).toMatchObject({ bars: 1, appeals: 1, overturned: 0 });
  });

  it("clears every public trace once an appeal is upheld, and counts the finding overturned", async () => {
    const b = await barred(80 * HOUR);
    const [appeal] = await db.insert(barAppeals).values({ barId: b.barId, creatorId: b.creatorId, grounds: "shared_exchange", statement: "Exchange." }).returning();
    // As the operator app's decideAppeal writes an upheld appeal.
    await db.update(barAppeals).set({ status: "upheld", decidedAt: new Date(), decidedBy: "second@heat.test" }).where(eq(barAppeals.id, appeal!.id));
    await db.update(bars).set({ liftedAt: new Date(), liftedBy: "second@heat.test", liftedAppeal: appeal!.id }).where(eq(bars.id, b.barId));
    const shown = await record(b.creatorId);
    expect(shown.bars).toEqual([]);
    expect(shown.summary.barred).toBeNull();
    expect(Coin.parse(await (await request(`/coins/${b.mint}`)).json()).finding).toBeNull();
    // The creator still sees it, lifted.
    expect((await privateView(b.creatorId, b.cookie))[0]).toMatchObject({ liftedAt: expect.any(String), canAppeal: null });
    expect(EnforcementCounts.parse(await (await request("/enforcement")).json())).toMatchObject({ bars: 1, appeals: 1, overturned: 1 });
  });
});

describe("the X direct message", () => {
  it("is sent from Heat's X account by the cron, and tried again when X fails", async () => {
    const b = await barred(HOUR, { x: true });
    const [x] = await db.select({ id: creators.xUserId }).from(creators).where(eq(creators.id, b.creatorId));
    await db.insert(xMessages).values({ barId: b.barId, xUserId: x!.id!, text: "Heat: an operator confirmed a creator bundle in $FROG." });
    const bindings = testBindings(url, { X_DM_TOKEN: "heat-account-token" });
    const cfg = config(bindings);
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    let fail = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      if (fail) return Response.json({ title: "Service Unavailable", detail: "Over capacity" }, { status: 503 });
      return Response.json({ data: { dm_conversation_id: "c1", dm_event_id: "1580705921830768640" } }, { status: 201 });
    });
    expect(await sendBarNotices(db, cfg, bindings)).toMatchObject({ sent: 0, failed: 1 });
    expect((await db.select().from(xMessages))[0]).toMatchObject({ sentAt: null, attempts: 1, lastError: "X answered 503: Over capacity" });
    fail = false;
    expect(await sendBarNotices(db, cfg, bindings)).toMatchObject({ sent: 1, failed: 0 });
    expect(calls.at(-1)).toEqual({ url: `${ORIGINS.x}/2/dm_conversations/with/${x!.id}/messages`, auth: "Bearer heat-account-token", body: { text: "Heat: an operator confirmed a creator bundle in $FROG." } });
    expect((await db.select().from(xMessages))[0]).toMatchObject({ xEventId: "1580705921830768640", attempts: 2, sentAt: expect.any(Date) });
    expect((await privateView(b.creatorId, b.cookie))[0]!.message).toMatchObject({ sentAt: expect.any(String) });
    // Nothing is sent twice.
    expect(await sendBarNotices(db, cfg, bindings)).toEqual({ sent: 0, failed: 0, waiting: 0 });
  });

  it("waits, unsent, on a deployment with no token", async () => {
    const b = await barred(HOUR, { x: true });
    await db.insert(xMessages).values({ barId: b.barId, xUserId: "1", text: "t" });
    const bindings = testBindings(url);
    expect(await sendBarNotices(db, config(bindings), bindings)).toMatchObject({ sent: 0, waiting: 1, reason: "no X direct-message token on this deployment" });
  });
});
