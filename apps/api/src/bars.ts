// Bars (spec 6.5, 7; #56). An operator confirms a bundling case in the operator app, which writes the Bar, cancels the
// creator's Fair Opens not yet in their window and owes them an X direct message, all in one transaction. From then the
// launch service refuses every launch of the record, its Creator wallet then or its linked X account then, before our
// launch key co-signs anything. The finding is private to its creator for 72 hours, on their record with the evidence
// pack, a reply box and the appeal form; then the record, the coin's page and its Fairness card show it. An upheld
// appeal, heard by another operator, lifts the Bar and takes the finding off every public page; the audit log keeps it.
// A Bar never expires and only stops new launches: earnings, the Creator lock, trading and deposits go on.
import {
  APPEAL_DECISION_MS,
  APPEAL_WINDOW_MS,
  BarAppealRequest,
  BarEvidence,
  BarReplyRequest,
  type AppealStatus,
  type BarCoin,
  type CoinFinding,
  type EnforcementCounts,
  type PrivateBar,
  type PublicBar,
} from "@top-pad/contract";
import { barAppeals, barReplies, bars, bundleCases, coins, creatorWallets, xMessages, type Db, type DbOrTransaction } from "@top-pad/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { sessionCreator } from "./auth";
import type { Bindings, Config, SecretBinding } from "./env";
import { refuse, type AppEnv } from "./http";

type BarRow = typeof bars.$inferSelect;
type AppealRow = typeof barAppeals.$inferSelect;

/**
 * The Bar standing against a launch, if any (spec 6.5): one on the record itself, on the wallet that would sign, or on
 * the X account the record has linked. A lifted Bar stands against nothing.
 */
export async function standingBar(db: DbOrTransaction, who: { creatorId: string; wallet: string; xUserId: string | null }): Promise<BarRow | null> {
  const [row] = await db
    .select()
    .from(bars)
    .where(
      and(
        isNull(bars.liftedAt),
        or(eq(bars.creatorId, who.creatorId), eq(bars.creatorWallet, who.wallet), who.xUserId ? eq(bars.xUserId, who.xUserId) : sql`false`),
      ),
    )
    .orderBy(asc(bars.confirmedAt))
    .limit(1);
  return row ?? null;
}

/** The launch service's refusal for a barred creator: our launch key declines to co-sign, and the creator learns where to answer. */
export function barredRefusal(bar: BarRow, ticker: string | null) {
  const coin = ticker ? `$${ticker}` : "one of your coins";
  return {
    error: `Heat's launch key no longer co-signs your launches: an operator confirmed a creator bundle in ${coin} on ${bar.confirmedAt.toISOString().slice(0, 10)}. The evidence, a reply box and the appeal form are on your Creator record.`,
    code: "barred" as const,
  };
}

/** The refusal for a launch a Bar stands against, or null when none does. */
export async function barProblem(db: DbOrTransaction, who: { creatorId: string; wallet: string; xUserId: string | null }) {
  const bar = await standingBar(db, who);
  if (!bar) return null;
  const [coin] = await db.select({ ticker: coins.ticker }).from(coins).where(eq(coins.mint, bar.mint));
  return barredRefusal(bar, coin?.ticker ?? null);
}

/** The Bars on a record: its own, and any on a wallet that was its Creator wallet in a coin no record holds. */
function barsOfRecord(creatorId: string, wallets: string[]) {
  return wallets.length ? or(eq(bars.creatorId, creatorId), and(isNull(bars.creatorId), inArray(bars.creatorWallet, wallets))) : eq(bars.creatorId, creatorId);
}

/** Whether a record has any Bar standing, published or still private: a good record has none (spec 7). */
export async function hasStandingBar(db: Db, creatorId: string, wallets: string[]) {
  const [row] = await db
    .select({ id: bars.id })
    .from(bars)
    .where(and(isNull(bars.liftedAt), barsOfRecord(creatorId, wallets)))
    .limit(1);
  return row !== undefined;
}

/** The evidence pack the case kept, as the record shows it. */
function evidenceOf(pack: unknown): BarEvidence {
  const p = pack as {
    reviewedAt: string;
    rule: string;
    creator: { wallet: string };
    creation: { signature: string; explorer: string; slot: number; blockIndex: number | null };
    floor: BarEvidence["floor"];
    wallets: unknown[];
  };
  return BarEvidence.parse({
    reviewedAt: p.reviewedAt,
    rule: p.rule,
    creatorWallet: p.creator.wallet,
    creation: { signature: p.creation.signature, explorer: p.creation.explorer, slot: p.creation.slot, blockIndex: p.creation.blockIndex },
    floor: p.floor,
    wallets: p.wallets,
  });
}

