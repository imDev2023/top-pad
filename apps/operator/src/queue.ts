// The operator queue (spec 6.6): one list of everything waiting on a person, refused launches with their appeals,
// refused or merged admissions, bundling cases and barred creators' appeals, each with its age against the 48-hour aim.
// Read as `heat_operator`.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ProtectedMatch } from "@top-pad/contract";
import { admissionReviews, barAppeals, barReplies, bars, bundleCases, creators, creatorWallets, launches, launchReviews, vampAppeals, xMessages, type DbOrTransaction } from "@top-pad/db";

/** How soon the queue aims to answer each item (spec 6.6). */
export const AIM_HOURS = 48;

export type Field = "ticker" | "name" | "image";

/** A Protected coin a refused launch matched, on one field, and the reason the creator was given. */
export type Refusing = { field: Field; coin: ProtectedMatch; reason: string };

/** A creator's appeal, as the queue shows it. */
export type Appeal = { id: string; original: string | null; message: string; createdAt: Date; imageSha256: string | null };

/** Which refused launch an item is: a creator's ticker, name and image as Vamp Shield refused them. */
export type LaunchKey = { creatorId: string; ticker: string; name: string; imageSha256: string | null };

/** A launch item's creator as the pages name them: their X handle, or their Creator wallet when they linked no X. */
export const creatorName = (item: Pick<LaunchItem, "handle" | "creatorWallet">) =>
  item.handle ? `@${item.handle}` : item.creatorWallet ? `${item.creatorWallet.slice(0, 4)}\u{2026}${item.creatorWallet.slice(-4)}` : "a creator with no Creator wallet yet";

export type LaunchItem = {
  kind: "launch";
  key: LaunchKey;
  /** The creator's linked X handle, null when they linked none (ADR 0008), and their Creator wallet now. */
  handle: string | null;
  creatorWallet: string | null;
  /** When the queue's clock started: the first appeal if there is one, since that asks for an answer; else the first refusal. */
  since: Date;
  /** How often launching it was refused, and when last; none when only an appeal brought it. */
  attempts: number;
  lastRefusedAt: Date | null;
  refusing: Refusing[];
  appeals: Appeal[];
};

export type AdmissionReview = { kind: "refused" | "merged"; reason: string; cluster: string; evidence: unknown; createdAt: Date };

/** A Fair Open as the queue may show it: before its open nothing about its coin, sealed until then (spec 2.1). */
export type FairOpenInfo = { creatorHandle: string | null; teaser: string | null; opensAt: Date | null; opened: boolean; ticker: string | null; name: string | null };

export type AdmissionItem = {
  kind: "admission";
  launch: string;
  wallet: string;
  since: Date;
  reviews: AdmissionReview[];
  fairOpen: FairOpenInfo | null;
  /**
   * Where the wallet's SOL came from, the top of its funding chain, when that is another wallet and not the Creator
   * wallet: a hub candidate. A creator funding their own depositors is the tie itself, never a hub.
   */
  root: string | null;
};

export type CaseItem = {
  kind: "case";
  id: string;
  mint: string;
  since: Date;
  creatorWallet: string;
  handle: string | null;
  linkedWallets: number;
  /** What the linked wallets bought, as a share of supply. */
  share: string | null;
  coin: { ticker: string; name: string } | null;
  evidenceKey: string;
};

/** A barred creator's appeal (spec 6.5), waiting on an operator other than the one who confirmed the Bar. */
export type AppealItem = {
  kind: "appeal";
  id: string;
  barId: string;
  mint: string;
  since: Date;
  handle: string | null;
  creatorWallet: string;
  coin: { ticker: string; name: string } | null;
  grounds: "shared_exchange" | "launch_service" | "other";
  statement: string;
  confirmedBy: string;
  /** Whether it follows a denied appeal, so it must bring new evidence. */
  again: boolean;
};

export type QueueItem = LaunchItem | AdmissionItem | CaseItem | AppealItem;

