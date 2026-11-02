// Vamp Shield in the launch service (spec 6.2): the ticker and name rules, then the folded keys against the Protected
// coins, fetched with indexed equality and array overlap before `judge` and `nearMatches` decide; and the image, whose
// signatures the vision service computes (PDQ in all 8 orientations, SSCD) and Postgres matches against the Protected
// coins' with its HNSW indexes before `judgeImage` decides. An exact match refuses, which is our launch key declining to
// co-sign; a near one launches with a "looks like X" label. Every refusal and label at preparing, and every image the
// launch flow checks, goes into the log (`vamp_checks`) so the thresholds can be measured again.
import { and, arrayOverlaps, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import {
  LooksLike as LooksLikeShape,
  VampAppealForm,
  VampShieldCheck,
  type FieldVerdict,
  type ImageVerdict,
  type LooksLike,
  type ProtectedMatch,
  type ProtectedSource,
  type VampAppeal,
  type VampShieldVerdict,
} from "@top-pad/contract";
import { imageChecks, protectedCoins, vampAppeals, vampChecks, type Db } from "@top-pad/db";
import {
  candidateKeys,
  FOLD_VERSION,
  foldKeys,
  judge,
  judgeImage,
  looksLikeName,
  lookupValues,
  nearKeys,
  nearLookupValues,
  nearMatches,
  PDQ_MIN_QUALITY,
  type CoinKeys,
  type Field,
  type ImageJudgement,
  type ImageNeighbour,
  type Near,
  type NearLookup,
  type ProtectedCoin,
} from "@top-pad/vamp-shield";
import { canonicalName, canonicalTicker, nameVerdict, teaserVerdict, tickerVerdict } from "@top-pad/vamp-shield/rules";
import { sessionCreator } from "./auth";
import { webApp, type Bindings, type Config } from "./env";
import { refuse, type AppEnv } from "./http";
import { ORIENTATIONS, visionOf, type Signatures } from "./vision";

const clear: FieldVerdict = { status: "clear", reason: null, match: null };
const refused = (reason: string, match: FieldVerdict["match"] = null): FieldVerdict => ({ status: "refused", reason, match });

const COLUMNS = {
  ticker: { strict: protectedCoins.tickerStrict, loose: protectedCoins.tickerLoose, core: protectedCoins.tickerCore },
  name: { strict: protectedCoins.nameStrict, loose: protectedCoins.nameLoose, core: protectedCoins.nameCore },
} as const;
const DELETIONS = { ticker: protectedCoins.tickerLooseDels, name: protectedCoins.nameLooseDels } as const;

/** A Protected coin as matched, with what the launch form and the coin page show of it. */
export type MatchedCoin = ProtectedCoin & { source: ProtectedSource; imageUrl: string | null };
type Row = typeof protectedCoins.$inferSelect;

/** Rows that protect now: from `protected_from` until `protected_until`, or for as long as their source lists them. */
export const protectsNow = () =>
  and(lte(protectedCoins.protectedFrom, sql`now()`), or(isNull(protectedCoins.protectedUntil), gt(protectedCoins.protectedUntil, sql`now()`)))!;

function matchedCoin(r: Row): MatchedCoin {
  return {
    mint: r.mint,
    ticker: r.ticker,
    name: r.name,
    source: r.source,
    imageUrl: r.imageUrl,
    // A row folded under another version is judged on keys folded now. The lookup still finds rows by their stored keys,
    // so the protected set's refresh rewrites them whenever FOLD_VERSION changes (protectedSet.ts).
    keys:
      r.foldVersion === FOLD_VERSION
        ? { ticker: { strict: r.tickerStrict, loose: r.tickerLoose, core: r.tickerCore }, name: { strict: r.nameStrict, loose: r.nameLoose, core: r.nameCore } }
        : candidateKeys(r.ticker, r.name),
  };
}

/** The Protected coins whose keys can match a candidate's, exactly or nearly, still protected now. */
async function candidates(db: Db, lookup: ReturnType<typeof lookupValues>, near: NearLookup | null = null): Promise<MatchedCoin[]> {
  const matching: SQL[] = [];
  for (const field of ["ticker", "name"] as const) {
    for (const kind of ["strict", "loose", "core"] as const) {
      const values = lookup[field][kind];
      if (values.length > 0) matching.push(inArray(COLUMNS[field][kind], values));
    }
  }
  if (near) {
    if (near.core.length > 0) matching.push(inArray(protectedCoins.tickerCore, near.core), inArray(protectedCoins.nameCore, near.core));
    for (const field of ["ticker", "name"] as const) {
      const { deletions, withSelf } = near.loose[field];
      if (deletions.length > 0) matching.push(inArray(COLUMNS[field].loose, deletions));
      if (withSelf.length > 0) matching.push(arrayOverlaps(DELETIONS[field], withSelf));
    }
  }
  if (matching.length === 0) return [];
  const rows = await db.select().from(protectedCoins).where(and(protectsNow(), or(...matching)));
  return dedupe(rows.map(matchedCoin));
}

/** Where a source ranks when one coin is protected by several: the label names the most authoritative. */
const SOURCE_RANK: Record<ProtectedSource, number> = { jupiter_verified: 0, heat: 1, coingecko_top: 2, organic: 3, trending: 4 };

/**
 * One entry per coin, from its most authoritative source, so a coin protected twice is reported once; the most
 * authoritative first, so a refusal or a label names a coin as Jupiter verifies it before CoinGecko or a trending list.
 */
function dedupe(coins: MatchedCoin[]): MatchedCoin[] {
  const best = new Map<string, MatchedCoin>();
  for (const coin of coins) {
    const held = best.get(coin.mint);
    if (!held || SOURCE_RANK[coin.source] < SOURCE_RANK[held.source]) best.set(coin.mint, coin);
  }
  return [...best.values()].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
}

/** Where a trader sees a Protected coin: its page on Heat, Jupiter's for a Solana coin, CoinGecko's for another chain's. */
export function protectedMatch(cfg: Config, coin: MatchedCoin): ProtectedMatch {
  const url =
    coin.source === "heat"
      ? `${webApp(cfg)}/coin/${coin.mint}`
      : coin.source === "coingecko_top"
        ? `https://www.coingecko.com/en/coins/${encodeURIComponent(coin.mint)}`
        : `https://jup.ag/tokens/${coin.mint}`;
  const imageUrl = coin.imageUrl && /^https:\/\//.test(coin.imageUrl) ? coin.imageUrl : null;
  return { mint: coin.mint, ticker: coin.ticker, name: coin.name, source: coin.source, url, imageUrl };
}

/** The text's verdict and its near matches, which become the launch's labels. */
export type TextCheck = { verdict: VampShieldVerdict; matched: MatchedCoin[]; near: Near[] };

/** Vamp Shield's verdict on a ticker and a name: the rules first, then the Protected coins, exact and near. */
export async function checkText(db: Db, cfg: Config, tickerInput: string, nameInput: string): Promise<TextCheck> {
  const ticker = tickerVerdict(tickerInput);
  const name = nameVerdict(nameInput);
  const verdicts: Record<Field, FieldVerdict> = {
    ticker: ticker.ok ? clear : refused(ticker.reason),
    name: name.ok ? clear : refused(name.reason),
  };
  // A field the rules refuse is not folded: it cannot launch as it is, and its keys would only add noise.
  const tickerText = ticker.ok ? ticker.ticker : "";
  const nameText = name.ok ? name.name : "";
  const keys = candidateKeys(tickerText, nameText);
  const near = nearKeys(tickerText, nameText);
  const found = await candidates(db, lookupValues(keys), nearLookupValues(keys, near));
  const byMint = new Map(found.map((c) => [c.mint, c]));
  const judgement = judge(keys, found);
  if (judgement.verdict === "refused") {
    for (const field of ["ticker", "name"] as const) {
      const match = judgement.matches.find((m) => m.field === field);
      if (match && verdicts[field].status === "clear") verdicts[field] = refused(match.reason, protectedMatch(cfg, byMint.get(match.coin.mint)!));
    }
  }
  const nearOnes = nearMatches(keys, near, found);
  for (const field of ["ticker", "name"] as const) {
    const first = nearOnes.find((n) => n.field === field);
    if (first && verdicts[field].status === "clear") {
      verdicts[field] = { status: "looks_like", reason: first.reason, match: protectedMatch(cfg, byMint.get(first.coin.mint)!) };
    }
  }
  return {
    verdict: {
      ticker: ticker.ok ? ticker.ticker : canonicalTicker(tickerInput),
      name: name.ok ? name.name : canonicalName(nameInput),
      verdicts,
      clear: verdicts.ticker.status !== "refused" && verdicts.name.status !== "refused",
    },
    matched: found,
    near: nearOnes,
  };
}

/** The longest run of words in a teaser read as a coin's name: most names are one to three words. */
const TEASER_PHRASE_WORDS = 4;
/** The shortest word in a teaser read as a ticker: shorter ones are everyday words far more often than coins. */
const TEASER_TICKER_MIN = 3;

/**
 * Vamp Shield's verdict on a Fair Open's teaser (spec 2.1 step 4): the text rules, then whether it names a Protected
 * coin. Each run of up to four words is read as a name, matched by its strict and loose keys against Protected names,
 * and each word of three or more letters and digits as a ticker, matched by its strict key against Protected tickers.
 * Core keys are left out: they strip words such as OFFICIAL from free text and would refuse ordinary sentences.
 */
export async function checkTeaser(db: Db, input: string): Promise<{ ok: true; teaser: string } | { ok: false; reason: string }> {
  const rules = teaserVerdict(input);
  if (!rules.ok || rules.teaser === "") return rules;
  const words = rules.teaser.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrases: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= TEASER_PHRASE_WORDS && i + n <= words.length; n++) phrases.push(words.slice(i, i + n).join(" "));
  }
  const names = phrases.map((p) => foldKeys(p, "name"));
  const tickers = words.filter((w) => Array.from(w).length >= TEASER_TICKER_MIN).map((w) => foldKeys(w, "ticker"));
  const values = (keys: string[]) => [...new Set(keys.filter((k) => k.length > 0))];
  const lookup = {
    ticker: { strict: values(tickers.map((k) => k.strict)), loose: [], core: [] },
    name: { strict: values(names.map((k) => k.strict)), loose: values(names.map((k) => k.loose)), core: [] },
  };
  const found = await candidates(db, lookup);
  const empty = { strict: "", loose: "", core: "" };
  for (const keys of [...tickers.map((ticker): CoinKeys => ({ ticker: { ...empty, strict: ticker.strict }, name: empty })), ...names.map((name): CoinKeys => ({ ticker: empty, name: { ...name, core: "" } }))]) {
    const judgement = judge(keys, found);
    if (judgement.verdict === "refused") {
      const coin = judgement.matches[0]!.coin;
      return { ok: false, reason: `The teaser names ${coin.name} ($${coin.ticker.replace(/^\$/, "")}), a protected coin: the calendar cannot carry another coin's name.` };
    }
  }
  return rules;
}

