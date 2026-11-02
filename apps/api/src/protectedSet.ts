// The protected set (spec 6.2, 10.2): the coins a launch may not copy, kept fresh by the cron. Jupiter's trending lists
// every minute (each coin protected for 72 hours from its last sighting), its verified and organic lists hourly,
// CoinGecko's top 1,000 daily, and Heat's own coins as they cross the protection bar: a completed Fair Open or 100
// holders, lapsing after 7 days below the activity bar (organic score under 30 and under 300 holders). Each coin's image
// waits in `protected_images` until an image batch has the vision service sign it, so the Container wakes once an hour
// for the new ones rather than for every coin. Starting values, all of them (research/copycat-detection section 4).
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { holderCount } from "@top-pad/indexer";
import { coins, imageChecks, launches, pools, protectedCoins, protectedImages, trades, type Db } from "@top-pad/db";
import { candidateKeys, deletions, FOLD_VERSION, PDQ_MIN_QUALITY, tickerKey } from "@top-pad/vamp-shield";
import type { Bindings, Config, SecretBinding } from "./env";
import { visionOf } from "./vision";

/** A coin a source lists, as the protected set keeps it. */
export type Listed = { mint: string; ticker: string; name: string; imageUrl: string | null; details: Record<string, unknown> };
type Source = (typeof protectedCoins.$inferInsert)["source"];

/** How long a coin seen trending stays protected after its last sighting (spec 12). */
export const TRENDING_HOURS = 72;
/** The organic score from which a trending coin is protected, and the organic bar a Solana coin must clear. */
export const ORGANIC_SCORE = 50;
/** The organic bar's other tests: holders, market cap in USD (research/copycat-detection section 4, tier A2). */
export const ORGANIC_HOLDERS = 1_000;
export const ORGANIC_MCAP_USD = 250_000;
/** An organic coin is protected only once it has qualified for 12 hours, and lapses 7 days after it last did. */
export const ORGANIC_CONFIRM_HOURS = 12;
export const ORGANIC_KEEP_DAYS = 7;
/** A coin of CoinGecko's top 1,000 stays protected 2 days after it was last listed, so one failed day lapses nothing. */
export const COINGECKO_KEEP_HOURS = 48;
/** Heat's bar (spec 6.2): 100 holders protect a coin; under 300 holders and an organic score under 30 for 7 days lapse it. */
export const HEAT_HOLDERS = 100;
export const BAR_HOLDERS = 300;
export const BAR_ORGANIC_SCORE = 30;
export const BAR_DAYS = 7;

const JUPITER = "https://api.jup.ag/tokens/v2";
const COINGECKO = "https://api.coingecko.com/api/v3";
const FETCH_TIMEOUT_MS = 30_000;

// Lists from outside.

/** The fields of Jupiter's `MintInformation` the protected set reads. */
type JupiterToken = {
  id: string;
  name: string;
  symbol: string;
  icon?: string | null;
  organicScore?: number | null;
  holderCount?: number | null;
  mcap?: number | null;
  launchpad?: string | null;
  graduatedPool?: string | null;
  isVerified?: boolean | null;
};

async function secret(value: SecretBinding | string | undefined): Promise<string | null> {
  if (!value) return null;
  return typeof value === "string" ? value : value.get();
}

/**
 * A Jupiter Tokens API list. With the key first, since keyless calls share 0.5 requests a second; a keyed call refused
 * with 429, when other users of the same organisation have spent its bucket, is tried once more without it.
 */
export async function jupiterList(env: Bindings, path: string): Promise<JupiterToken[]> {
  const key = await secret(env.JUPITER_API_KEY);
  const url = `${JUPITER}/${path}`;
  let res = await fetch(url, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 429 && key) res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Jupiter answered ${res.status} for ${path}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error(`Jupiter's ${path} is not a list`);
  return body as JupiterToken[];
}

const fromJupiter = (t: JupiterToken): Listed => ({
  mint: t.id,
  ticker: t.symbol ?? "",
  name: t.name ?? "",
  imageUrl: t.icon || null,
  details: { organicScore: t.organicScore ?? null, holders: t.holderCount ?? null, mcap: t.mcap ?? null, launchpad: t.launchpad ?? null },
});