const Match = z.object({ field: z.enum(["ticker", "name", "image"]), status: z.string(), coin: ProtectedMatch, reason: z.string().nullable() });
const FieldVerdictShape = z.object({ status: z.string(), reason: z.string().nullable(), match: ProtectedMatch.nullable() });
const AppealVerdict = z.object({
  text: z.object({ verdicts: z.object({ ticker: FieldVerdictShape, name: FieldVerdictShape }) }).nullish(),
  image: z.object({ matches: z.array(z.unknown()) }).nullish(),
});

/** The refusing matches in a logged verdict's `matches`, one per field. */
function refusingIn(matches: unknown): Refusing[] {
  const list = Array.isArray(matches) ? matches : [];
  return list.flatMap((m) => {
    const parsed = Match.safeParse(m);
    return parsed.success && parsed.data.status === "refused" ? [{ field: parsed.data.field, coin: parsed.data.coin, reason: parsed.data.reason ?? "" }] : [];
  });
}

/** The refusing matches in the verdict an appeal kept: its text's and, when the creator named it, its image's. */
function refusingInAppeal(verdict: unknown): Refusing[] {
  const parsed = AppealVerdict.safeParse(verdict);
  if (!parsed.success) return [];
  const text = (["ticker", "name"] as const).flatMap((field) => {
    const v = parsed.data.text?.verdicts[field];
    return v && v.status === "refused" && v.match ? [{ field, coin: v.match, reason: v.reason ?? "" }] : [];
  });
  return [...text, ...refusingIn(parsed.data.image?.matches)];
}

/** One refusal per field, the latest first wins. */
function byField(lists: Refusing[][]): Refusing[] {
  const seen = new Map<Field, Refusing>();
  for (const r of lists.flat()) if (!seen.has(r.field)) seen.set(r.field, r);
  return [...seen.values()];
}

const date = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const sameLaunch = (a: { creatorId: string; ticker: string; name: string }, b: { creatorId: string; ticker: string; name: string }) =>
  a.creatorId === b.creatorId && a.ticker === b.ticker && a.name === b.name;

/**
 * Refused launches waiting on an operator: each creator's ticker, name and image that Vamp Shield refused as a launch was
 * prepared, unless a review decided them since the last refusal, with the creator's open appeals for that ticker and
 * name; and each open appeal no such refusal accounts for, as an item of its own.
 */
export async function launchItems(tx: DbOrTransaction): Promise<LaunchItem[]> {
  const refusals = await tx.execute<{
    creator_id: string;
    ticker: string;
    name: string;
    image_sha256: string | null;
    first_at: Date | string;
    last_at: Date | string;
    attempts: number;
    matches: unknown;
    x_handle: string | null;
    creator_wallet: string | null;
  }>(sql`
    with refusals as (
      select creator_id, ticker, name, image_sha256, min(at) as first_at, max(at) as last_at, count(*)::int as attempts,
             (array_agg(matches order by at desc))[1] as matches
      from vamp_checks
      where stage = 'prepare' and outcome = 'refused' and creator_id is not null and ticker is not null and name is not null
      group by creator_id, ticker, name, image_sha256
    )
    select r.*, c.x_handle, cw.wallet as creator_wallet
    from refusals r join creators c on c.id = r.creator_id
    left join creator_wallets cw on cw.creator_id = r.creator_id and cw.ended_at is null
    where not exists (
      select 1 from launch_reviews lr
      where lr.creator_id = r.creator_id and lr.ticker = r.ticker and lr.name = r.name
        and lr.image_sha256 is not distinct from r.image_sha256 and lr.decided_at >= r.last_at
    )
  `);
  const appeals = await tx
    .select({ appeal: vampAppeals, handle: creators.xHandle, creatorWallet: creatorWallets.wallet })
    .from(vampAppeals)
    .innerJoin(creators, eq(creators.id, vampAppeals.creatorId))
    .leftJoin(creatorWallets, and(eq(creatorWallets.creatorId, vampAppeals.creatorId), isNull(creatorWallets.endedAt)))
    .where(eq(vampAppeals.status, "open"))
    .orderBy(vampAppeals.createdAt);

  const items: LaunchItem[] = refusals.map((r) => ({
    kind: "launch",
    key: { creatorId: r.creator_id, ticker: r.ticker, name: r.name, imageSha256: r.image_sha256 },
    handle: r.x_handle,
    creatorWallet: r.creator_wallet,
    since: date(r.first_at),
    attempts: r.attempts,
    lastRefusedAt: date(r.last_at),
    refusing: refusingIn(r.matches),
    appeals: [],
  }));
  for (const { appeal, handle, creatorWallet } of appeals) {
    const shown: Appeal = { id: appeal.id, original: appeal.original, message: appeal.message, createdAt: appeal.createdAt, imageSha256: appeal.imageSha256 };
    const key = { creatorId: appeal.creatorId, ticker: appeal.ticker, name: appeal.name };
    // An appeal goes with the refusal of the same ticker and name: the one with its image if there is one, else the latest.
    const matching = items.filter((i) => sameLaunch(i.key, key));
    const home = matching.find((i) => i.key.imageSha256 === appeal.imageSha256) ?? matching.sort((a, b) => b.since.getTime() - a.since.getTime())[0];
    if (home) {
      home.appeals.push(shown);
      home.refusing = byField([home.refusing, refusingInAppeal(appeal.verdict)]);
    } else {
      items.push({
        kind: "launch",
        key: { ...key, imageSha256: appeal.imageSha256 },
        handle,
        creatorWallet,
        since: appeal.createdAt,
        attempts: 0,
        lastRefusedAt: null,
        refusing: refusingInAppeal(appeal.verdict),
        appeals: [shown],
      });
    }
  }
  for (const item of items) if (item.appeals.length > 0) item.since = item.appeals[0]!.createdAt;
  return items;
}