async function coinsOf(db: Db, mints: string[]): Promise<Map<string, BarCoin>> {
  if (!mints.length) return new Map();
  const rows = await db.select({ mint: coins.mint, name: coins.name, ticker: coins.ticker, imageUri: coins.imageUri }).from(coins).where(inArray(coins.mint, mints));
  return new Map(rows.map((r) => [r.mint, r]));
}

const coinOr = (found: Map<string, BarCoin>, mint: string): BarCoin => found.get(mint) ?? { mint, name: "Unknown coin", ticker: "?", imageUri: null };

/** Where the appeals of a Bar leave it, for the public: none filed, one waiting, or denied (an upheld one lifts the Bar). */
function appealStatusOf(appeals: AppealRow[]): { status: AppealStatus; filedAt: Date | null; decidedAt: Date | null } {
  const last = appeals.at(-1);
  if (!last) return { status: "none", filedAt: null, decidedAt: null };
  return { status: last.status === "open" ? "open" : "denied", filedAt: last.filedAt, decidedAt: last.decidedAt };
}

async function appealsOf(db: Db, barIds: string[]) {
  if (!barIds.length) return new Map<string, AppealRow[]>();
  const rows = await db.select().from(barAppeals).where(inArray(barAppeals.barId, barIds)).orderBy(asc(barAppeals.filedAt));
  const by = new Map<string, AppealRow[]>();
  for (const r of rows) by.set(r.barId, [...(by.get(r.barId) ?? []), r]);
  return by;
}

/** A record's published Bars, newest first (spec 6.5): past their private window and never lifted. */
export async function publishedBars(db: Db, creatorId: string, wallets: string[], now = new Date()): Promise<PublicBar[]> {
  const rows = await db
    .select({ bar: bars, evidence: bundleCases.evidence })
    .from(bars)
    .innerJoin(bundleCases, eq(bundleCases.id, bars.caseId))
    .where(and(isNull(bars.liftedAt), lte(bars.publishAt, now), barsOfRecord(creatorId, wallets)))
    .orderBy(desc(bars.confirmedAt));
  const found = await coinsOf(db, rows.map((r) => r.bar.mint));
  const appeals = await appealsOf(db, rows.map((r) => r.bar.id));
  return rows.map(({ bar, evidence }) => {
    const appeal = appealStatusOf(appeals.get(bar.id) ?? []);
    return {
      coin: coinOr(found, bar.mint),
      confirmedAt: bar.confirmedAt.toISOString(),
      publishedAt: bar.publishAt.toISOString(),
      appeal: { status: appeal.status, filedAt: appeal.filedAt?.toISOString() ?? null, decidedAt: appeal.decidedAt?.toISOString() ?? null },
      evidence: evidenceOf(evidence),
    };
  });
}

/** "Confirmed creator bundle" on a coin (spec 6.5, 9): its Bar's finding, once published and while it stands. */
export async function coinFinding(db: Db, mint: string, now = new Date()): Promise<CoinFinding | null> {
  const [bar] = await db
    .select()
    .from(bars)
    .where(and(eq(bars.mint, mint), isNull(bars.liftedAt), lte(bars.publishAt, now)))
    .limit(1);
  if (!bar) return null;
  const appeal = appealStatusOf((await appealsOf(db, [bar.id])).get(bar.id) ?? []);
  return { kind: "confirmed_creator_bundle", confirmedAt: bar.confirmedAt.toISOString(), publishedAt: bar.publishAt.toISOString(), appeal: appeal.status };
}

/** What a creator may file against a Bar now: a first appeal within 30 days, another only after a denial, with new evidence. */
function canAppeal(bar: BarRow, appeals: AppealRow[], now: Date): PrivateBar["canAppeal"] {
  if (bar.liftedAt) return null;
  const last = appeals.at(-1);
  if (!last) return now.getTime() <= bar.confirmedAt.getTime() + APPEAL_WINDOW_MS ? "first" : null;
  return last.status === "denied" ? "new_evidence" : null;
}