/** The reason a refused launch shows first: the ticker's refusal, else the name's; never a field's "looks like" note. */
export const firstRefusal = (v: VampShieldVerdict) =>
  [v.verdicts.ticker, v.verdicts.name].find((f) => f.status === "refused")?.reason ?? "Vamp Shield refused this launch.";

/** `POST /vamp-shield/check`: the launch flow's live text verdicts. */
export async function checkRoute(c: Context<AppEnv>) {
  const body = VampShieldCheck.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a ticker and a name." }, 400);
  return c.json((await checkText(c.var.db, c.var.cfg, body.data.ticker, body.data.name)).verdict);
}

// Images.

/** How long a launch waits on the vision service, woken from sleep included, before saying it cannot check the image. */
export const VISION_WAIT_MS = 45_000;
/** How many nearest Protected images each search returns: enough that the closest match is never crowded out. */
const NEAREST = 5;

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Of = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/** An image's signatures: from its earlier check if there was one, else from the vision service, kept for the next. */
async function signaturesOf(
  db: Db,
  env: Bindings,
  bytes: Uint8Array,
  sha256: string,
): Promise<{ ok: true; signatures: Signatures; answerMs: number | null; woke: boolean | null } | { ok: false; status: number; reason: string }> {
  const [cached] = await db.select().from(imageChecks).where(eq(imageChecks.sha256, sha256));
  if (cached) {
    return { ok: true, signatures: { sha256, pdq: { bits: cached.pdqDihedral[0]!, quality: cached.pdqQuality, dihedral: cached.pdqDihedral }, sscd: cached.sscd }, answerMs: null, woke: null };
  }
  const vision = visionOf(env);
  if (!vision) return { ok: false, status: 503, reason: "Vamp Shield cannot check images on this deployment, so it cannot launch a coin." };
  let answer: Awaited<ReturnType<typeof vision.signatures>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answer = await Promise.race([
      vision.signatures(bytes),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${VISION_WAIT_MS / 1000} s`)), VISION_WAIT_MS))),
    ]);
  } catch (e) {
    console.error("the vision service failed", (e as Error).message);
    return { ok: false, status: 503, reason: "Vamp Shield could not check the image just now. Try again in a minute." };
  } finally {
    clearTimeout(timer);
  }
  if ("error" in answer) {
    if (answer.status === 422 || answer.status === 413) return { ok: false, status: 422, reason: `The image could not be read: ${answer.error}` };
    console.error("the vision service refused an image", answer.status, answer.error);
    return { ok: false, status: 503, reason: "Vamp Shield could not check the image just now. Try again in a minute." };
  }
  console.log(`vision answered in ${answer.answerMs} ms${answer.woke ? ", woken" : ""}`);
  await db
    .insert(imageChecks)
    .values({ sha256, pdqDihedral: answer.pdq.dihedral, pdqQuality: answer.pdq.quality, sscd: answer.sscd, answerMs: answer.answerMs })
    .onConflictDoNothing();
  return { ok: true, signatures: answer, answerMs: answer.answerMs, woke: answer.woke };
}

/**
 * The Protected images nearest a candidate's, each with the coins it protects: by PDQ over the candidate's 8
 * orientations (when its quality allows) and by SSCD, each through its HNSW index, searched wider than the default so
 * the approximate index does not miss a close match.
 */
export async function nearestImages(db: Db, signatures: Signatures): Promise<(ImageNeighbour & { coin: MatchedCoin })[]> {
  const vector = `[${signatures.sscd.join(",")}]`;
  const hashes = signatures.pdq.quality >= PDQ_MIN_QUALITY ? signatures.pdq.dihedral : [];
  const { pdqRows, sscdRows } = await db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.ef_search = 100`);
    const pdqRows =
      hashes.length === 0
        ? []
        : ((await tx.execute(
            sql.join(
              hashes.map(
                (h, i) =>
                  sql`(select url, ${i}::int as orientation, (pdq <~> ${h}::bit(256))::int as distance from protected_images where pdq is not null and status = 'done' order by pdq <~> ${h}::bit(256) limit ${NEAREST})`,
              ),
              sql` union all `,
            ),
          )) as unknown as { url: string; orientation: number; distance: number }[]);
    const sscdRows = (await tx.execute(
      sql`select url, 1 - (sscd <=> ${vector}::vector) as similarity from protected_images where sscd is not null and status = 'done' order by sscd <=> ${vector}::vector limit ${NEAREST}`,
    )) as unknown as { url: string; similarity: number }[];
    return { pdqRows, sscdRows };
  });
  const byUrl = new Map<string, { pdqDistance: number | null; orientation: number | null; sscd: number | null }>();
  for (const r of pdqRows) {
    const held = byUrl.get(r.url);
    if (!held || held.pdqDistance === null || r.distance < held.pdqDistance) byUrl.set(r.url, { pdqDistance: r.distance, orientation: r.orientation, sscd: held?.sscd ?? null });
  }
  for (const r of sscdRows) {
    const held = byUrl.get(r.url) ?? { pdqDistance: null, orientation: null, sscd: null };
    byUrl.set(r.url, { ...held, sscd: Number(r.similarity) });
  }
  if (byUrl.size === 0) return [];
  const rows = await db
    .select()
    .from(protectedCoins)
    .where(and(protectsNow(), inArray(protectedCoins.imageUrl, [...byUrl.keys()])));
  const coins = rows.map(matchedCoin);
  const neighbours: (ImageNeighbour & { coin: MatchedCoin })[] = [];
  for (const [url, scores] of byUrl) {
    // An image several rows share (a stock issuer's template, a coin and its bridged copy, one coin by two sources) is
    // reported by the most authoritative of them; each row is matched by its own image, whatever another source of the
    // same coin names.
    const coin = coins.filter((c) => c.imageUrl === url).sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0];
    if (coin) neighbours.push({ coin, ...scores });
  }
  return neighbours;
}