/** Jupiter's trending now (tier A3): its top organic coins of 5 minutes and top trending of the hour, with real activity. */
export async function trendingNow(env: Bindings): Promise<Listed[]> {
  const lists = await Promise.all(["toporganicscore/5m?limit=100", "toptrending/1h?limit=100"].map((p) => jupiterList(env, p)));
  return unique(lists.flat().filter((t) => (t.organicScore ?? 0) >= ORGANIC_SCORE).map(fromJupiter));
}

/** Jupiter's verified coins (tier A1): every one, which the tag endpoint returns whole. */
export async function verifiedNow(env: Bindings): Promise<Listed[]> {
  return unique((await jupiterList(env, "tag?query=verified")).map(fromJupiter));
}

/**
 * Solana coins with real organic activity (tier A2), from Jupiter's top organic and top traded lists of the day: organic
 * score 50 or more, 1,000 or more holders, a market cap of $250,000 or more, and off any launchpad's bonding curve.
 */
export async function organicNow(env: Bindings): Promise<Listed[]> {
  const lists = await Promise.all(["toporganicscore/24h?limit=100", "toptraded/24h?limit=100", "toporganicscore/1h?limit=100"].map((p) => jupiterList(env, p)));
  return unique(
    lists
      .flat()
      .filter(
        (t) =>
          !t.isVerified &&
          (t.organicScore ?? 0) >= ORGANIC_SCORE &&
          (t.holderCount ?? 0) >= ORGANIC_HOLDERS &&
          (t.mcap ?? 0) >= ORGANIC_MCAP_USD &&
          (t.graduatedPool != null || t.launchpad == null),
      )
      .map(fromJupiter),
  );
}

type CoinGeckoCoin = { id: string; symbol: string; name: string; image?: string | null; market_cap_rank?: number | null; market_cap?: number | null };

/** CoinGecko's top 1,000 by market cap (tier A4), the top coins of every chain, four pages of 250 read 3 s apart. */
export async function coinGeckoTop(pauseMs = 3_000): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (let page = 1; page <= 4; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, pauseMs));
    const res = await fetch(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`CoinGecko answered ${res.status} for page ${page}`);
    const body = (await res.json()) as CoinGeckoCoin[];
    for (const c of body) {
      listed.push({ mint: c.id, ticker: (c.symbol ?? "").toUpperCase(), name: c.name ?? "", imageUrl: c.image || null, details: { rank: c.market_cap_rank ?? null, mcap: c.market_cap ?? null } });
    }
  }
  return unique(listed);
}

const unique = (listed: Listed[]) => [...new Map(listed.filter((l) => l.mint).map((l) => [l.mint, l])).values()];

// Writing them.

/** How each source's rows protect, as SQL: from when, until when, written on insert and on each later sighting. */
function policy(source: Source): { from: ReturnType<typeof sql>; until: ReturnType<typeof sql> | null; fromOnUpdate: ReturnType<typeof sql>; untilOnUpdate: ReturnType<typeof sql> | null } {
  switch (source) {
    case "trending": {
      const until = sql`now() + make_interval(hours => ${TRENDING_HOURS})`;
      return { from: sql`now()`, until, fromOnUpdate: sql`least(${protectedCoins.protectedFrom}, now())`, untilOnUpdate: until };
    }
    case "organic": {
      // Not protected on its first sighting: protection starts at a sighting 12 hours or more after the first.
      const until = sql`now() + make_interval(days => ${ORGANIC_KEEP_DAYS})`;
      return {
        from: sql`'infinity'::timestamptz`,
        until,
        fromOnUpdate: sql`case when ${protectedCoins.protectedFrom} > now() and ${protectedCoins.createdAt} <= now() - make_interval(hours => ${ORGANIC_CONFIRM_HOURS}) then now() else ${protectedCoins.protectedFrom} end`,
        untilOnUpdate: until,
      };
    }
    case "coingecko_top": {
      const until = sql`now() + make_interval(hours => ${COINGECKO_KEEP_HOURS})`;
      return { from: sql`now()`, until, fromOnUpdate: sql`least(${protectedCoins.protectedFrom}, now())`, untilOnUpdate: until };
    }
    // Verified and Heat coins stay protected while they qualify; their lapse is written apart.
    case "jupiter_verified":
    case "heat":
      return { from: sql`now()`, until: null, fromOnUpdate: sql`least(${protectedCoins.protectedFrom}, now())`, untilOnUpdate: sql`null` };
  }
}