const Trace = z.object({ wallet: z.string(), root: z.string() });

/** Refused or merged admissions not yet dealt with, one item per launch and wallet. */
export async function admissionItems(tx: DbOrTransaction): Promise<AdmissionItem[]> {
  const rows = await tx
    .select({
      review: admissionReviews,
      handle: creators.xHandle,
      teaser: launches.teaser,
      opensAt: launches.opensAt,
      openLandedAt: launches.openLandedAt,
      // A sealed Fair Open's coin never leaves the database before its open (CLAUDE.md, Traps).
      ticker: sql<string | null>`case when ${launches.openLandedAt} is not null then ${launches.ticker} end`,
      name: sql<string | null>`case when ${launches.openLandedAt} is not null then ${launches.name} end`,
      known: launches.id,
      creatorWallet: launches.wallet,
    })
    .from(admissionReviews)
    .leftJoin(launches, eq(launches.fairOpen, admissionReviews.launch))
    .leftJoin(creators, eq(creators.id, launches.creatorId))
    .where(isNull(admissionReviews.resolvedAt))
    .orderBy(admissionReviews.createdAt);
  const items = new Map<string, AdmissionItem>();
  for (const r of rows) {
    const id = `${r.review.launch}:${r.review.wallet}`;
    let item = items.get(id);
    if (!item) {
      const evidence = r.review.evidence as { wallet?: unknown; creator?: { wallet?: string } } | null;
      const trace = Trace.safeParse(evidence?.wallet);
      const creatorWallet = r.creatorWallet ?? evidence?.creator?.wallet ?? null;
      item = {
        kind: "admission",
        launch: r.review.launch,
        wallet: r.review.wallet,
        since: r.review.createdAt,
        reviews: [],
        fairOpen: r.known
          ? { creatorHandle: r.handle, teaser: r.teaser, opensAt: r.opensAt, opened: r.openLandedAt !== null, ticker: r.ticker, name: r.name }
          : null,
        root: trace.success && trace.data.root !== r.review.wallet && trace.data.root !== creatorWallet ? trace.data.root : null,
      };
      items.set(id, item);
    }
    item.reviews.push({ kind: r.review.kind, reason: r.review.reason, cluster: r.review.cluster, evidence: r.review.evidence, createdAt: r.review.createdAt });
  }
  return [...items.values()];
}