/** An image check's outcome: the verdict the launch flow shows, its label if it is near, and its scores for the log. */
export type ImageCheck =
  | { ok: true; sha256: string; verdict: FieldVerdict; label: LooksLike | null; answerMs: number | null; woke: boolean | null; judgement: ImageJudgement; nearest: ImageNeighbour[] }
  | { ok: false; sha256: string; status: number; verdict: FieldVerdict };

const label = (coin: MatchedCoin) => looksLikeName(coin);

/** Vamp Shield's verdict on a coin's image. */
export async function checkImage(db: Db, cfg: Config, env: Bindings, bytes: Uint8Array): Promise<ImageCheck> {
  const sha256 = await sha256Of(bytes);
  const signed = await signaturesOf(db, env, bytes, sha256);
  if (!signed.ok) return { ok: false, sha256, status: signed.status, verdict: refused(signed.reason) };
  const nearest = await nearestImages(db, signed.signatures);
  const judgement = judgeImage(nearest);
  let verdict: FieldVerdict = clear;
  let looksLike: LooksLike | null = null;
  if (judgement.verdict !== "clear") {
    const coin = judgement.neighbour.coin as MatchedCoin;
    const match = protectedMatch(cfg, coin);
    if (judgement.verdict === "refused") {
      const how = judgement.by === "pdq" ? ORIENTATIONS[judgement.neighbour.orientation ?? 0] : null;
      const reason =
        judgement.by === "pdq"
          ? `The image is the picture of ${label(coin)}, a protected coin${how && how !== "as it is" ? `, ${how}` : ""}.`
          : `The image copies the picture of ${label(coin)}, a protected coin, by Vamp Shield's copy detection.`;
      verdict = refused(reason, match);
    } else {
      verdict = {
        status: "looks_like",
        reason: `The image is close to the picture of ${label(coin)}, a protected coin: it can launch, labelled "looks like ${label(coin)}" on its page.`,
        match,
      };
      looksLike = { field: "image", coin: match, label: `Looks like ${label(coin)}`, reason: `Its picture is close to ${label(coin)}'s.` };
    }
  }
  return { ok: true, sha256, verdict, label: looksLike, answerMs: signed.answerMs, woke: signed.woke, judgement, nearest };
}

