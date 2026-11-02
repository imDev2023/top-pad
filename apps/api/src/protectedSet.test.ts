import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import { coins, createDb, pools, protectedCoins, protectedImages, trades, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { heatHandler, indexTransactions, type RawTransaction } from "@top-pad/indexer";
import { config } from "./env";
import { coinGeckoTop, refreshHeat, refreshLists, refreshTrending, signImages, upsertListed, USER_AGENT, type Listed } from "./protectedSet";
import { FakeVision, fakeSignatures, testBindings } from "./test/fakes";
import { protectsNow } from "./vampShield";

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;

// A real devnet Instant launch, as the indexer wrote it: its coin, pool and trades.
const tx = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/launch-with-creator-buy.json"), "utf8"),
) as RawTransaction;
const MINT = "EcQZjuhGWVjF3GjSPj6e9XzCchMy7B338Ug9VNgraf1L";

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
  await indexTransactions(db, heatHandler({ heat: CLUSTERS.devnet!, blockIndexOf: async () => 17 }), [tx]);
});
afterAll(async () => {
  await closeDb();
  await drop();
});
afterEach(() => vi.unstubAllGlobals());

const listed = (mint: string, ticker: string, extra: Partial<Listed> = {}): Listed => ({ mint, ticker, name: ticker, imageUrl: `https://img.test/${mint}.png`, details: {}, ...extra });
const rowsOf = (source: string) => db.select().from(protectedCoins).where(sql`${protectedCoins.source} = ${source}`);
const protecting = async (mint: string) => (await db.select({ id: protectedCoins.id }).from(protectedCoins).where(and(eq(protectedCoins.mint, mint), protectsNow()))).length > 0;
const hoursFromNow = (d: Date | null) => (d ? Math.round((d.getTime() - Date.now()) / 3_600_000) : null);

/** Jupiter's and CoinGecko's answers, by path, and what each request carried. */
function outside(routes: Record<string, unknown | ((req: Request) => Response)>) {
  const asked: { url: string; key: string | null; agent: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    asked.push({ url: req.url, key: req.headers.get("x-api-key"), agent: req.headers.get("user-agent") });
    const route = Object.entries(routes).find(([path]) => req.url.includes(path));
    if (!route) return new Response("not found", { status: 404 });
    return typeof route[1] === "function" ? (route[1] as (r: Request) => Response)(req) : Response.json(route[1]);
  });
  return asked;
}

const jup = (id: string, symbol: string, o: Record<string, unknown> = {}) => ({ id, symbol, name: `${symbol} coin`, icon: `https://img.test/${id}.png`, organicScore: 80, holderCount: 5_000, mcap: 1e6, ...o });