/** Every Bar of a record as its creator sees it, private ones included. */
export async function privateBars(db: Db, creatorId: string, wallets: string[], now = new Date()): Promise<PrivateBar[]> {
  const rows = await db
    .select({ bar: bars, evidence: bundleCases.evidence })
    .from(bars)
    .innerJoin(bundleCases, eq(bundleCases.id, bars.caseId))
    .where(barsOfRecord(creatorId, wallets))
    .orderBy(desc(bars.confirmedAt));
  const ids = rows.map((r) => r.bar.id);
  const found = await coinsOf(db, rows.map((r) => r.bar.mint));
  const appeals = await appealsOf(db, ids);
  const replies = ids.length ? await db.select().from(barReplies).where(inArray(barReplies.barId, ids)).orderBy(asc(barReplies.at)) : [];
  const messages = ids.length ? await db.select().from(xMessages).where(inArray(xMessages.barId, ids)) : [];
  return rows.map(({ bar, evidence }) => {
    const own = appeals.get(bar.id) ?? [];
    const message = messages.find((m) => m.barId === bar.id);
    return {
      id: bar.id,
      coin: coinOr(found, bar.mint),
      confirmedAt: bar.confirmedAt.toISOString(),
      publishAt: bar.publishAt.toISOString(),
      published: bar.publishAt.getTime() <= now.getTime(),
      liftedAt: bar.liftedAt?.toISOString() ?? null,
      message: message ? { sentAt: message.sentAt?.toISOString() ?? null } : null,
      evidence: evidenceOf(evidence),
      replies: replies.filter((r) => r.barId === bar.id).map((r) => ({ id: r.id, body: r.body, at: r.at.toISOString() })),
      appeals: own.map((a) => ({
        id: a.id,
        grounds: a.grounds,
        statement: a.statement,
        evidence: a.evidence,
        status: a.status,
        filedAt: a.filedAt.toISOString(),
        dueAt: new Date(a.filedAt.getTime() + APPEAL_DECISION_MS).toISOString(),
        decidedAt: a.decidedAt?.toISOString() ?? null,
        decision: a.decisionNote,
      })),
      canAppeal: canAppeal(bar, own, now),
      appealBy: new Date(bar.confirmedAt.getTime() + APPEAL_WINDOW_MS).toISOString(),
    };
  });
}

/** The record's Creator wallets over time. */
export async function walletsOfRecord(db: Db, creatorId: string) {
  const rows = await db.select({ wallet: creatorWallets.wallet }).from(creatorWallets).where(eq(creatorWallets.creatorId, creatorId));
  return rows.map((r) => r.wallet);
}

/** The Bar a creator writes about, which must be their record's; or the refusal to answer with. */
async function ownBar(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return { refusal: c.json({ error: "Sign in as the barred record's creator first." }, 401) } as const;
  const id = c.req.param("id")!;
  if (!/^[0-9a-f-]{36}$/.test(id)) return { refusal: c.json({ error: "There is no such Bar." }, 404) } as const;
  const [bar] = await c.var.db.select().from(bars).where(eq(bars.id, id));
  const wallets = bar ? await walletsOfRecord(c.var.db, creator.id) : [];
  const own = bar && (bar.creatorId === creator.id || (bar.creatorId === null && wallets.includes(bar.creatorWallet)));
  if (!bar || !own) return { refusal: c.json({ error: "There is no such Bar on your record." }, 404) } as const;
  return { creator, bar } as const;
}

/** `POST /bars/:id/replies`: the barred creator's reply to the evidence, for the operator who hears their case. */
export async function replyToBar(c: Context<AppEnv>) {
  const found = await ownBar(c);
  if ("refusal" in found) return found.refusal;
  const body = BarReplyRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Write your reply: up to 2,000 characters." }, 400);
  if (found.bar.liftedAt) return c.json({ error: "This Bar was lifted on appeal: there is nothing left to answer." }, 409);
  const [row] = await c.var.db.insert(barReplies).values({ barId: found.bar.id, creatorId: found.creator.id, body: body.data.body }).returning();
  return c.json({ id: row!.id, body: row!.body, at: row!.at.toISOString() }, 201);
}

/**
 * `POST /bars/:id/appeals` (spec 6.5): one appeal within 30 days of the Bar; another only once the last was denied, and
 * only with evidence it has not seen. One waits at a time.
 */
export async function appealBar(c: Context<AppEnv>) {
  const found = await ownBar(c);
  if ("refusal" in found) return found.refusal;
  const body = BarAppealRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Say which link is wrong and why, in up to 2,000 characters.", code: "invalid" });
  const { db } = c.var;
  const { bar, creator } = found;
  const appeals = await db.select().from(barAppeals).where(eq(barAppeals.barId, bar.id)).orderBy(asc(barAppeals.filedAt));
  const may = canAppeal(bar, appeals, new Date());
  if (!may) {
    const last = appeals.at(-1);
    const error = bar.liftedAt
      ? "This Bar was lifted on appeal."
      : last?.status === "open"
        ? "Your appeal is with an operator: one waits at a time."
        : "The 30 days to appeal this Bar have passed.";
    return c.json({ error }, 409);
  }
  const evidence = body.data.evidence?.trim() || null;
  if (may === "new_evidence") {
    if (!evidence) return c.json({ error: "Your last appeal was denied: another needs new evidence. Say what it is and link it." }, 409);
    const seen = new Set(appeals.map((a) => a.evidence?.trim().toLowerCase()).filter(Boolean));
    if (seen.has(evidence.toLowerCase())) return c.json({ error: "That evidence was in an earlier appeal: another needs evidence the operator has not seen." }, 409);
  }
  const [row] = await db
    .insert(barAppeals)
    .values({ barId: bar.id, creatorId: creator.id, grounds: body.data.grounds, statement: body.data.statement, evidence })
    .returning()
    .catch((e: { code?: string; cause?: { code?: string } }) => {
      if ((e.cause?.code ?? e.code) === "23505") return [] as AppealRow[];
      throw e;
    });
  if (!row) return c.json({ error: "Your appeal is with an operator: one waits at a time." }, 409);
  return c.json({ id: row.id, status: row.status, filedAt: row.filedAt.toISOString(), dueAt: new Date(row.filedAt.getTime() + APPEAL_DECISION_MS).toISOString() }, 201);
}