/** The scores the log keeps of an image's nearest Protected images, whatever the outcome. */
const scoresOf = (nearest: ImageNeighbour[]) =>
  nearest
    .slice()
    .sort((a, b) => (b.sscd ?? 0) - (a.sscd ?? 0))
    .map((n) => ({ mint: n.coin.mint, ticker: n.coin.ticker, source: n.coin.source, pdqDistance: n.pdqDistance, orientation: n.orientation, sscd: n.sscd }));

/** How many images one creator may have checked in 10 minutes: each new one can wake the vision service. */
const IMAGE_CHECKS_PER_10_MINUTES = 30;

/**
 * `POST /vamp-shield/image`: the launch flow's live image verdict, logged with its scores. Only for a creator signed in
 * with X, as the launch flow is by its coin step, and only so many a time, since a new image can wake the Container.
 */
export async function checkImageRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first: images are checked for a launch.", code: "not_linked" });
  const [{ recent } = { recent: 0 }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(vampChecks)
    .where(and(eq(vampChecks.creatorId, creator.id), eq(vampChecks.stage, "image"), gte(vampChecks.at, sql`now() - interval '10 minutes'`)));
  if (recent >= IMAGE_CHECKS_PER_10_MINUTES) return c.json({ error: "You have checked many images just now. Wait a few minutes, then try again." }, 429);
  const body = await c.req.parseBody();
  const file = body.image;
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "Send the coin's image." }, 400);
  if (file.size > cfg.maxImageBytes) return c.json({ error: `The image is too large: a coin's image can be at most ${Math.round(cfg.maxImageBytes / 1024)} KB.` }, 413);
  const check = await checkImage(db, cfg, c.env, new Uint8Array(await file.arrayBuffer()));
  if (!check.ok) {
    // Logged too: the rate limit counts every attempt, and the operator sees images the service could not read.
    await db.insert(vampChecks).values({ stage: "image", creatorId: creator.id, imageSha256: check.sha256, outcome: "unchecked", matches: [] });
    return c.json({ error: check.verdict.reason }, check.status as 422 | 503);
  }
  await db.insert(vampChecks).values({
    stage: "image",
    creatorId: creator.id,
    imageSha256: check.sha256,
    outcome: check.verdict.status,
    matches: check.verdict.match ? [{ field: "image", rule: check.judgement.verdict === "refused" ? check.judgement.by : "sscd", coin: check.verdict.match }] : [],
    nearest: scoresOf(check.nearest),
  });
  const answer: ImageVerdict = { sha256: check.sha256, verdict: check.verdict, answerMs: check.answerMs, woke: check.woke };
  return c.json(answer);
}

