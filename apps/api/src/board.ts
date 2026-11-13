// The Discover board (spec 8, 9 screen 1, 10.2, #57): Live now, Up next with its featured slots, Trending, New and
// Graduated, search, and the public mirror of the `CoinRecord` list with its signed daily snapshot. Every list starts
// from `coins`, the mirror of the coins our launch key co-signed, so a pool made around Heat's flow is never on it; the
// calendar lists only Fair Opens Heat's launch service scheduled, sealed: nothing about their coins until the open.
import { createSolanaRpc } from "@solana/kit";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { COIN_SUPPLY, compareCoinRecords, FEE_PROGRAM_ADDRESS, marketCapOfSqrtPrice, readCoinRecords, signSnapshot, type HeatCluster } from "@top-pad/chain";
import type { Board, BoardCoin, CalendarEntry, CoinRecordEntry, CoinRecordList, CoinRecordSnapshot, CoinRecordSnapshotBody, CreatorSummary, QuoteInfo, SearchResults, TrendingFigures } from "@top-pad/contract";
import { coinRadar, coinRecordSnapshots, coins, creators, fairOpens, fairOpenSeatEvents, graduations, launches, pools, quoteConfigPairs, type Db } from "@top-pad/db";
import { trendingOf } from "@top-pad/indexer";
import { summaryOf } from "./creatorRecord";
import type { BlobStore, Bindings, Config, SecretBinding } from "./env";
import type { AppEnv } from "./http";
import { loadKeeper } from "./keeper";
import { quoteInfoOf } from "./quotes";
import { storedLabels } from "./vampShield";

/** How many coins New and Graduated list, and search answers. */
const SECTION_SIZE = 20;
/** The calendar's reach (spec 8): the next 7 days. */
export const CALENDAR_DAYS = 7;
/** Featured slots a day (spec 8), earned by a good record, never sold. */
export const FEATURED_PER_DAY = 3;
/** Trending is worked out again every 15 s (spec 8, 10.2). */
export const TRENDING_EVERY_MS = 15_000;
/** How stale each public read may be in KV (spec 10.4: up to 60 s). */
export const BOARD_CACHE_MS = 15_000;
export const SEARCH_CACHE_MS = 60_000;
export const COIN_RECORDS_CACHE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Coin rows --------------------------------------------------------------------------------------------------------

/** What every coin row reads, one row a coin: its pool, its radar summary, its labels, its Graduation and any finding. */
async function rowsWhere(db: Db, now: Date, where: SQL | undefined, order: SQL[], limit: number) {
  return db
    .select({
      coin: coins,
      pool: pools,
      handle: creators.xHandle,
      radar: coinRadar,
      looksLike: launches.looksLike,
      graduatedAt: graduations.graduatedAt,
      fairOpen: fairOpens.launch,
      confirmedBundle: sql<boolean>`exists (select 1 from bars b where b.mint = ${coins.mint} and b.lifted_at is null and b.publish_at <= ${now.toISOString()}::timestamptz)`,
    })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(creators, eq(creators.id, coins.creatorId))
    .leftJoin(coinRadar, eq(coinRadar.mint, coins.mint))
    .leftJoin(launches, eq(launches.mint, coins.mint))
    .leftJoin(graduations, eq(graduations.mint, coins.mint))
    .leftJoin(fairOpens, eq(fairOpens.mint, coins.mint))
    .where(where)
    .orderBy(...order)
    .limit(limit);
}

type Row = Awaited<ReturnType<typeof rowsWhere>>[number];

/** Each listed quote's info, read once per answer; a quote no longer listed leaves its coins out, said in the logs. */
async function quotesOf(cfg: Config, heat: HeatCluster, mints: string[]): Promise<Map<string, QuoteInfo>> {
  const infos = new Map<string, QuoteInfo>();
  for (const mint of new Set(mints)) {
    try {
      infos.set(mint, await quoteInfoOf(cfg, heat, mint));
    } catch (e) {
      console.warn(`the board leaves out coins priced in ${mint}`, e);
    }
  }
  return infos;
}

