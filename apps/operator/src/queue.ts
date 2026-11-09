// The operator queue (spec 6.6): one list of everything waiting on a person, refused launches with their appeals,
// refused or merged admissions, and bundling cases, each with its age against the 48-hour aim. Read as `heat_operator`.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ProtectedMatch } from "@top-pad/contract";
import { admissionReviews, bundleCases, creators, launches, launchReviews, vampAppeals, type DbOrTransaction } from "@top-pad/db";

/** How soon the queue aims to answer each item (spec 6.6). */
export const AIM_HOURS = 48;

export type Field = "ticker" | "name" | "image";

/** A Protected coin a refused launch matched, on one field, and the reason the creator was given. */
export type Refusing = { field: Field; coin: ProtectedMatch; reason: string };

/** A creator's appeal, as the queue shows it. */
export type Appeal = { id: string; original: string | null; message: string; createdAt: Date; imageSha256: string | null };

/** Which refused launch an item is: a creator's ticker, name and image as Vamp Shield refused them. */
export type LaunchKey = { creatorId: string; ticker: string; name: string; imageSha256: string | null };

export type LaunchItem = {
  kind: "launch";
  key: LaunchKey;
  handle: string;
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

export type QueueItem = LaunchItem | AdmissionItem | CaseItem;

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
    x_handle: string;
  }>(sql`
    with refusals as (
      select creator_id, ticker, name, image_sha256, min(at) as first_at, max(at) as last_at, count(*)::int as attempts,
             (array_agg(matches order by at desc))[1] as matches
      from vamp_checks
      where stage = 'prepare' and outcome = 'refused' and creator_id is not null and ticker is not null and name is not null
      group by creator_id, ticker, name, image_sha256
    )
    select r.*, c.x_handle
    from refusals r join creators c on c.id = r.creator_id
    where not exists (
      select 1 from launch_reviews lr
      where lr.creator_id = r.creator_id and lr.ticker = r.ticker and lr.name = r.name
        and lr.image_sha256 is not distinct from r.image_sha256 and lr.decided_at >= r.last_at
    )
  `);
  const appeals = await tx
    .select({ appeal: vampAppeals, handle: creators.xHandle })
    .from(vampAppeals)
    .innerJoin(creators, eq(creators.id, vampAppeals.creatorId))
    .where(eq(vampAppeals.status, "open"))
    .orderBy(vampAppeals.createdAt);

  const items: LaunchItem[] = refusals.map((r) => ({
    kind: "launch",
    key: { creatorId: r.creator_id, ticker: r.ticker, name: r.name, imageSha256: r.image_sha256 },
    handle: r.x_handle,
    since: date(r.first_at),
    attempts: r.attempts,
    lastRefusedAt: date(r.last_at),
    refusing: refusingIn(r.matches),
    appeals: [],
  }));
  for (const { appeal, handle } of appeals) {
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

/** Bundling cases still open: confirming them comes with the Bars (#56), so every case stays until then. */
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

/** The whole queue, oldest first: what is closest to the 48-hour aim, or past it, comes first. */
export async function queue(tx: DbOrTransaction): Promise<QueueItem[]> {
  const [l, a, c] = [await launchItems(tx), await admissionItems(tx), await caseItems(tx)];
  return [...l, ...a, ...c].sort((x, y) => x.since.getTime() - y.since.getTime());
}

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