// A launch as prepared.

/** A text near match as the label a coin carries and the reason a trader reads. */
function textLabel(cfg: Config, near: Near, coin: MatchedCoin): LooksLike {
  const name = label(coin);
  const reason =
    near.rule === "derivative"
      ? `Its ${near.field} builds on ${name}${near.against !== near.field ? `'s ${near.against}` : ""} with a word such as BABY or INU.`
      : `Its ${near.field} is one letter away from ${name}'s.`;
  return { field: near.field, coin: protectedMatch(cfg, coin), label: `Looks like ${name}`, reason };
}

/** Who is preparing which launch, for the log. */
export type Preparing = { creatorId: string; launchId: string };

/** What Vamp Shield decided for a launch being prepared: refused with the refusal, or its labels, maybe none. */
export type LaunchVerdict =
  | { ok: true; ticker: string; name: string; imageSha256: string; looksLike: LooksLike[] }
  | { ok: false; status: number; error: string; text: VampShieldVerdict; image: FieldVerdict | null; imageSha256: string | null };

const logPrepared = (db: Db, at: Preparing, text: VampShieldVerdict, outcome: "looks_like" | "refused", matches: unknown[], imageSha256: string | null, nearest: unknown = null) =>
  db.insert(vampChecks).values({ stage: "prepare", creatorId: at.creatorId, launchId: at.launchId, ticker: text.ticker, name: text.name, imageSha256, outcome, matches, nearest });