describe("the protected set's sources", () => {
  it("protects a trending coin for 72 hours from its last sighting, only with real organic activity", async () => {
    const asked = outside({
      "toporganicscore/5m": [jup("Trend1", "TRND"), jup("Weak1", "WEAK", { organicScore: 20 })],
      "toptrending/1h": [jup("Trend1", "TRND"), jup("Trend2", "MOON")],
    });
    const env = testBindings(url, { JUPITER_API_KEY: "jup-key" });
    expect(await refreshTrending(db, env)).toEqual({ trending: 2 });
    const rows = await rowsOf("trending");
    expect(rows.map((r) => r.ticker).sort()).toEqual(["MOON", "TRND"]);
    expect(rows.every((r) => hoursFromNow(r.protectedUntil) === 72)).toBe(true);
    expect(asked.every((a) => a.key === "jup-key")).toBe(true);
    expect(await db.select().from(protectedImages).where(eq(protectedImages.url, "https://img.test/Trend1.png"))).toMatchObject([{ status: "pending" }]);
  });

  it("asks Jupiter again without the key when the organisation's shared bucket is spent", async () => {
    let keyed = 0;
    const asked = outside({
      "toporganicscore/5m": (req: Request) => (req.headers.get("x-api-key") ? (keyed++, new Response("[API Gateway] Too many requests", { status: 429 })) : Response.json([jup("Trend3", "SPRK")])),
      "toptrending/1h": [],
    });
    await refreshTrending(db, testBindings(url, { JUPITER_API_KEY: { get: async () => "jup-key" } }));
    expect(keyed).toBe(1);
    expect(asked.filter((a) => a.url.includes("5m")).map((a) => a.key)).toEqual(["jup-key", null]);
    expect(await protecting("Trend3")).toBe(true);
  });

  it("protects an organic coin only once it has qualified for 12 hours, and keeps it 7 days after its last sighting", async () => {
    await upsertListed(db, "organic", [listed("Org1", "ORGA")]);
    expect(await protecting("Org1")).toBe(false);
    await upsertListed(db, "organic", [listed("Org1", "ORGA")]);
    expect(await protecting("Org1")).toBe(false);
    await db.update(protectedCoins).set({ createdAt: sql`now() - interval '13 hours'` }).where(eq(protectedCoins.mint, "Org1"));
    await upsertListed(db, "organic", [listed("Org1", "ORGA")]);
    expect(await protecting("Org1")).toBe(true);
    const [row] = await db.select().from(protectedCoins).where(eq(protectedCoins.mint, "Org1"));
    expect(hoursFromNow(row!.protectedUntil)).toBe(7 * 24);
  });

  it("reads CoinGecko's top 1,000 as four pages, tickers upper-cased", async () => {
    const pages: number[] = [];
    const asked = outside({
      "coins/markets": (req: Request) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        pages.push(page);
        return Response.json([{ id: `coin-${page}`, symbol: "btc", name: `Coin ${page}`, image: `https://cg.test/${page}.png`, market_cap_rank: page }]);
      },
    });
    const top = await coinGeckoTop(0, 0);
    expect(pages).toEqual([1, 2, 3, 4]);
    // CoinGecko refuses a request without a User-Agent, as a Worker's fetch sends.
    expect(asked.every((a) => a.agent === USER_AGENT)).toBe(true);
    expect(top[0]).toEqual({ mint: "coin-1", ticker: "BTC", name: "Coin 1", imageUrl: "https://cg.test/1.png", details: { rank: 1, mcap: null } });
  });
});

describe("CoinGecko's limit", () => {
  it("asks a page again after a 429, up to three tries", async () => {
    let tries = 0;
    outside({
      "coins/markets": (req: Request) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        if (page === 1 && tries++ < 2) return new Response("Throttled", { status: 429 });
        return Response.json([{ id: `coin-${page}`, symbol: "eth", name: "Coin", image: null, market_cap_rank: page }]);
      },
    });
    expect(await coinGeckoTop(0, 0)).toHaveLength(4);
    expect(tries).toBe(3);
    tries = -10;
    await expect(coinGeckoTop(0, 0)).rejects.toThrow("CoinGecko answered 429 for page 1");
  });

  it("sends a Demo key when there is one", async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Request(input, init).headers.get("x-cg-demo-api-key"));
      return Response.json([]);
    });
    await coinGeckoTop(0, 0, "cg-demo-key");
    expect(keys).toEqual(["cg-demo-key", "cg-demo-key", "cg-demo-key", "cg-demo-key"]);
  });
});