/** Coin rows as the board shows them, in the rows' order, with Trending's figures where given. */
async function coinRows(cfg: Config, heat: HeatCluster, rows: Row[], trending?: Map<string, TrendingFigures>): Promise<BoardCoin[]> {
  const quotes = await quotesOf(cfg, heat, rows.map((r) => r.pool.quoteMint));
  return rows.flatMap(({ coin, pool, handle, radar, looksLike, graduatedAt, fairOpen, confirmedBundle }): BoardCoin[] => {
    const quote = quotes.get(pool.quoteMint);
    if (!quote) return [];
    return [
      {
        mint: coin.mint,
        name: coin.name,
        ticker: coin.ticker,
        imageUri: coin.imageUri,
        launchMode: coin.launchMode,
        listedAt: coin.createdAt.toISOString(),
        creator: { wallet: coin.creatorWallet, handle },
        quote,
        marketCap: marketCapOfSqrtPrice(BigInt(pool.sqrtPrice), quote.decimals),
        quoteReserve: pool.quoteReserve.toString(),
        graduationTarget: pool.graduationTarget.toString(),
        graduatedAt: graduatedAt?.toISOString() ?? null,
        holders: pool.holders,
        fairOpen,
        supply: COIN_SUPPLY.toString(),
        flags: {
          linked: { wallets: radar?.linkedWallets.length ?? 0, coins: (radar?.linkedCoins ?? 0n).toString() },
          earlyBuys: radar?.earlyBuys ?? 0,
          looksLike: storedLabels(looksLike),
          confirmedBundle: Boolean(confirmedBundle),
        },
        trending: trending?.get(coin.mint) ?? null,
      },
    ];
  });
}

/** Trending's coins as rows (spec 8): ranked by one query, then read as rows. */
export async function trendingRows(cfg: Config, heat: HeatCluster, db: Db, now = new Date()): Promise<BoardCoin[]> {
  const ranked = await trendingOf(db, { now });
  if (!ranked.length) return [];
  const figures = new Map(ranked.map((t) => [t.mint, { buyers: t.buyers, score: t.score, volume: t.volume }]));
  const rows = await rowsWhere(db, now, inArray(coins.mint, [...figures.keys()]), [asc(coins.mint)], ranked.length);
  const order = new Map(ranked.map((t, i) => [t.mint, i]));
  rows.sort((a, b) => order.get(a.coin.mint)! - order.get(b.coin.mint)!);
  return coinRows(cfg, heat, rows, figures);
}

// --- The calendar -----------------------------------------------------------------------------------------------------

/** What the pot of each launch holds now, and its seats: each seat's latest deposit or withdrawal says what it holds. */
async function potsOf(db: Db, launchAddresses: string[]): Promise<Map<string, { total: bigint; seats: number }>> {
  if (!launchAddresses.length) return new Map();
  const latest = db
    .selectDistinctOn([fairOpenSeatEvents.launch, fairOpenSeatEvents.wallet], { launch: fairOpenSeatEvents.launch, deposit: fairOpenSeatEvents.deposit })
    .from(fairOpenSeatEvents)
    .where(and(inArray(fairOpenSeatEvents.launch, launchAddresses), inArray(fairOpenSeatEvents.kind, ["deposit", "withdraw"])))
    .orderBy(fairOpenSeatEvents.launch, fairOpenSeatEvents.wallet, desc(fairOpenSeatEvents.slot), desc(fairOpenSeatEvents.eventIndex))
    .as("latest");
  const rows = await db
    .select({ launch: latest.launch, total: sql<string>`coalesce(sum(${latest.deposit}), 0)::text`, seats: sql<number>`(count(*) filter (where ${latest.deposit} > 0))::int` })
    .from(latest)
    .groupBy(latest.launch);
  return new Map(rows.map((r) => [r.launch, { total: BigInt(r.total), seats: Number(r.seats) }]));
}