/** A ticker's and a name's six keys folded now, with the deletions their loose keys are found one edit away by. */
function keyColumns(ticker: string, name: string) {
  const keys = candidateKeys(ticker, name);
  return {
    tickerStrict: keys.ticker.strict,
    tickerLoose: keys.ticker.loose,
    tickerCore: keys.ticker.core,
    nameStrict: keys.name.strict,
    nameLoose: keys.name.loose,
    nameCore: keys.name.core,
    tickerLooseDels: deletions(keys.ticker.loose),
    nameLooseDels: deletions(keys.name.loose),
    foldVersion: FOLD_VERSION,
  };
}

const rowOf = (source: Source, l: Listed) => ({
  mint: l.mint,
  source,
  ticker: l.ticker,
  name: l.name,
  ...keyColumns(l.ticker, l.name),
  imageUrl: l.imageUrl,
  details: l.details,
});

/** Writes a source's listing: new coins in, known ones refreshed, their images queued for signing. */
export async function upsertListed(db: Db, source: Source, listed: Listed[]): Promise<{ written: number }> {
  const p = policy(source);
  for (let i = 0; i < listed.length; i += 500) {
    const batch = listed.slice(i, i + 500);
    await db
      .insert(protectedCoins)
      .values(batch.map((l) => ({ ...rowOf(source, l), protectedFrom: p.from, protectedUntil: p.until, seenAt: sql`now()` })))
      .onConflictDoUpdate({
        target: [protectedCoins.mint, protectedCoins.source],
        set: {
          ticker: sql`excluded.ticker`,
          name: sql`excluded.name`,
          tickerStrict: sql`excluded.ticker_strict`,
          tickerLoose: sql`excluded.ticker_loose`,
          tickerCore: sql`excluded.ticker_core`,
          nameStrict: sql`excluded.name_strict`,
          nameLoose: sql`excluded.name_loose`,
          nameCore: sql`excluded.name_core`,
          tickerLooseDels: sql`excluded.ticker_loose_dels`,
          nameLooseDels: sql`excluded.name_loose_dels`,
          foldVersion: sql`excluded.fold_version`,
          imageUrl: sql`excluded.image_url`,
          details: sql`excluded.details`,
          protectedFrom: p.fromOnUpdate,
          protectedUntil: p.untilOnUpdate ?? sql`null`,
          seenAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    const urls = [...new Set(batch.flatMap((l) => (l.imageUrl ? [l.imageUrl] : [])))];
    if (urls.length > 0) await db.insert(protectedImages).values(urls.map((url) => ({ url }))).onConflictDoNothing();
  }
  return { written: listed.length };
}

/**
 * Lapses the verified coins Jupiter no longer lists. Skipped when this listing is much shorter than the set it would
 * prune, since a truncated answer must never lapse thousands of coins at once.
 */
async function lapseUnlisted(db: Db, source: Source, listed: Listed[]): Promise<{ lapsed: number }> {
  const [{ current } = { current: 0 }] = await db
    .select({ current: sql<number>`count(*)::int` })
    .from(protectedCoins)
    .where(and(eq(protectedCoins.source, source), isNull(protectedCoins.protectedUntil)));
  if (listed.length < current * 0.8) {
    console.warn(`${source}: ${listed.length} listed against ${current} protected; nothing lapsed`);
    return { lapsed: 0 };
  }
  const rows = await db
    .update(protectedCoins)
    .set({ protectedUntil: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(protectedCoins.source, source), isNull(protectedCoins.protectedUntil), lt(protectedCoins.seenAt, sql`now() - interval '10 minutes'`)))
    .returning({ id: protectedCoins.id });
  return { lapsed: rows.length };
}

// Heat's own coins.

/** A Heat coin as the protected set reads it: its coin and the launch it came from. */
type HeatCoin = { mint: string; ticker: string; name: string; imageUri: string | null; launchId: string | null };

/**
 * Protects a Heat coin (spec 6.2): its row in the protected set, its image's signatures copied from its launch's own check
 * (so the vision service never signs a Heat image twice), and its ticker's strict key in the unique index, unless another
 * launch holds it, as a Fair Open in its window can.
 */
export async function protectHeatCoin(db: Db, coin: HeatCoin, details: Record<string, unknown>): Promise<{ key: boolean }> {
  await upsertListed(db, "heat", [{ mint: coin.mint, ticker: coin.ticker, name: coin.name, imageUrl: coin.imageUri, details }]);
  if (!coin.launchId) return { key: false };
  const [launch] = await db.select({ imageSha256: launches.imageSha256, tickerKey: launches.tickerKey }).from(launches).where(eq(launches.id, coin.launchId));
  if (launch?.imageSha256 && coin.imageUri) {
    const [checked] = await db.select().from(imageChecks).where(eq(imageChecks.sha256, launch.imageSha256));
    if (checked) {
      await db
        .update(protectedImages)
        .set({
          status: "done",
          sha256: checked.sha256,
          pdq: checked.pdqQuality >= PDQ_MIN_QUALITY ? checked.pdqDihedral[0]! : null,
          pdqQuality: checked.pdqQuality,
          sscd: checked.sscd,
          computedAt: sql`now()`,
        })
        .where(and(eq(protectedImages.url, coin.imageUri), ne(protectedImages.status, "done")));
    }
  }
  if (launch?.tickerKey) return { key: true };
  try {
    const rows = await db
      .update(launches)
      .set({ tickerKey: tickerKey(coin.ticker) })
      .where(and(eq(launches.id, coin.launchId), isNull(launches.tickerKey)))
      .returning({ id: launches.id });
    return { key: rows.length > 0 };
  } catch (e) {
    const pg = ((e as { cause?: { code?: string } }).cause ?? e) as { code?: string };
    if (pg.code === "23505") return { key: false };
    throw e;
  }
}

/** How many Heat coins' holders one run counts at most, 250 ms apart, so the protected set never crowds the RPC. */
const HOLDER_COUNTS_PER_RUN = 20;

/**
 * Heat's coins against the protection bar: every Fair Open's coin is protected from its open (the keeper's Workflow
 * protects it then; this catches any it missed); an Instant coin, or a lapsed one, once it holds 100 holders, counted
 * only for coins traded in the last two hours; and a protected coin's activity read once a day, lapsing after 7 days
 * below the bar. On devnet there is no organic score (Jupiter indexes mainnet only), so holders alone decide.
 */
export async function refreshHeat(db: Db, cfg: Config, env: Bindings): Promise<Record<string, number>> {
  const fairOpen = await db
    .select({ mint: coins.mint, ticker: coins.ticker, name: coins.name, imageUri: coins.imageUri, launchId: launches.id })
    .from(coins)
    .leftJoin(launches, eq(launches.mint, coins.mint))
    .where(
      and(
        eq(coins.launchMode, "fair_open"),
        sql`not exists (select 1 from ${protectedCoins} where ${protectedCoins.mint} = ${coins.mint} and ${protectedCoins.source} = 'heat')`,
      ),
    );
  for (const coin of fairOpen) await protectHeatCoin(db, coin, { reason: "fair_open" });

  let counted = 0;
  const pause = () => new Promise((r) => setTimeout(r, 250));
  const active = await db
    .selectDistinct({ mint: coins.mint, ticker: coins.ticker, name: coins.name, imageUri: coins.imageUri, launchId: launches.id })
    .from(trades)
    .innerJoin(coins, eq(coins.mint, trades.mint))
    .leftJoin(launches, eq(launches.mint, coins.mint))
    .where(
      and(
        sql`${trades.at} > now() - interval '2 hours'`,
        sql`not exists (select 1 from ${protectedCoins} where ${protectedCoins.mint} = ${coins.mint} and ${protectedCoins.source} = 'heat' and (${protectedCoins.protectedUntil} is null or ${protectedCoins.protectedUntil} > now()))`,
      ),
    )
    .limit(HOLDER_COUNTS_PER_RUN);
  let crossed = 0;
  for (const coin of active) {
    const holders = await countHolders(db, cfg, coin.mint).catch(() => null);
    counted++;
    await pause();
    if (holders !== null && holders >= HEAT_HOLDERS) {
      // A lapsed row is taken back to protecting: a coin that crosses the bar again earns protection again.
      await db.update(protectedCoins).set({ belowBarSince: null }).where(and(eq(protectedCoins.mint, coin.mint), eq(protectedCoins.source, "heat")));
      await protectHeatCoin(db, coin, { reason: "holders", holders });
      crossed++;
    }
  }

  const due = await db
    .select({ id: protectedCoins.id, mint: protectedCoins.mint, belowBarSince: protectedCoins.belowBarSince })
    .from(protectedCoins)
    .where(
      and(
        eq(protectedCoins.source, "heat"),
        isNull(protectedCoins.protectedUntil),
        sql`coalesce((${protectedCoins.details}->>'barCheckedAt')::timestamptz, 'epoch') < now() - interval '23 hours'`,
      ),
    )
    .limit(HOLDER_COUNTS_PER_RUN - counted);
  const organic = cfg.cluster === "mainnet" && due.length > 0 ? await organicScores(env, due.map((d) => d.mint)) : new Map<string, number>();
  let lapsed = 0;
  for (const row of due) {
    const holders = await countHolders(db, cfg, row.mint).catch(() => null);
    await pause();
    if (holders === null) continue;
    const score = organic.get(row.mint) ?? 0;
    const below = holders < BAR_HOLDERS && score < BAR_ORGANIC_SCORE;
    const since = below ? (row.belowBarSince ?? new Date()) : null;
    const lapse = since !== null && Date.now() - since.getTime() >= BAR_DAYS * 86_400_000;
    await db
      .update(protectedCoins)
      .set({
        belowBarSince: since,
        protectedUntil: lapse ? sql`now()` : null,
        details: sql`coalesce(${protectedCoins.details}, '{}'::jsonb) || ${JSON.stringify({ barCheckedAt: new Date().toISOString(), holders, organicScore: score })}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(protectedCoins.id, row.id));
    if (lapse) {
      // Its ticker's strict key goes back to the unique index's pool: a lapsed coin no longer holds it.
      await db
        .update(launches)
        .set({ tickerKey: null })
        .where(and(eq(launches.mint, row.mint), isNotNull(launches.tickerKey), or(eq(launches.mode, "instant"), isNotNull(launches.keeperDoneAt))));
      lapsed++;
    }
  }
  return { fairOpens: fairOpen.length, counted: counted + due.length, crossed, barChecked: due.length, lapsed };
}

/** A coin's holders, the count the coin page keeps when it is fresh (an hour), else counted now and kept. */
async function countHolders(db: Db, cfg: Config, mint: string): Promise<number> {
  const [pool] = await db.select({ pool: pools.pool, holders: pools.holders, at: pools.holdersCountedAt }).from(pools).where(eq(pools.mint, mint));
  if (pool?.holders != null && pool.at && Date.now() - pool.at.getTime() < 3_600_000) return pool.holders;
  const holders = await holderCount(cfg.rpcUrl, mint, AbortSignal.timeout(10_000));
  if (pool) await db.update(pools).set({ holders, holdersCountedAt: new Date() }).where(eq(pools.pool, pool.pool));
  return holders;
}

/** Jupiter's organic scores for some mints, 100 to a search (mainnet only: Jupiter indexes no other cluster). */
async function organicScores(env: Bindings, mints: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 100) {
    const found = await jupiterList(env, `search?query=${mints.slice(i, i + 100).join(",")}`).catch(() => []);
    for (const t of found) scores.set(t.id, t.organicScore ?? 0);
  }
  return scores;
}

// The jobs.

/** The minute's job: Jupiter's trending coins, each protected for 72 hours from its last sighting. */
export async function refreshTrending(db: Db, env: Bindings) {
  const listed = await trendingNow(env);
  await upsertListed(db, "trending", listed);
  return { trending: listed.length };
}

/**
 * The hour's job: Jupiter's verified and organic lists, Heat's coins, CoinGecko's top 1,000 once a day, keys folded
 * under an older version refolded, and rows long lapsed pruned. Each part fails alone, its error in the summary, so one
 * provider being down never keeps the others from refreshing.
 */
export async function refreshLists(db: Db, cfg: Config, env: Bindings, opts: { coinGeckoPauseMs?: number } = {}) {
  const summary: Record<string, unknown> = {};
  const part = async (name: string, work: () => Promise<unknown>) => {
    try {
      summary[name] = await work();
    } catch (e) {
      summary[name] = { error: (e as Error).message };
    }
  };
  await part("verified", async () => {
    const listed = await verifiedNow(env);
    await upsertListed(db, "jupiter_verified", listed);
    return { listed: listed.length, ...(await lapseUnlisted(db, "jupiter_verified", listed)) };
  });
  await part("organic", async () => {
    const listed = await organicNow(env);
    await upsertListed(db, "organic", listed);
    return { listed: listed.length };
  });
  await part("heat", () => refreshHeat(db, cfg, env));
  await part("coingecko", async () => {
    const [{ last } = { last: null }] = await db
      .select({ last: sql<Date | null>`max(${protectedCoins.seenAt})` })
      .from(protectedCoins)
      .where(eq(protectedCoins.source, "coingecko_top"));
    if (last && Date.now() - new Date(last).getTime() < 23 * 3_600_000) return { due: false };
    const listed = await coinGeckoTop(opts.coinGeckoPauseMs);
    await upsertListed(db, "coingecko_top", listed);
    return { listed: listed.length };
  });
  await part("refolded", () => refold(db));
  await part("pruned", () => prune(db));
  const failed = Object.entries(summary).filter(([, v]) => (v as { error?: string })?.error);
  if (failed.length === Object.keys(summary).length) throw new Error(`every part failed: ${failed.map(([k, v]) => `${k}: ${(v as { error: string }).error}`).join("; ")}`);
  return summary;
}

/**
 * Rows folded under an older version, or written without their deletions, folded again: the lookup finds rows by their
 * stored keys (spec 6.2).
 */
async function refold(db: Db): Promise<{ refolded: number }> {
  const stale = await db
    .select({ id: protectedCoins.id, ticker: protectedCoins.ticker, name: protectedCoins.name })
    .from(protectedCoins)
    .where(
      or(
        ne(protectedCoins.foldVersion, FOLD_VERSION),
        // Rows written before the deletions existed: their one-edit neighbours would never be found.
        sql`cardinality(${protectedCoins.tickerLooseDels}) = 0 and ${protectedCoins.tickerLoose} <> ''`,
        sql`cardinality(${protectedCoins.nameLooseDels}) = 0 and ${protectedCoins.nameLoose} <> ''`,
      ),
    )
    .limit(2_000);
  for (const r of stale) await db.update(protectedCoins).set(keyColumns(r.ticker, r.name)).where(eq(protectedCoins.id, r.id));
  return { refolded: stale.length };
}

/** Rows lapsed a month ago, organic sightings never confirmed, and images no row names any more. */
async function prune(db: Db): Promise<Record<string, number>> {
  const lapsed = await db
    .delete(protectedCoins)
    .where(and(ne(protectedCoins.source, "heat"), lt(protectedCoins.protectedUntil, sql`now() - interval '30 days'`)))
    .returning({ id: protectedCoins.id });
  const unconfirmed = await db
    .delete(protectedCoins)
    .where(and(eq(protectedCoins.source, "organic"), sql`${protectedCoins.protectedFrom} > now()`, lt(protectedCoins.seenAt, sql`now() - make_interval(days => ${ORGANIC_KEEP_DAYS})`)))
    .returning({ id: protectedCoins.id });
  const images = await db
    .delete(protectedImages)
    .where(sql`not exists (select 1 from ${protectedCoins} where ${protectedCoins.imageUrl} = ${protectedImages.url})`)
    .returning({ url: protectedImages.url });
  const checks = await db
    .delete(imageChecks)
    .where(and(lt(imageChecks.createdAt, sql`now() - interval '30 days'`), sql`not exists (select 1 from ${launches} where ${launches.imageSha256} = ${imageChecks.sha256})`))
    .returning({ sha256: imageChecks.sha256 });
  return { lapsed: lapsed.length, unconfirmed: unconfirmed.length, images: images.length, checks: checks.length };
}

/** How many images go to the vision service in one request: it fetches about 8 at a time and signs one by one. */
const IMAGES_PER_REQUEST = 25;
/** An image that failed this many times is left failed: a dead link, an SVG, a file that is not an image. */
const MAX_ATTEMPTS = 3;

/**
 * The image batch: every protected coin's image not yet signed, most important first (Heat's, trending, organic,
 * verified and CoinGecko's by market cap), sent to the vision service until none is left or the time is up; then the
 * Container is put to sleep at once rather than idling. Nothing pending, nothing woken.
 */
export async function signImages(db: Db, env: Bindings, budgetMs: number) {
  const started = Date.now();
  let signed = 0;
  let failed = 0;
  let requests = 0;
  const vision = visionOf(env);
  if (!vision) return { skipped: "the vision service is not bound to this deployment" };
  // An image that fails is tried again by the next batch, not by this one.
  const tried: string[] = [];
  try {
    while (Date.now() - started < budgetMs) {
      const untried = tried.length === 0 ? sql`` : sql`and i.url not in (${sql.join(tried.map((t) => sql`${t}`), sql`, `)})`;
      const pending = (await db.execute(sql`
        select i.url from ${protectedImages} i join ${protectedCoins} c on c.image_url = i.url
        where i.status = 'pending' and c.protected_from <= now() and (c.protected_until is null or c.protected_until > now()) ${untried}
        group by i.url
        order by min(case c.source when 'heat' then 0 when 'trending' then 1 when 'organic' then 2 when 'jupiter_verified' then 3 else 4 end),
          max(coalesce((c.details->>'mcap')::float8, 0)) desc
        limit ${IMAGES_PER_REQUEST}`)) as unknown as { url: string }[];
      if (pending.length === 0) break;
      tried.push(...pending.map((p) => p.url));
      requests++;
      const results = await vision.fetchSignatures(pending.map((p, i) => ({ id: String(i), url: p.url })));
      for (const r of results) {
        const url = pending[Number(r.id)]!.url;
        if (r.ok) {
          await db
            .update(protectedImages)
            .set({
              status: "done",
              sha256: r.sha256,
              pdq: r.pdq.quality >= PDQ_MIN_QUALITY ? r.pdq.bits : null,
              pdqQuality: r.pdq.quality,
              sscd: r.sscd,
              error: null,
              attempts: sql`${protectedImages.attempts} + 1`,
              computedAt: sql`now()`,
            })
            .where(eq(protectedImages.url, url));
          signed++;
        } else {
          await db
            .update(protectedImages)
            .set({
              attempts: sql`${protectedImages.attempts} + 1`,
              error: r.error.slice(0, 500),
              status: sql`case when ${protectedImages.attempts} + 1 >= ${MAX_ATTEMPTS} then 'failed' else 'pending' end`,
            })
            .where(eq(protectedImages.url, url));
          failed++;
        }
      }
    }
  } finally {
    if (requests > 0) await vision.sleep().catch((e) => console.warn("putting the vision service to sleep failed", e));
  }
  const [{ pending } = { pending: 0 }] = await db.select({ pending: sql<number>`count(*)::int` }).from(protectedImages).where(eq(protectedImages.status, "pending"));
  return { signed, failed, requests, pending, ms: Date.now() - started };
}