const textMatchesOf = (text: VampShieldVerdict) =>
  (["ticker", "name"] as const).flatMap((field) => {
    const v = text.verdicts[field];
    return v.match ? [{ field, status: v.status, coin: v.match, reason: v.reason }] : [];
  });

/** The text's verdict a launch is prepared on, its refusal logged: checked before anything else, the image included. */
export async function judgeLaunchText(db: Db, cfg: Config, at: Preparing, ticker: string, name: string): Promise<TextCheck> {
  const text = await checkText(db, cfg, ticker, name);
  if (!text.verdict.clear) await logPrepared(db, at, text.verdict, "refused", textMatchesOf(text.verdict), null);
  return text;
}

/**
 * The verdict a launch is prepared on, once its text is clear: its image, as the launch flow showed it. A refusal, an
 * image the vision service could not check included, is our launch key declining to co-sign; refusals and labels are
 * logged with the launch.
 */
export async function judgeLaunch(db: Db, cfg: Config, env: Bindings, at: Preparing, text: TextCheck, image: Uint8Array): Promise<LaunchVerdict> {
  const check = await checkImage(db, cfg, env, image);
  if (!check.ok) return { ok: false, status: check.status, error: check.verdict.reason!, text: text.verdict, image: check.verdict, imageSha256: check.sha256 };
  const textMatches = textMatchesOf(text.verdict);
  const imageMatches = check.verdict.match ? [{ field: "image", status: check.verdict.status, coin: check.verdict.match, reason: check.verdict.reason }] : [];
  if (check.verdict.status === "refused") {
    await logPrepared(db, at, text.verdict, "refused", [...textMatches, ...imageMatches], check.sha256, scoresOf(check.nearest));
    return { ok: false, status: 422, error: check.verdict.reason!, text: text.verdict, image: check.verdict, imageSha256: check.sha256 };
  }
  const byMint = new Map(text.matched.map((c) => [c.mint, c]));
  const labels: LooksLike[] = [];
  // One label per coin a trader would call one: the same coin listed by two sources under two ids (Jupiter's mint and
  // CoinGecko's id for Bonk) has the same folded ticker and name, and is named once, by its most authoritative source.
  const labelled: MatchedCoin[] = [];
  const same = (a: MatchedCoin, b: MatchedCoin) => a.mint === b.mint || (a.keys.ticker.strict === b.keys.ticker.strict && a.keys.name.strict === b.keys.name.strict);
  for (const near of text.near) {
    const coin = byMint.get(near.coin.mint)!;
    if (labels.some((l, i) => l.field === near.field && same(labelled[i]!, coin))) continue;
    labels.push(textLabel(cfg, near, coin));
    labelled.push(coin);
  }
  if (check.label) labels.push(check.label);
  if (labels.length > 0) await logPrepared(db, at, text.verdict, "looks_like", [...textMatches, ...imageMatches], check.sha256, scoresOf(check.nearest));
  return { ok: true, ticker: text.verdict.ticker, name: text.verdict.name, imageSha256: check.sha256, looksLike: labels };
}