describe("the hourly refresh", () => {
  it("lapses verified coins Jupiter stops listing, but never on a truncated answer, and reads CoinGecko once a day", async () => {
    const all = Array.from({ length: 10 }, (_, i) => jup(`Ver${i}`, `VER${i}`, { isVerified: true }));
    let verified = all;
    const asked = outside({
      "tag?query=verified": () => Response.json(verified),
      "toporganicscore/24h": [jup("OrgX", "ORGX", { launchpad: "pump.fun", graduatedPool: "Pool1" }), jup("Curve", "CRVE", { launchpad: "pump.fun", graduatedPool: null })],
      "toptraded/24h": [jup("Small", "SMOL", { holderCount: 10 })],
      "toporganicscore/1h": [],
      "coins/markets": [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", image: "https://cg.test/btc.png", market_cap_rank: 1 }],
    });
    const env = testBindings(url);
    const cfg = config(env);
    {
      const first = await refreshLists(db, cfg, env, { coinGeckoPauseMs: 0 });
      expect(first).toMatchObject({ verified: { listed: 10, lapsed: 0 }, organic: { listed: 1 }, coingecko: { listed: 1 } });
      // Off a bonding curve and with enough holders only: OrgX graduated; CRVE is on its curve and SMOL has 10 holders.
      expect((await rowsOf("organic")).map((r) => r.mint)).toContain("OrgX");
      expect((await rowsOf("organic")).map((r) => r.mint)).not.toContain("Curve");

      await db.update(protectedCoins).set({ seenAt: sql`now() - interval '1 hour'` }).where(eq(protectedCoins.source, "jupiter_verified"));
      verified = all.slice(0, 9);
      const second = await refreshLists(db, cfg, env, { coinGeckoPauseMs: 0 });
      expect(second).toMatchObject({ verified: { listed: 9, lapsed: 1 }, coingecko: { due: false } });
      expect(await protecting("Ver9")).toBe(false);
      expect(await protecting("Ver0")).toBe(true);
      expect(asked.filter((a) => a.url.includes("coins/markets"))).toHaveLength(4);

      await db.update(protectedCoins).set({ seenAt: sql`now() - interval '1 hour'` }).where(eq(protectedCoins.source, "jupiter_verified"));
      verified = all.slice(0, 2);
      expect(await refreshLists(db, cfg, env, { coinGeckoPauseMs: 0 })).toMatchObject({ verified: { listed: 2, lapsed: 0 } });
      expect(await protecting("Ver5")).toBe(true);
    }
  });

  it("writes the deletions of rows that were stored without them", async () => {
    await upsertListed(db, "coingecko_top", [listed("old-row", "OLDROW")]);
    await db.update(protectedCoins).set({ tickerLooseDels: [], nameLooseDels: [] }).where(eq(protectedCoins.mint, "old-row"));
    outside({});
    const env = testBindings(url);
    expect(await refreshLists(db, config(env), env, { coinGeckoPauseMs: 0 })).toMatchObject({ refolded: { refolded: 1 } });
    const [row] = await db.select().from(protectedCoins).where(eq(protectedCoins.mint, "old-row"));
    expect(row!.tickerLooseDels).toContain("OLDRO");
  });

  it("keeps going when one provider fails, its error in the summary", async () => {
    outside({ "coins/markets": [], "tag?query=verified": () => new Response("down", { status: 500 }) });
    const env = testBindings(url);
    const summary = await refreshLists(db, config(env), env, { coinGeckoPauseMs: 0 });
    expect(summary.verified).toEqual({ error: "Jupiter answered 500 for tag?query=verified" });
    expect(summary.pruned).toMatchObject({ lapsed: 0 });
  });
});

describe("Heat's own coins", () => {
  const env = () => testBindings(url);

  it("protects a Fair Open's coin, and an Instant coin that reaches 100 holders, with its ticker's key when free", async () => {
    await db.update(coins).set({ launchMode: "fair_open" }).where(eq(coins.mint, MINT));
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ fairOpens: 1 });
    expect(await protecting(MINT)).toBe(true);
    await db.delete(protectedCoins).where(eq(protectedCoins.mint, MINT));

    await db.update(coins).set({ launchMode: "instant" }).where(eq(coins.mint, MINT));
    await db.update(trades).set({ at: sql`now() - interval '10 minutes'` }).where(eq(trades.mint, MINT));
    await db.update(pools).set({ holders: 99, holdersCountedAt: new Date() }).where(eq(pools.mint, MINT));
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ crossed: 0 });
    expect(await protecting(MINT)).toBe(false);
    await db.update(pools).set({ holders: 100, holdersCountedAt: new Date() }).where(eq(pools.mint, MINT));
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ crossed: 1 });
    expect(await protecting(MINT)).toBe(true);
  });

  it("lapses a Heat coin after 7 days below the activity bar, checked once a day", async () => {
    // Its protection's run checked it already; a day later it is due again.
    await db
      .update(protectedCoins)
      .set({ belowBarSince: null, details: sql`${protectedCoins.details} || '{"barCheckedAt":"2000-01-01T00:00:00Z"}'::jsonb` })
      .where(eq(protectedCoins.mint, MINT));
    await db.update(pools).set({ holders: 12, holdersCountedAt: new Date() }).where(eq(pools.mint, MINT));
    await db.update(trades).set({ at: sql`now() - interval '1 day'` }).where(eq(trades.mint, MINT));
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ barChecked: 1, lapsed: 0 });
    const [row] = await db.select().from(protectedCoins).where(eq(protectedCoins.mint, MINT));
    expect(row!.belowBarSince).not.toBeNull();
    // Checked again within the day, nothing is read.
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ barChecked: 0 });
    await db
      .update(protectedCoins)
      .set({ belowBarSince: sql`now() - interval '8 days'`, details: sql`${protectedCoins.details} || '{"barCheckedAt":"2000-01-01T00:00:00Z"}'::jsonb` })
      .where(eq(protectedCoins.mint, MINT));
    expect(await refreshHeat(db, config(env()), env())).toMatchObject({ lapsed: 1 });
    expect(await protecting(MINT)).toBe(false);
  });
});