/** Bundling cases still open: each waits for an operator to confirm it, which bars its creator, or dismiss it (spec 6.5). */
export async function caseItems(tx: DbOrTransaction): Promise<CaseItem[]> {
  const rows = await tx
    .select({ c: bundleCases, handle: creators.xHandle, ticker: launches.ticker, name: launches.name })
    .from(bundleCases)
    .leftJoin(creators, eq(creators.id, bundleCases.creatorId))
    .leftJoin(launches, eq(launches.mint, bundleCases.mint))
    .where(eq(bundleCases.status, "open"))
    .orderBy(bundleCases.openedAt);
  return rows.map(({ c, handle, ticker, name }) => ({
    kind: "case",
    id: c.id,
    mint: c.mint,
    since: c.openedAt,
    creatorWallet: c.creatorWallet,
    handle,
    linkedWallets: c.linkedWallets,
    share: (c.evidence as { floor?: { share?: string } } | null)?.floor?.share ?? null,
    coin: ticker && name ? { ticker, name } : null,
    evidenceKey: c.evidenceKey,
  }));
}

/** Barred creators' appeals still open, each since it was filed (spec 6.5: decided within 48 hours). */
export async function appealItems(tx: DbOrTransaction): Promise<AppealItem[]> {
  const rows = await tx
    .select({ appeal: barAppeals, bar: bars, handle: creators.xHandle, ticker: launches.ticker, name: launches.name })
    .from(barAppeals)
    .innerJoin(bars, eq(bars.id, barAppeals.barId))
    .leftJoin(creators, eq(creators.id, bars.creatorId))
    .leftJoin(launches, eq(launches.mint, bars.mint))
    .where(eq(barAppeals.status, "open"))
    .orderBy(barAppeals.filedAt);
  const earlier = rows.length
    ? await tx
        .select({ barId: barAppeals.barId, n: sql<number>`count(*)::int` })
        .from(barAppeals)
        .where(and(inArray(barAppeals.barId, rows.map((r) => r.bar.id)), eq(barAppeals.status, "denied")))
        .groupBy(barAppeals.barId)
    : [];
  return rows.map(({ appeal, bar, handle, ticker, name }) => ({
    kind: "appeal",
    id: appeal.id,
    barId: bar.id,
    mint: bar.mint,
    since: appeal.filedAt,
    handle,
    creatorWallet: bar.creatorWallet,
    coin: ticker && name ? { ticker, name } : null,
    grounds: appeal.grounds,
    statement: appeal.statement,
    confirmedBy: bar.confirmedBy,
    again: earlier.some((e) => e.barId === bar.id && e.n > 0),
  }));
}

/** The whole queue, oldest first: what is closest to the 48-hour aim, or past it, comes first. */
export async function queue(tx: DbOrTransaction): Promise<QueueItem[]> {
  const [l, a, c, p] = [await launchItems(tx), await admissionItems(tx), await caseItems(tx), await appealItems(tx)];
  return [...l, ...a, ...c, ...p].sort((x, y) => x.since.getTime() - y.since.getTime());
}

/** A Bar as the operator's Bars page lists it. */
export type BarRow = {
  id: string;
  mint: string;
  coin: { ticker: string; name: string } | null;
  handle: string | null;
  creatorWallet: string;
  confirmedBy: string;
  confirmedAt: Date;
  publishAt: Date;
  liftedAt: Date | null;
  replies: number;
  appeals: number;
  openAppeal: boolean;
};

/** Every Bar, newest first, with how many replies and appeals each drew. */
export async function barRows(tx: DbOrTransaction): Promise<BarRow[]> {
  const rows = await tx
    .select({
      bar: bars,
      handle: creators.xHandle,
      ticker: launches.ticker,
      name: launches.name,
      // Written out: drizzle leaves a lone table's columns unqualified, which a subquery on another table would misread.
      replies: sql<number>`(select count(*)::int from bar_replies r where r.bar_id = "bars"."id")`,
      appeals: sql<number>`(select count(*)::int from bar_appeals a where a.bar_id = "bars"."id")`,
      openAppeal: sql<boolean>`exists (select 1 from bar_appeals a where a.bar_id = "bars"."id" and a.status = 'open')`,
    })
    .from(bars)
    .leftJoin(creators, eq(creators.id, bars.creatorId))
    .leftJoin(launches, eq(launches.mint, bars.mint))
    .orderBy(desc(bars.confirmedAt))
    .limit(200);
  return rows.map((r) => ({
    id: r.bar.id,
    mint: r.bar.mint,
    coin: r.ticker && r.name ? { ticker: r.ticker, name: r.name } : null,
    handle: r.handle,
    creatorWallet: r.bar.creatorWallet,
    confirmedBy: r.bar.confirmedBy,
    confirmedAt: r.bar.confirmedAt,
    publishAt: r.bar.publishAt,
    liftedAt: r.bar.liftedAt,
    replies: r.replies,
    appeals: r.appeals,
    openAppeal: r.openAppeal,
  }));
}