/**
 * The counts "How this is enforced" publishes (spec 6.5): findings confirmed and past their private window, or
 * overturned within it; the appeals filed against them; and those overturned. A finding still private counts nowhere.
 */
export async function enforcementCounts(db: Db, now = new Date()): Promise<EnforcementCounts> {
  const counted = or(lte(bars.publishAt, now), isNotNull(bars.liftedAt));
  const [row] = await db
    .select({
      bars: sql<number>`count(distinct ${bars.id})::int`,
      overturned: sql<number>`count(distinct ${bars.id}) filter (where ${bars.liftedAt} is not null)::int`,
      appeals: sql<number>`count(${barAppeals.id})::int`,
    })
    .from(bars)
    .leftJoin(barAppeals, eq(barAppeals.barId, bars.id))
    .where(counted);
  return { bars: row?.bars ?? 0, appeals: row?.appeals ?? 0, overturned: row?.overturned ?? 0, servedAt: now.toISOString() };
}

/** `GET /enforcement`. */
export async function getEnforcement(c: Context<AppEnv>) {
  c.header("cache-control", "public, max-age=60");
  return c.json(await enforcementCounts(c.var.db));
}

/** How many messages one run sends at most, and how often one is tried before it is left for the operator. */
const NOTICES_PER_RUN = 20;
const MAX_ATTEMPTS = 12;

/** Heat's own X account's token for direct messages, if this deployment has one. */
async function dmToken(env: Bindings): Promise<string | null> {
  const binding = env.X_DM_TOKEN;
  if (!binding) return null;
  return typeof binding === "string" ? binding : (binding as SecretBinding).get();
}

/**
 * The cron's `bar-notices` job: sends each X direct message a Bar owes its creator, from Heat's own X account, through X's
 * API (`POST /2/dm_conversations/with/:participant_id/messages`), recording X's id for it. A message that fails is tried
 * again next run, up to 12 times; without a token nothing is sent and the messages wait.
 */
export async function sendBarNotices(db: Db, cfg: Config, env: Bindings) {
  const unsent = await db
    .select()
    .from(xMessages)
    .where(and(isNull(xMessages.sentAt), sql`${xMessages.attempts} < ${MAX_ATTEMPTS}`))
    .orderBy(asc(xMessages.createdAt))
    .limit(NOTICES_PER_RUN);
  if (!unsent.length) return { sent: 0, failed: 0, waiting: 0 };
  const token = cfg.x ? await dmToken(env) : null;
  if (!cfg.x || !token) return { sent: 0, failed: 0, waiting: unsent.length, reason: "no X direct-message token on this deployment" };
  let sent = 0;
  let failed = 0;
  for (const message of unsent) {
    try {
      const res = await fetch(`${cfg.x.apiUrl}/2/dm_conversations/with/${encodeURIComponent(message.xUserId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: message.text }),
        signal: AbortSignal.timeout(10_000),
      });
      const answer = (await res.json().catch(() => null)) as { data?: { dm_event_id?: string }; detail?: string; title?: string } | null;
      if (!res.ok || !answer?.data?.dm_event_id) throw new Error(`X answered ${res.status}: ${answer?.detail ?? answer?.title ?? "no message id"}`);
      await db.update(xMessages).set({ sentAt: sql`now()`, xEventId: answer.data.dm_event_id, attempts: sql`${xMessages.attempts} + 1`, lastError: null }).where(eq(xMessages.id, message.id));
      sent++;
    } catch (e) {
      failed++;
      await db
        .update(xMessages)
        .set({ attempts: sql`${xMessages.attempts} + 1`, lastError: (e as Error).message.slice(0, 500) })
        .where(eq(xMessages.id, message.id));
    }
  }
  return { sent, failed, waiting: unsent.length - sent - failed };
}
