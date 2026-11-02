import { getBase64EncodedWireTransaction, partiallySignTransaction, type KeyPairSigner } from "@solana/kit";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Imported before ./index and ./test/fakes, so its mock below is made before the fakes, which import it, are loaded.
import "@top-pad/chain";
import { ImageVerdict, LaunchRefusal, PreparedLaunch, VampAppeal, VampAppeals, VampShieldVerdict } from "@top-pad/contract";
import { createDb, launches, protectedCoins, protectedImages, vampChecks, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import { protectHeatCoin, upsertListed } from "./protectedSet";
import { atCosine, decode, Fakes, FakeVision, fakeSignatures, flipBits, MemoryBlobs, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";
import type { Bindings } from "./env";
import type { Signatures } from "./vision";

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

/** A 1x1 PNG, and distinct images built on it: the launch service sniffs the PNG header, the fake vision the bytes. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const image = (tag: string) => new Uint8Array([...PNG, ...new TextEncoder().encode(tag)]);
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");

const BONK = { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", ticker: "Bonk", name: "Bonk", imageUrl: "https://img.test/bonk.png" };
const BONK_IMAGE = fakeSignatures("bonk-logo");

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
  await upsertListed(db, "jupiter_verified", [{ ...BONK, details: {} }]);
  await db
    .update(protectedImages)
    .set({ status: "done", sha256: BONK_IMAGE.sha256, pdq: BONK_IMAGE.pdq.bits, pdqQuality: 90, sscd: BONK_IMAGE.sscd })
    .where(eq(protectedImages.url, BONK.imageUrl));
});
afterAll(async () => {
  await closeDb();
  await drop();
});

let fakes: Fakes;
let vision: FakeVision;
let blobs: MemoryBlobs;
beforeEach(() => {
  fakes = new Fakes();
  vision = new FakeVision();
  blobs = new MemoryBlobs();
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = { idFromName: () => "indexer", get: () => ({ indexNow: async () => undefined }) } as unknown as Bindings["INDEXER"];
const bindings = () =>
  testBindings(url, { BLOBS: blobs, KEEPER_KEY: { get: async () => JSON.stringify(Array.from(keeper().secret)) }, INDEXER: indexer, VISION: vision.binding() });
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);
const post = (path: string, body: unknown, cookie = "") =>
  request(path, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGINS.web, "content-type": "application/json", cookie } });

let creatorId = 7000;
async function linkX() {
  fakes.xUser = { id: `${creatorId++}`, username: "vamp_test", name: "Vamp Test" };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  return res.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
}

const textVerdict = async (ticker: string, name: string) => VampShieldVerdict.parse(await (await post("/vamp-shield/check", { ticker, name })).json());

/** The fake vision answers these bytes with these signatures, as if they were this picture. */
async function looksAs(bytes: Uint8Array, signatures: Omit<Signatures, "sha256">) {
  vision.byImage.set(await sha256(bytes), { ...signatures, sha256: await sha256(bytes) });
}

/** One signed-in creator checks the images of the tests that are not about who may check. */
let checker: string | null = null;
async function checkImage(bytes: Uint8Array, cookie?: string) {
  cookie ??= checker ??= await linkX();
  const form = new FormData();
  form.set("image", new File([bytes as BufferSource], "coin.png", { type: "image/png" }));
  return request("/vamp-shield/image", { method: "POST", body: form, headers: { origin: ORIGINS.web, cookie } });
}

function prepareInstant(cookie: string, o: { ticker: string; name: string; wallet: string; image: Uint8Array }) {
  const form = new FormData();
  form.set("mode", "instant");
  form.set("name", o.name);
  form.set("ticker", o.ticker);
  form.set("wallet", o.wallet);
  form.set("image", new File([o.image as BufferSource], "coin.png", { type: "image/png" }));
  return request("/launches", { method: "POST", body: form, headers: { origin: ORIGINS.web, cookie } });
}

describe("Vamp Shield's text verdicts", () => {
  it("refuses a Protected coin's folded ticker, naming the coin and where to see it", async () => {
    const verdict = await textVerdict("B0NK", "Frog");
    expect(verdict.clear).toBe(false);
    expect(verdict.verdicts.ticker).toMatchObject({
      status: "refused",
      match: { mint: BONK.mint, ticker: "Bonk", source: "jupiter_verified", url: `https://jup.ag/tokens/${BONK.mint}`, imageUrl: BONK.imageUrl },
    });
  });

  it("labels a derivative or a one-letter change \"looks like\", and lets it launch", async () => {
    for (const ticker of ["BABYBONK", "BONKINU", "BONKK"]) {
      const verdict = await textVerdict(ticker, "Frog");
      expect(verdict.clear, ticker).toBe(true);
      expect(verdict.verdicts.ticker, ticker).toMatchObject({ status: "looks_like", match: { mint: BONK.mint } });
      expect(verdict.verdicts.ticker.reason, ticker).toContain('labelled "looks like $Bonk"');
    }
    const name = await textVerdict("FROG", "Baby Bonk");
    expect(name.verdicts.name).toMatchObject({ status: "looks_like", match: { mint: BONK.mint } });
    expect((await textVerdict("FROG", "Frog")).verdicts).toMatchObject({ ticker: { status: "clear" }, name: { status: "clear" } });
  });

  it("no longer protects a coin whose protection has lapsed", async () => {
    await upsertListed(db, "trending", [{ mint: "Lapsed1111111111111111111111111111111111111", ticker: "GONE", name: "Gone Coin", imageUrl: null, details: {} }]);
    expect((await textVerdict("GONE", "Frog")).clear).toBe(false);
    await db.update(protectedCoins).set({ protectedUntil: new Date(Date.now() - 1000) }).where(eq(protectedCoins.ticker, "GONE"));
    expect((await textVerdict("GONE", "Frog")).clear).toBe(true);
  });
});

describe("Vamp Shield's image verdicts", () => {
  it("refuses a Protected coin's picture mirrored or rotated, by PDQ over the 8 orientations, and logs its scores", async () => {
    const mirrored = image("mirrored");
    const dihedral = fakeSignatures("mirrored-copy").pdq.dihedral;
    dihedral[5] = flipBits(BONK_IMAGE.pdq.bits, 10);
    await looksAs(mirrored, { pdq: { bits: dihedral[0]!, quality: 80, dihedral }, sscd: atCosine(BONK_IMAGE.sscd, 0.3) });
    const res = await checkImage(mirrored);
    expect(res.status).toBe(200);
    const verdict = ImageVerdict.parse(await res.json());
    expect(verdict).toMatchObject({ sha256: await sha256(mirrored), answerMs: 4_200, woke: true, verdict: { status: "refused", match: { mint: BONK.mint } } });
    expect(verdict.verdict.reason).toBe("The image is the picture of $Bonk, a protected coin, mirrored.");

    const [logged] = await db.select().from(vampChecks).where(eq(vampChecks.imageSha256, verdict.sha256));
    expect(logged).toMatchObject({ stage: "image", outcome: "refused" });
    expect(logged!.nearest).toContainEqual(expect.objectContaining({ mint: BONK.mint, pdqDistance: 10, orientation: 5 }));

    // Checked again, its signatures come from the first check: the vision service is not asked twice.
    const again = ImageVerdict.parse(await (await checkImage(mirrored)).json());
    expect(again).toMatchObject({ answerMs: null, woke: null, verdict: { status: "refused" } });
    expect(vision.calls).toBe(1);
  });

  it("refuses at SSCD 0.75 or more, labels 0.60 to 0.75, and clears below", async () => {
    const cases: [string, number, string][] = [
      ["copy", 0.82, "refused"],
      ["near", 0.66, "looks_like"],
      ["far", 0.4, "clear"],
    ];
    for (const [tag, cos, status] of cases) {
      const bytes = image(tag);
      await looksAs(bytes, { ...fakeSignatures(tag), sscd: atCosine(BONK_IMAGE.sscd, cos, tag) });
      const verdict = ImageVerdict.parse(await (await checkImage(bytes)).json());
      expect(verdict.verdict.status, tag).toBe(status);
    }
    const near = ImageVerdict.parse(await (await checkImage(image("near"))).json());
    expect(near.verdict.reason).toBe('The image is close to the picture of $Bonk, a protected coin: it can launch, labelled "looks like $Bonk" on its page.');
  });

  it("trusts no PDQ match on an image of too low a quality, leaving it to SSCD", async () => {
    const flat = image("flat");
    const signatures = fakeSignatures("flat");
    await looksAs(flat, { pdq: { ...signatures.pdq, quality: 30, dihedral: [BONK_IMAGE.pdq.bits, ...signatures.pdq.dihedral.slice(1)] }, sscd: signatures.sscd });
    expect(ImageVerdict.parse(await (await checkImage(flat)).json()).verdict.status).toBe("clear");
  });

  it("is only for a creator signed in with X, and only so many a time", async () => {
    expect((await checkImage(image("anonymous"), "")).status).toBe(401);
    const cookie = await linkX();
    for (let i = 0; i < 30; i++) expect((await checkImage(image(`many-${i % 3}`), cookie)).status).toBe(200);
    const res = await checkImage(image("one-too-many"), cookie);
    expect(res.status).toBe(429);
    expect(vision.calls).toBe(3);
  });

  it("says so when the vision service cannot answer, and counts the attempt", async () => {
    vision.down = true;
    const res = await checkImage(image("while-down"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Vamp Shield could not check the image just now. Try again in a minute." });
    const [logged] = await db.select().from(vampChecks).where(eq(vampChecks.imageSha256, await sha256(image("while-down"))));
    expect(logged).toMatchObject({ stage: "image", outcome: "unchecked" });
  });

  it("matches an image a lower-ranked source names for a coin a higher one also protects", async () => {
    const mint = "TwoSrc11111111111111111111111111111111111111";
    await upsertListed(db, "jupiter_verified", [{ mint, ticker: "TWOS", name: "Two Sources", imageUrl: "https://img.test/two-verified.png", details: {} }]);
    await upsertListed(db, "trending", [{ mint, ticker: "TWOS", name: "Two Sources", imageUrl: "https://img.test/two-trending.png", details: {} }]);
    const trendingImage = fakeSignatures("two-trending");
    await db
      .update(protectedImages)
      .set({ status: "done", sha256: trendingImage.sha256, pdq: trendingImage.pdq.bits, pdqQuality: 90, sscd: trendingImage.sscd })
      .where(eq(protectedImages.url, "https://img.test/two-trending.png"));
    const copy = image("two-copy");
    await looksAs(copy, { pdq: { bits: trendingImage.pdq.bits, quality: 90, dihedral: [trendingImage.pdq.bits, ...fakeSignatures("x").pdq.dihedral.slice(1)] }, sscd: trendingImage.sscd });
    const verdict = ImageVerdict.parse(await (await checkImage(copy)).json());
    expect(verdict.verdict).toMatchObject({ status: "refused", match: { mint, source: "trending" } });
  });
});

describe("a launch Vamp Shield judges as it is prepared", () => {
  it("is refused for a Protected coin's picture, with the image's verdict, and logged", async () => {
    const cookie = await linkX();
    const rotated = image("rotated");
    const dihedral = fakeSignatures("rotated-copy").pdq.dihedral;
    dihedral[1] = flipBits(BONK_IMAGE.pdq.bits, 3);
    await looksAs(rotated, { pdq: { bits: dihedral[0]!, quality: 80, dihedral }, sscd: fakeSignatures("rotated-copy").sscd });
    const res = await prepareInstant(cookie, { ticker: "FROGGY", name: "Froggy", wallet: (await testKeypair()).signer.address, image: rotated });
    expect(res.status).toBe(422);
    const refusal = LaunchRefusal.parse(await res.json());
    expect(refusal).toMatchObject({ code: "vamp_shield", error: "The image is the picture of $Bonk, a protected coin, rotated a quarter turn.", imageVerdict: { status: "refused" } });
    const logged = await db.select().from(vampChecks).where(and(eq(vampChecks.stage, "prepare"), eq(vampChecks.ticker, "FROGGY")));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: "refused", imageSha256: await sha256(rotated) });
  });

  it("is refused for its name with the name's reason, not the ticker's \"looks like\" note", async () => {
    await upsertListed(db, "jupiter_verified", [{ mint: "PepeMint1111111111111111111111111111111111111", ticker: "PEPE", name: "Pepe", imageUrl: null, details: {} }]);
    const cookie = await linkX();
    const res = await prepareInstant(cookie, { ticker: "BABYBONK", name: "P3pe", wallet: (await testKeypair()).signer.address, image: image("named") });
    expect(res.status).toBe(422);
    const refusal = LaunchRefusal.parse(await res.json());
    expect(refusal.error).toBe(refusal.verdict!.verdicts.name.reason);
    expect(refusal.verdict!.verdicts.ticker.status).toBe("looks_like");
  });

  it("is refused when the image cannot be checked: the launch key never co-signs an unchecked image", async () => {
    const cookie = await linkX();
    vision.down = true;
    const res = await prepareInstant(cookie, { ticker: "UNSEEN", name: "Unseen", wallet: (await testKeypair()).signer.address, image: image("unseen") });
    expect(res.status).toBe(503);
    expect(LaunchRefusal.parse(await res.json())).toMatchObject({ code: "vamp_shield", imageVerdict: { status: "refused" }, imageSha256: await sha256(image("unseen")) });
  });

  it("launches a near one with its \"looks like\" labels kept, and logged", async () => {
    const cookie = await linkX();
    const wallet = (await testKeypair()).signer;
    const near = image("near-launch");
    await looksAs(near, { ...fakeSignatures("near-launch"), sscd: atCosine(BONK_IMAGE.sscd, 0.7, "near-launch") });
    const res = await prepareInstant(cookie, { ticker: "BABYBONK", name: "Baby Frog", wallet: wallet.address, image: near });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const launch = PreparedLaunch.parse(await res.json());
    const [row] = await db.select().from(launches).where(eq(launches.id, launch.id));
    expect(row!.imageSha256).toBe(await sha256(near));
    expect(row!.looksLike).toEqual([
      {
        field: "ticker",
        coin: { mint: BONK.mint, ticker: "Bonk", name: "Bonk", source: "jupiter_verified", url: `https://jup.ag/tokens/${BONK.mint}`, imageUrl: BONK.imageUrl },
        label: "Looks like $Bonk",
        reason: "Its ticker builds on $Bonk with a word such as BABY or INU.",
      },
      expect.objectContaining({ field: "image", label: "Looks like $Bonk", reason: "Its picture is close to $Bonk's." }),
    ]);
    const [logged] = await db.select().from(vampChecks).where(and(eq(vampChecks.stage, "prepare"), eq(vampChecks.launchId, launch.id)));
    expect(logged).toMatchObject({ outcome: "looks_like", ticker: "BABYBONK" });
  });

  it("refuses a protected Heat coin's strict key to a new launch", async () => {
    const cookie = await linkX();
    const wallet = (await testKeypair()).signer;
    const res = await prepareInstant(cookie, { ticker: "GLOW", name: "Glow", wallet: wallet.address, image: image("glow") });
    const first = PreparedLaunch.parse(await res.json());
    if (first.mode !== "instant") throw new Error("expected an Instant launch");
    const signed = getBase64EncodedWireTransaction(await partiallySignTransaction([(wallet as KeyPairSigner).keyPair], decode(first.transaction)));
    const submitted = await request(`/launches/${first.id}/submit`, { method: "POST", body: JSON.stringify({ transaction: signed }), headers: { origin: ORIGINS.web, cookie, "content-type": "application/json" } });
    expect(submitted.status).toBe(200);
    expect(await protectHeatCoin(db, { mint: first.mint, ticker: "GLOW", name: "Glow", imageUri: null, launchId: first.id }, { reason: "holders", holders: 120 })).toEqual({ key: true });
    const [row] = await db.select().from(launches).where(eq(launches.id, first.id));
    expect(row!.tickerKey).toBe("GLOW");

    const other = await linkX();
    for (const ticker of ["GLOW", "GL0W"]) {
      const refused = await prepareInstant(other, { ticker, name: "Another", wallet: (await testKeypair()).signer.address, image: image(`another-${ticker}`) });
      expect(refused.status, ticker).toBe(422);
      expect(LaunchRefusal.parse(await refused.json()).verdict?.verdicts.ticker).toMatchObject({ status: "refused", match: { mint: first.mint, source: "heat", url: `${ORIGINS.web}/coin/${first.mint}` } });
    }
  });
});

describe("an appeal against a refusal", () => {
  it("needs the creator signed in, keeps the verdict, lists the creator's own, and is limited to 5 a day", async () => {
    const body = { ticker: "B0NK", name: "Bonk Two", imageSha256: null, original: "my own coin", message: "I made Bonk." };
    expect((await post("/vamp-shield/appeals", body)).status).toBe(401);
    const cookie = await linkX();
    const res = await post("/vamp-shield/appeals", body, cookie);
    expect(res.status).toBe(201);
    const appeal = VampAppeal.parse(await res.json());
    expect(appeal).toMatchObject({ ticker: "B0NK", name: "Bonk Two", original: "my own coin", message: "I made Bonk.", status: "open" });
    for (let i = 0; i < 4; i++) expect((await post("/vamp-shield/appeals", body, cookie)).status).toBe(201);
    expect((await post("/vamp-shield/appeals", body, cookie)).status).toBe(429);
    const listed = VampAppeals.parse(await (await request("/vamp-shield/appeals", { headers: { cookie } })).json());
    expect(listed.appeals).toHaveLength(5);
    expect(listed.appeals[4]!.id).toBe(appeal.id);
  });
});