/** One Bar with everything about it: its case, the creator's replies and appeals, its X message and its cancelled Fair Opens. */
export async function barDetail(tx: DbOrTransaction, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await tx
    .select({ bar: bars, c: bundleCases, handle: creators.xHandle, ticker: launches.ticker, name: launches.name })
    .from(bars)
    .innerJoin(bundleCases, eq(bundleCases.id, bars.caseId))
    .leftJoin(creators, eq(creators.id, bars.creatorId))
    .leftJoin(launches, eq(launches.mint, bars.mint))
    .where(eq(bars.id, id));
  if (!row) return null;
  const [replies, appeals, messages, cancelled] = [
    await tx.select().from(barReplies).where(eq(barReplies.barId, id)).orderBy(asc(barReplies.at)),
    await tx.select().from(barAppeals).where(eq(barAppeals.barId, id)).orderBy(asc(barAppeals.filedAt)),
    await tx.select().from(xMessages).where(eq(xMessages.barId, id)),
    await tx
      .select({ fairOpen: launches.fairOpen, teaser: launches.teaser, opensAt: launches.opensAt, cancelledAt: launches.cancelledAt })
      .from(launches)
      .where(eq(launches.cancelBar, id)),
  ];
  return {
    bar: row.bar,
    case: row.c,
    handle: row.handle,
    coin: row.ticker && row.name ? { ticker: row.ticker, name: row.name } : null,
    replies,
    appeals,
    message: messages[0] ?? null,
    cancelled,
  };
}

export type BarDetail = NonNullable<Awaited<ReturnType<typeof barDetail>>>;

/** How long an item has waited, against the aim. */
export function ageOf(since: Date, now = new Date()) {
  const hours = Math.max(0, (now.getTime() - since.getTime()) / 3_600_000);
  return { hours, share: Math.min(1, hours / AIM_HOURS), state: hours >= AIM_HOURS ? ("over" as const) : hours >= AIM_HOURS / 2 ? ("late" as const) : ("fresh" as const) };
}

/** One refused launch by its key, if it is still in the queue. */
export async function launchItem(tx: DbOrTransaction, key: LaunchKey): Promise<LaunchItem | null> {
  return (await launchItems(tx)).find((i) => sameLaunch(i.key, key) && i.key.imageSha256 === key.imageSha256) ?? null;
}

/** One launch and wallet's admission reviews, if any is still open. */
export async function admissionItem(tx: DbOrTransaction, launch: string, wallet: string): Promise<AdmissionItem | null> {
  return (await admissionItems(tx)).find((i) => i.launch === launch && i.wallet === wallet) ?? null;
}

/** A bundling case by its coin, open or not. */
export async function caseByMint(tx: DbOrTransaction, mint: string) {
  const [row] = await tx
    .select({ c: bundleCases, handle: creators.xHandle, ticker: launches.ticker, name: launches.name, quoteMint: launches.quoteMint })
    .from(bundleCases)
    .leftJoin(creators, eq(creators.id, bundleCases.creatorId))
    .leftJoin(launches, eq(launches.mint, bundleCases.mint))
    .where(eq(bundleCases.mint, mint));
  return row ?? null;
}

/** The latest decision on a refused launch, for a page whose item has left the queue. */
export async function lastLaunchReview(tx: DbOrTransaction, key: LaunchKey) {
  const [row] = await tx
    .select()
    .from(launchReviews)
    .where(and(eq(launchReviews.creatorId, key.creatorId), eq(launchReviews.ticker, key.ticker), eq(launchReviews.name, key.name)))
    .orderBy(desc(launchReviews.decidedAt))
    .limit(1);
  return row ?? null;
}