/** A good record (spec 7): one graduated Heat coin, no Bar and no open case; the verified-creator mark says exactly that. */
const goodRecord = (record: CreatorSummary | null) => Boolean(record?.marks.verifiedCreator && !record.barred);

/**
 * Each day's three featured slots (spec 8): among the day's Fair Opens whose record is good, the highest graduation rate
 * first, then the most recent graduation, then the earliest open. Days are UTC days, by the open.
 */
export function featuredOf<T extends { launch: string; opensAt: string; record: CreatorSummary | null }>(entries: T[]): Set<string> {
  const byDay = new Map<string, T[]>();
  for (const e of entries) {
    if (!goodRecord(e.record)) continue;
    const day = e.opensAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const featured = new Set<string>();
  for (const day of byDay.values()) {
    day.sort(
      (a, b) =>
        (b.record!.graduationRate ?? 0) - (a.record!.graduationRate ?? 0) ||
        (b.record!.lastGraduatedAt ?? "").localeCompare(a.record!.lastGraduatedAt ?? "") ||
        a.opensAt.localeCompare(b.opensAt),
    );
    for (const e of day.slice(0, FEATURED_PER_DAY)) featured.add(e.launch);
  }
  return featured;
}

/**
 * Live now (windows in progress) and Up next (the next 7 days), sealed: Fair Opens Heat's launch service scheduled and
 * that landed, not cancelled by a Bar, not yet opened, failed or due.
 */
export async function calendarOf(cfg: Config, heat: HeatCluster, db: Db, now = new Date()): Promise<{ liveNow: CalendarEntry[]; upNext: CalendarEntry[] }> {
  const rows = await db
    .select({ fo: fairOpens, creatorId: launches.creatorId, launchTeaser: launches.teaser, handle: creators.xHandle })
    .from(fairOpens)
    .innerJoin(launches, eq(launches.fairOpen, fairOpens.launch))
    .leftJoin(creators, eq(creators.id, launches.creatorId))
    .where(
      and(
        eq(fairOpens.status, "scheduled"),
        eq(launches.status, "landed"),
        isNull(launches.cancelledAt),
        gt(fairOpens.opensAt, now),
        lte(fairOpens.opensAt, new Date(now.getTime() + CALENDAR_DAYS * DAY_MS)),
      ),
    )
    .orderBy(asc(fairOpens.opensAt), asc(fairOpens.launch));
  const summaries = new Map<string, CreatorSummary | null>();
  for (const id of new Set(rows.map((r) => r.creatorId))) summaries.set(id, await summaryOf(db, id, now));
  const quotes = await quotesOf(cfg, heat, rows.map((r) => r.fo.quoteMint));
  const pots = await potsOf(db, rows.filter((r) => r.fo.depositsOpenAt <= now).map((r) => r.fo.launch));
  const entries = rows.flatMap(({ fo, creatorId, launchTeaser, handle }): CalendarEntry[] => {
    const quote = quotes.get(fo.quoteMint);
    if (!quote) return [];
    const pot = pots.get(fo.launch) ?? { total: 0n, seats: 0 };
    return [
      {
        launch: fo.launch,
        phase: fo.depositsOpenAt <= now ? "window" : "scheduled",
        depositsOpenAt: fo.depositsOpenAt.toISOString(),
        opensAt: fo.opensAt.toISOString(),
        creator: { wallet: fo.creator, handle },
        record: summaries.get(creatorId) ?? null,
        teaser: fo.teaser ?? launchTeaser,
        quote,
        minRaise: fo.minRaise.toString(),
        potCap: fo.potCap.toString(),
        pot: { total: pot.total.toString(), seats: pot.seats },
        featured: false,
      },
    ];
  });
  const featured = featuredOf(entries);
  for (const e of entries) e.featured = featured.has(e.launch);
  return { liveNow: entries.filter((e) => e.phase === "window"), upNext: entries.filter((e) => e.phase === "scheduled") };
}

// --- KV ---------------------------------------------------------------------------------------------------------------

/** What the API needs of its KV namespace: public caches only (spec 10.4). */
export type KvCache = {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

/** KV keeps nothing under a minute (its least expiry), so each value carries when it was made, and readers judge its age. */
const KV_MIN_TTL_SECONDS = 60;

/**
 * A public read through KV: the cached value while younger than `maxAgeMs`, else worked out afresh and cached. KV failing
 * never fails the read.
 */
export async function cached<T>(c: Context<AppEnv>, key: string, maxAgeMs: number, compute: () => Promise<T>): Promise<T> {
  const kv = c.env.CACHE;
  if (kv) {
    try {
      const hit = (await kv.get(key, "json")) as { at: number; value: T } | null;
      if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
    } catch (e) {
      console.warn(`reading ${key} from KV failed`, e);
    }
  }
  const value = await compute();
  if (kv) {
    const put = kv.put(key, JSON.stringify({ at: Date.now(), value }), { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(maxAgeMs / 1000)) });
    c.executionCtx.waitUntil(put.catch((e) => console.warn(`writing ${key} to KV failed`, e)));
  }
  return value;
}

// --- Routes -----------------------------------------------------------------------------------------------------------

/** Trending as the board's Durable Object last worked it out, or worked out here where none is bound (tests). */
async function currentTrending(c: Context<AppEnv>, heat: HeatCluster): Promise<{ trending: BoardCoin[]; at: string }> {
  const board = c.env.BOARD;
  if (board) return board.get(board.idFromName("board")).trending();
  const now = new Date();
  return { trending: await trendingRows(c.var.cfg, heat, c.var.db, now), at: now.toISOString() };
}

const emptyBoard = (now: Date): Board => ({ liveNow: [], upNext: [], trending: [], trendingAt: now.toISOString(), new: [], graduated: [], serverTime: now.toISOString() });

/** `GET /board`. */
export async function getBoard(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const heat = cfg.heat;
  c.header("cache-control", "no-store");
  if (!heat) return c.json(emptyBoard(new Date()));
  const [rest, trending] = await Promise.all([
    cached(c, "board:v1", BOARD_CACHE_MS, async () => {
      const now = new Date();
      const [calendar, fresh, graduated] = await Promise.all([
        calendarOf(cfg, heat, db, now),
        rowsWhere(db, now, undefined, [desc(coins.createdAt), asc(coins.mint)], SECTION_SIZE).then((rows) => coinRows(cfg, heat, rows)),
        rowsWhere(db, now, sql`${graduations.graduatedAt} is not null`, [desc(graduations.graduatedAt), asc(coins.mint)], SECTION_SIZE).then((rows) => coinRows(cfg, heat, rows)),
      ]);
      return { ...calendar, new: fresh, graduated };
    }),
    currentTrending(c, heat),
  ]);
  const now = new Date();
  // A window that began or an open that passed since the cache was filled moves on here, so a countdown never runs past zero.
  const all = [...rest.liveNow, ...rest.upNext].filter((e) => new Date(e.opensAt) > now);
  const live = (e: CalendarEntry) => new Date(e.depositsOpenAt) <= now;
  const body: Board = {
    liveNow: all.filter(live).map((e) => ({ ...e, phase: "window" as const })),
    upNext: all.filter((e) => !live(e)),
    trending: trending.trending,
    trendingAt: trending.at,
    new: rest.new,
    graduated: rest.graduated,
    serverTime: now.toISOString(),
  };
  return c.json(body);
}

const SEARCH_MAX = 64;

/** `GET /search?q=`: name, ticker or mint; an exact ticker first, then tickers and names that start with it, newest first. */
export async function search(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const heat = cfg.heat;
  const query = (c.req.query("q") ?? "").trim().replace(/^\$/, "").slice(0, SEARCH_MAX);
  c.header("cache-control", "no-store");
  if (!heat || !query) return c.json({ query, coins: [] } satisfies SearchResults);
  const body = await cached(c, `search:v1:${query.toLowerCase()}`, SEARCH_CACHE_MS, async () => {
    const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const prefix = `${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rank = sql`case when lower(${coins.ticker}) = lower(${query}) then 0 when ${coins.mint} = ${query} then 0 when ${coins.ticker} ilike ${prefix} or ${coins.name} ilike ${prefix} then 1 else 2 end`;
    const rows = await rowsWhere(
      db,
      new Date(),
      or(sql`${coins.ticker} ilike ${pattern}`, sql`${coins.name} ilike ${pattern}`, eq(coins.mint, query)),
      [asc(rank), desc(coins.createdAt), asc(coins.mint)],
      SECTION_SIZE,
    );
    return { query, coins: await coinRows(cfg, heat, rows) } satisfies SearchResults;
  });
  return c.json(body);
}

// --- The CoinRecord list ----------------------------------------------------------------------------------------------

const RECORDS_PAGE = 1_000;
const AFTER = /^(\d{1,20}):([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** The mirror's entries, oldest first: from `coins`, with each Fair Open coin's launch. */
async function recordEntries(db: Db, where: SQL | undefined, limit?: number): Promise<CoinRecordEntry[]> {
  const query = db
    .select({ coin: coins, fairOpen: fairOpens.launch })
    .from(coins)
    .leftJoin(fairOpens, eq(fairOpens.mint, coins.mint))
    .where(where)
    .orderBy(asc(coins.createdSlot), asc(coins.mint));
  const rows = limit ? await query.limit(limit) : await query;
  return rows.map(({ coin, fairOpen }) => ({
    mint: coin.mint,
    pool: coin.pool,
    config: coin.config,
    launchMode: coin.launchMode,
    fairOpenLaunch: fairOpen,
    slot: coin.createdSlot,
    registeredAt: coin.createdAt.toISOString(),
  }));
}

/** `GET /coin-records?after=<slot>:<mint>&limit=`: the public mirror of the `CoinRecord` list. */
export async function getCoinRecords(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const launchKey = cfg.heat?.keys?.keeper;
  if (!launchKey) return c.json({ error: "Heat lists no coins on this cluster." }, 404);
  const after = c.req.query("after");
  const match = after ? AFTER.exec(after) : null;
  if (after && !match) return c.json({ error: "`after` is the `next` of the page before." }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? RECORDS_PAGE) || RECORDS_PAGE, 1), RECORDS_PAGE);
  c.header("cache-control", "no-store");
  const body = await cached(c, `coin-records:v1:${after ?? ""}:${limit}`, COIN_RECORDS_CACHE_MS, async () => {
    const where = match ? sql`(${coins.createdSlot}, ${coins.mint}) > (${Number(match[1])}, ${match[2]})` : undefined;
    const entries = await recordEntries(db, where, limit + 1);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    const list: CoinRecordList = {
      cluster: cfg.cluster,
      program: FEE_PROGRAM_ADDRESS,
      launchKey,
      coins: page,
      next: entries.length > limit && last ? `${last.slot}:${last.mint}` : null,
    };
    return list;
  });
  return c.json(body);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `GET /coin-records/snapshots/:day`, or `latest`: a day's signed snapshot, its body byte for byte as signed. */
export async function getCoinRecordSnapshot(c: Context<AppEnv>) {
  const { db } = c.var;
  const day = c.req.param("day")!;
  if (day !== "latest" && !DAY.test(day)) return c.json({ error: "Ask for a day as YYYY-MM-DD, or latest." }, 400);
  const [row] = await db
    .select()
    .from(coinRecordSnapshots)
    .where(day === "latest" ? undefined : eq(coinRecordSnapshots.day, day))
    .orderBy(desc(coinRecordSnapshots.day))
    .limit(1);
  const stored = row ? await c.env.BLOBS?.get(row.storageKey) : null;
  if (!row || !stored) return c.json({ error: "No snapshot of that day." }, 404);
  const body: CoinRecordSnapshot = {
    day: row.day,
    coins: row.coins,
    body: new TextDecoder().decode(await stored.arrayBuffer()),
    sha256: row.sha256,
    message: `heat:coin-records:v1:${row.sha256}`,
    signer: row.signer,
    signature: row.signature,
    createdAt: row.createdAt.toISOString(),
  };
  c.header("cache-control", day === "latest" ? "no-store" : "public, max-age=3600");
  return c.json(body);
}

/** Where a day's snapshot body is kept in R2 (spec 10.4). */
export const snapshotKey = (cluster: string, day: string) => `coin-records/${cluster}/${day}.json`;

/**
 * The daily snapshot (spec 8): once a UTC day has ended, every coin the mirror lists registered before its end, signed by
 * the launch key, kept in R2 and recorded with how it compared with the chain's `CoinRecord` accounts. Skips a day
 * already made; a chain that cannot be read leaves the comparison null, the snapshot still made.
 */
export async function snapshotCoinRecords(db: Db, cfg: Config, keeperKey: SecretBinding | null, blobs: BlobStore | undefined, now = new Date()) {
  const launchKey = cfg.heat?.keys?.keeper;
  if (!launchKey || !keeperKey || !blobs) return { skipped: "no launch key or R2 bound" };
  const through = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const day = new Date(through.getTime() - DAY_MS).toISOString().slice(0, 10);
  const [done] = await db.select({ day: coinRecordSnapshots.day }).from(coinRecordSnapshots).where(eq(coinRecordSnapshots.day, day));
  if (done) return { day, skipped: "made already" };

  const entries = await recordEntries(db, sql`${coins.createdAt} < ${through.toISOString()}::timestamptz`);
  const pairs = await db.select({ fairOpen: quoteConfigPairs.fairOpenConfig, instant: quoteConfigPairs.instantConfig }).from(quoteConfigPairs);
  const heatConfigs = cfg.heat?.configs ? [cfg.heat.configs.fairOpen, cfg.heat.configs.instant] : [];
  const configs = [...new Set([...heatConfigs, ...pairs.flatMap((p) => [p.fairOpen, p.instant])])].sort();
  const snapshot: CoinRecordSnapshotBody = { version: 1, cluster: cfg.cluster, day, through: through.toISOString(), program: FEE_PROGRAM_ADDRESS, launchKey, configs, coins: entries };
  const body = JSON.stringify(snapshot);
  const keeper = await loadKeeper(keeperKey, launchKey);
  const signed = await signSnapshot(body, keeper.signer);

  let chainCoins: number | null = null;
  let mismatches: ReturnType<typeof compareCoinRecords> | null = null;
  try {
    const chain = await readCoinRecords(createSolanaRpc(cfg.rpcUrl), AbortSignal.timeout(30_000));
    chainCoins = chain.filter((r) => new Date(r.registeredAt) < through && r.config !== null && configs.includes(r.config)).length;
    mismatches = compareCoinRecords(entries, chain, through, configs);
  } catch (e) {
    console.error("reading the CoinRecord accounts failed", e);
  }
  const storageKey = snapshotKey(cfg.cluster, day);
  await blobs.put(storageKey, new TextEncoder().encode(body), { httpMetadata: { contentType: "application/json" } });
  await db
    .insert(coinRecordSnapshots)
    .values({ day, coins: entries.length, sha256: signed.sha256, signer: launchKey, signature: signed.signature, storageKey, chainCoins, mismatches })
    .onConflictDoNothing();
  const differs = mismatches && (mismatches.missing.length || mismatches.extra.length || mismatches.different.length);
  if (differs) console.error(`the ${day} snapshot differs from the chain`, mismatches);
  return { day, coins: entries.length, chainCoins, mismatches };
}

/** The keeper key as a binding, from a Secrets Store binding or a plain var, or null. */
export const keeperKeyOf = (env: Bindings): SecretBinding | null =>
  env.KEEPER_KEY ? (typeof env.KEEPER_KEY === "string" ? { get: async () => env.KEEPER_KEY as string } : env.KEEPER_KEY) : null;