/** A launch's labels as stored, read back through the contract so a stored label never reaches a page malformed. */
export function storedLabels(value: unknown): LooksLike[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const parsed = LooksLikeShape.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
}

// Appeals.

/** How many appeals a creator may have open from one day: the operator queue is people, not a form to flood. */
const APPEALS_PER_DAY = 5;

const toAppeal = (r: typeof vampAppeals.$inferSelect): VampAppeal => ({
  id: r.id,
  ticker: r.ticker,
  name: r.name,
  imageSha256: r.imageSha256,
  original: r.original,
  message: r.message,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
});

/**
 * `POST /vamp-shield/appeals`: a creator's appeal against a refusal, to the operator queue (spec 6.2, 6.6), with the
 * verdict Vamp Shield gives now, so the operator sees what was refused and why.
 */
export async function appealRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first: an appeal comes from the creator who was refused.", code: "not_linked" });
  const body = VampAppealForm.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Say why the refusal is wrong, in at most 2,000 characters." }, 400);
  const [{ recent } = { recent: 0 }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(vampAppeals)
    .where(and(eq(vampAppeals.creatorId, creator.id), gte(vampAppeals.createdAt, sql`now() - interval '1 day'`)));
  if (recent >= APPEALS_PER_DAY) return c.json({ error: `You have sent ${APPEALS_PER_DAY} appeals today; an operator answers them first.` }, 429);
  const text = await checkText(db, cfg, body.data.ticker, body.data.name);
  let image: unknown = null;
  if (body.data.imageSha256) {
    const [checked] = await db.select({ sha256: vampChecks.imageSha256, outcome: vampChecks.outcome, matches: vampChecks.matches }).from(vampChecks).where(eq(vampChecks.imageSha256, body.data.imageSha256)).orderBy(desc(vampChecks.at)).limit(1);
    image = checked ?? null;
  }
  const [row] = await db
    .insert(vampAppeals)
    .values({
      creatorId: creator.id,
      ticker: text.verdict.ticker,
      name: text.verdict.name,
      imageSha256: body.data.imageSha256,
      original: body.data.original?.trim() || null,
      message: body.data.message.trim(),
      verdict: { text: text.verdict, image },
    })
    .returning();
  return c.json(toAppeal(row!), 201);
}

/** `GET /vamp-shield/appeals`: the signed-in creator's appeals, newest first. */
export async function listAppealsRoute(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first.", code: "not_linked" });
  const rows = await c.var.db.select().from(vampAppeals).where(eq(vampAppeals.creatorId, creator.id)).orderBy(desc(vampAppeals.createdAt)).limit(50);
  return c.json({ appeals: rows.map(toAppeal) });
}