describe("the image batch", () => {
  it("signs pending images most important first, retries a failure, gives up after 3, and puts the Container to sleep", async () => {
    await db.delete(protectedImages);
    await upsertListed(db, "coingecko_top", [listed("cg-1", "CGA", { details: { mcap: 1 } })]);
    await upsertListed(db, "trending", [listed("tr-1", "TRA")]);
    await upsertListed(db, "jupiter_verified", [listed("dead-1", "DEAD")]);
    const vision = new FakeVision();
    const sig = fakeSignatures("trending-logo");
    vision.byUrl.set("https://img.test/tr-1.png", sig);
    vision.byUrl.set("https://img.test/cg-1.png", { ...fakeSignatures("flat"), pdq: { ...fakeSignatures("flat").pdq, quality: 20 } });
    vision.byUrl.set("https://img.test/dead-1.png", { error: "404 Not Found" });
    const env = testBindings(url, { VISION: vision.binding() });

    const first = await signImages(db, env, 60_000);
    expect(first).toMatchObject({ signed: 2, failed: 1, requests: 1, pending: 1 });
    // The trending coin's image first, then the verified one's, then CoinGecko's.
    expect(vision.fetched.slice(0, 3)).toEqual(["https://img.test/tr-1.png", "https://img.test/dead-1.png", "https://img.test/cg-1.png"]);
    expect(vision.slept).toBe(1);
    const [trending] = await db.select().from(protectedImages).where(eq(protectedImages.url, "https://img.test/tr-1.png"));
    expect(trending).toMatchObject({ status: "done", sha256: sig.sha256, pdq: sig.pdq.bits, pdqQuality: 90 });
    expect(trending!.sscd![0]).toBeCloseTo(sig.sscd[0]!, 6);
    // Too low a quality to trust its PDQ hash: kept for SSCD alone.
    const [flat] = await db.select().from(protectedImages).where(eq(protectedImages.url, "https://img.test/cg-1.png"));
    expect(flat).toMatchObject({ status: "done", pdq: null, pdqQuality: 20 });

    await signImages(db, env, 60_000);
    expect(await signImages(db, env, 60_000)).toMatchObject({ signed: 0, failed: 1, pending: 0 });
    const [dead] = await db.select().from(protectedImages).where(eq(protectedImages.url, "https://img.test/dead-1.png"));
    expect(dead).toMatchObject({ status: "failed", attempts: 3, error: "404 Not Found" });

    // Nothing pending: the Container is not woken.
    const calls = vision.fetched.length;
    expect(await signImages(db, env, 60_000)).toMatchObject({ requests: 0 });
    expect(vision.fetched.length).toBe(calls);
    expect(vision.slept).toBe(3);
  });
});
