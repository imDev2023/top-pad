// What an operator can do from the queue (spec 6.2, 6.3, 6.6): clear a refused launch or keep it refused, clear a wallet
// for future Fair Opens, name its funding root a hub or keep its refusal or merge, and open a case's evidence pack. Each
// runs as `heat_operator` and writes its audit row in the same transaction. Confirming a case bars its creator, and a
// barred creator's appeal is heard by another operator (spec 6.5, #56).
import { and, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { APPEAL_WINDOW_MS, publishAtOf } from "@top-pad/contract";
import {
  admissionReviews,
  auditLog,
  barAppeals,
  bars,
  bundleCases,
  creators,
  creatorWallets,
  knownBots,
  launches,
  launchReviews,
  linkageHubs,
  vampAppeals,
  vampClearances,
  walletClearances,
  xMessages,
  type Db,
  type DbOrTransaction,
  type OperatorAction,
} from "@top-pad/db";
import { asOperator } from "./db";
import type { Operator } from "./env";
import { admissionItem, launchItem, type LaunchKey } from "./queue";

/** An action the operator asked for that cannot be done as asked, with what to tell them. */
export class Refused extends Error {}

/** Writes one audit row: who did what to what, and why. Returns its id. */
export async function audit(tx: DbOrTransaction, operator: Operator, action: OperatorAction, subject: string, detail: Record<string, unknown>) {
  const [row] = await tx.insert(auditLog).values({ operator: operator.email, action, subject, detail }).returning({ id: auditLog.id });
  return row!.id;
}

/** Notes are the operator's own words for the record: required, and bounded. */
export function noteOf(input: unknown): string {
  const note = typeof input === "string" ? input.trim() : "";
  if (!note) throw new Refused("Say why, in a few words: the audit log keeps the reason with the decision.");
  if (note.length > 1_000) throw new Refused("Keep the reason to 1,000 characters.");
  return note;
}

/** A Solana address as base58: 32 to 44 characters, no 0, O, I or l. */
export const isAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/**
 * Clears a refused launch, so its creator may launch its ticker, name and image though each matched a Protected coin, or
 * keeps it refused; either way the creator's open appeals for it are decided with it (upheld or denied).
 */
export async function decideLaunch(db: Db, operator: Operator, key: LaunchKey, decision: "cleared" | "kept", noteInput: unknown) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const item = await launchItem(tx, key);
    if (!item) throw new Refused("This refused launch is no longer in the queue: another decision was made first.");
    const [review] = await tx
      .insert(launchReviews)
      .values({ creatorId: key.creatorId, ticker: key.ticker, name: key.name, imageSha256: key.imageSha256, decision, note, operator: operator.email })
      .returning({ id: launchReviews.id });
    const fields = item.refusing.flatMap((r) => {
      const value = r.field === "ticker" ? key.ticker : r.field === "name" ? key.name : key.imageSha256;
      return value ? [{ field: r.field, value }] : [];
    });
    if (decision === "cleared" && fields.length > 0) {
      await tx
        .insert(vampClearances)
        .values(fields.map((f) => ({ creatorId: key.creatorId, ...f, reviewId: review!.id })))
        .onConflictDoNothing();
    }
    const appeals = item.appeals.map((a) => a.id);
    if (appeals.length > 0) {
      await tx
        .update(vampAppeals)
        .set({ status: decision === "cleared" ? "upheld" : "denied", decidedAt: sql`now()`, decidedBy: operator.email, reviewId: review!.id })
        .where(and(inArray(vampAppeals.id, appeals), eq(vampAppeals.status, "open")));
    }
    const auditId = await audit(tx, operator, decision === "cleared" ? "launch_cleared" : "launch_kept", `launch:${key.creatorId}:${key.ticker}`, {
      review: review!.id,
      creator: { id: key.creatorId, handle: item.handle, wallet: item.creatorWallet },
      ticker: key.ticker,
      name: key.name,
      imageSha256: key.imageSha256,
      fields: decision === "cleared" ? fields.map((f) => f.field) : [],
      refusing: item.refusing.map((r) => ({ field: r.field, coin: r.coin.mint, ticker: r.coin.ticker, source: r.coin.source })),
      appeals,
      note,
    });
    return { auditId, review: review!.id, fields: fields.map((f) => f.field), appeals };
  });
}

/**
 * Deals with a launch's refused or merged admission of a wallet: `cleared` clears the wallet for future Fair Opens (spec
 * 6.3), answering every open review of it; `hub` names the wallet's funding root a hub, which then ties nobody, answering
 * every open review whose chain tops out there; `kept` leaves the refusal or merge as it was.
 */
export async function decideAdmission(db: Db, operator: Operator, launch: string, wallet: string, decision: "cleared" | "hub" | "kept", noteInput: unknown, hubLabel?: unknown) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const item = await admissionItem(tx, launch, wallet);
    if (!item) throw new Refused("This admission is no longer in the queue: another decision was made first.");
    const resolve = (where: ReturnType<typeof and>, resolution: "cleared" | "hub" | "kept") =>
      tx
        .update(admissionReviews)
        .set({ resolvedAt: sql`now()`, resolution, resolvedBy: operator.email })
        .where(and(where, isNull(admissionReviews.resolvedAt)))
        .returning({ launch: admissionReviews.launch, wallet: admissionReviews.wallet, kind: admissionReviews.kind });
    const kinds = item.reviews.map((r) => r.kind);
    if (decision === "cleared") {
      await tx.insert(walletClearances).values({ wallet, note, operator: operator.email }).onConflictDoNothing();
      const answered = await resolve(eq(admissionReviews.wallet, wallet), "cleared");
      const auditId = await audit(tx, operator, "wallet_cleared", `wallet:${wallet}`, { launch, kinds, answered, note });
      return { auditId, answered };
    }
    if (decision === "hub") {
      if (!item.root) throw new Refused("This wallet's SOL came from no other wallet, so there is no funding root to name a hub.");
      const label = typeof hubLabel === "string" ? hubLabel.trim() : "";
      if (!label || label.length > 120) throw new Refused("Name the hub in at most 120 characters: \"Binance hot wallet 3\".");
      await tx.insert(linkageHubs).values({ address: item.root, label, addedBy: operator.email }).onConflictDoNothing();
      const answered = await resolve(sql`${admissionReviews.evidence} -> 'wallet' ->> 'root' = ${item.root}`, "hub");
      const auditId = await audit(tx, operator, "hub_added", `wallet:${item.root}`, { label, from: { launch, wallet, kinds }, answered, note });
      return { auditId, answered };
    }
    const answered = await resolve(and(eq(admissionReviews.launch, launch), eq(admissionReviews.wallet, wallet))!, "kept");
    const auditId = await audit(tx, operator, "admission_kept", `wallet:${wallet}`, { launch, kinds, note });
    return { auditId, answered };
  });
}

/** Names an address a hub from the hubs page (spec 6.3): an exchange, bridge, router or faucet that ties nobody. */
export async function addHub(db: Db, operator: Operator, addressInput: unknown, labelInput: unknown) {
  const address = typeof addressInput === "string" ? addressInput.trim() : "";
  const label = typeof labelInput === "string" ? labelInput.trim() : "";
  if (!isAddress(address)) throw new Refused("That is not a Solana address.");
  if (!label || label.length > 120) throw new Refused("Name the hub in at most 120 characters: \"Binance hot wallet 3\".");
  return asOperator(db, async (tx) => {
    const [added] = await tx.insert(linkageHubs).values({ address, label, addedBy: operator.email }).onConflictDoNothing().returning({ address: linkageHubs.address });
    if (!added) throw new Refused("That address is a hub already.");
    return { auditId: await audit(tx, operator, "hub_added", `wallet:${address}`, { label }) };
  });
}

/** Takes an address off the hubs, so the linkage pipeline follows funding through it again. */
export async function removeHub(db: Db, operator: Operator, address: string, noteInput: unknown) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const [removed] = await tx.delete(linkageHubs).where(eq(linkageHubs.address, address)).returning();
    if (!removed) throw new Refused("That address is not a hub.");
    return { auditId: await audit(tx, operator, "hub_removed", `wallet:${address}`, { label: removed.label, addedBy: removed.addedBy, note }) };
  });
}

/**
 * Takes a wallet off the known-bot list (spec 8): Trending counts it again, and the known-bot job never lists it again;
 * its row keeps why it was listed.
 */
export async function removeBot(db: Db, operator: Operator, wallet: string, noteInput: unknown) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const [removed] = await tx
      .update(knownBots)
      .set({ removedAt: sql`now()`, removedBy: operator.email, removedNote: note })
      .where(and(eq(knownBots.wallet, wallet), isNull(knownBots.removedAt)))
      .returning();
    if (!removed) throw new Refused("That wallet is not on the known-bot list.");
    return {
      auditId: await audit(tx, operator, "bot_removed", `wallet:${wallet}`, { earlyLaunches: removed.earlyLaunches, roundTrips: removed.roundTrips, evidence: removed.evidence, note }),
    };
  });
}

/** Records that an operator opened a case's evidence pack: every look at a case's evidence is in the audit log. */
export async function openEvidence(db: Db, operator: Operator, mint: string) {
  return asOperator(db, async (tx) => ({ auditId: await audit(tx, operator, "evidence_opened", `case:${mint}`, {}) }));
}

/** Whether this operator opened this case's evidence, by the audit row the page was given, within the hour. */
export async function openedRecently(db: Db, operator: Operator, mint: string, auditId: number) {
  return asOperator(db, async (tx) => {
    const [row] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.id, auditId),
          eq(auditLog.action, "evidence_opened"),
          eq(auditLog.subject, `case:${mint}`),
          eq(auditLog.operator, operator.email),
          sql`${auditLog.at} > now() - interval '1 hour'`,
        ),
      );
    return row !== undefined;
  });
}

/** The record a case's coin belongs to: the case's own, or the record whose Creator wallet launched it then. */
async function recordOfCase(tx: DbOrTransaction, c: typeof bundleCases.$inferSelect) {
  if (c.creatorId) return c.creatorId;
  const [row] = await tx
    .select({ id: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.wallet, c.creatorWallet), sql`${creatorWallets.startedAt} <= ${c.openedAt.toISOString()}`))
    .orderBy(sql`${creatorWallets.startedAt} desc`)
    .limit(1);
  return row?.id ?? null;
}

/** The X direct message a Bar owes its creator (spec 6.5): what happened, where the evidence is, and when it goes public. */
export function barNotice(o: { ticker: string | null; webApp: string; recordId: string | null; wallet: string; publishAt: Date; appealBy: Date }) {
  const coin = o.ticker ? `$${o.ticker}` : "one of your coins";
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return [
    `Heat: an operator confirmed a creator bundle in ${coin}, so Heat's launch key no longer co-signs your launches.`,
    `The evidence and a reply box are on your Creator record, private to you until ${day(o.publishAt)}, when the finding is published: ${o.webApp}/creator/${o.recordId ?? o.wallet}`,
    `You may appeal there until ${day(o.appealBy)}; another operator decides it within 48 hours.`,
  ].join("\n\n");
}

/** What a case's finding was, for the audit log, which keeps it whatever happens to the Bar. */
function findingOf(c: typeof bundleCases.$inferSelect) {
  const pack = (c.evidence ?? {}) as { floor?: unknown; wallets?: { wallet: string; labels: string[] }[] };
  return {
    mint: c.mint,
    creatorWallet: c.creatorWallet,
    linkedWallets: c.linkedWallets,
    floor: pack.floor ?? null,
    wallets: (pack.wallets ?? []).map((w) => ({ wallet: w.wallet, labels: w.labels })),
    evidenceKey: c.evidenceKey,
  };
}

/**
 * Confirms a bundling case or dismisses it (spec 6.5). Confirming bars the Creator at once: the Bar on the record, its
 * Creator wallet then and its linked X account then, which the launch service checks before our launch key co-signs;
 * every Fair Open of the record or wallet not yet in its window is cancelled, so it takes no deposits and fails at its
 * open; and an X direct message is owed when the record linked X, which the API's cron sends. The finding stays private
 * for 72 hours. Dismissing closes the case with no Bar.
 */
export async function decideCase(db: Db, operator: Operator, mint: string, decision: "confirmed" | "dismissed", noteInput: unknown, webApp: string) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const [c] = await tx.select().from(bundleCases).where(eq(bundleCases.mint, mint)).for("update");
    if (!c) throw new Refused("Bundle Radar opened no case for this coin.");
    if (c.status !== "open") throw new Refused(`This case was ${c.status} already, by ${c.decidedBy ?? "another operator"}: another decision was made first.`);
    await tx.update(bundleCases).set({ status: decision, decidedAt: sql`now()`, decidedBy: operator.email, decisionNote: note }).where(eq(bundleCases.id, c.id));
    const finding = findingOf(c);
    if (decision === "dismissed") {
      const auditId = await audit(tx, operator, "case_dismissed", `case:${mint}`, { case: c.id, finding, note });
      return { auditId, bar: null, cancelled: [] as string[], message: false };
    }

    const recordId = await recordOfCase(tx, c);
    const [record] = recordId ? await tx.select({ xUserId: creators.xUserId, handle: creators.xHandle }).from(creators).where(eq(creators.id, recordId)) : [];
    const confirmedAt = new Date();
    const publishAt = publishAtOf(confirmedAt);
    const [bar] = await tx
      .insert(bars)
      .values({ caseId: c.id, mint, creatorId: recordId, creatorWallet: c.creatorWallet, xUserId: record?.xUserId ?? null, confirmedBy: operator.email, confirmedAt, publishAt, note })
      .returning();
    // Every Fair Open of the record or its wallet whose window has not started: it takes no deposits from now and our
    // keeper sends none of its rungs. One already in its window keeps going, its depositors' money in it (spec 6.5).
    const cancelled = await tx
      .update(launches)
      .set({ cancelledAt: sql`now()`, cancelBar: bar!.id })
      .where(
        and(
          eq(launches.mode, "fair_open"),
          isNull(launches.cancelledAt),
          // A draft never submitted is no Fair Open yet, and the Bar refuses its submit.
          notInArray(launches.status, ["prepared", "failed", "expired"]),
          gt(launches.depositsOpenAt, sql`now()`),
          recordId ? or(eq(launches.creatorId, recordId), eq(launches.wallet, c.creatorWallet)) : eq(launches.wallet, c.creatorWallet),
        ),
      )
      .returning({ id: launches.id, fairOpen: launches.fairOpen, teaser: launches.teaser, opensAt: launches.opensAt });
    const [coin] = await tx.select({ ticker: launches.ticker }).from(launches).where(eq(launches.mint, mint));
    let message = false;
    if (record?.xUserId) {
      const appealBy = new Date(confirmedAt.getTime() + APPEAL_WINDOW_MS);
      await tx.insert(xMessages).values({ barId: bar!.id, xUserId: record.xUserId, text: barNotice({ ticker: coin?.ticker ?? null, webApp, recordId, wallet: c.creatorWallet, publishAt, appealBy }) });
      message = true;
    }
    const auditId = await audit(tx, operator, "case_confirmed", `case:${mint}`, {
      case: c.id,
      bar: bar!.id,
      record: recordId,
      handle: record?.handle ?? null,
      xUserId: record?.xUserId ?? null,
      publishAt: publishAt.toISOString(),
      cancelled: cancelled.map((l) => ({ launch: l.fairOpen, teaser: l.teaser, opensAt: l.opensAt?.toISOString() ?? null })),
      message,
      finding,
      note,
    });
    return { auditId, bar: bar!.id, cancelled: cancelled.map((l) => l.fairOpen ?? l.id), message };
  });
}

/**
 * Decides a barred creator's appeal (spec 6.5), by an operator other than the one who confirmed the Bar, unless this
 * deployment lets one operator fill both roles (devnet, where the owner is the only operator). Upheld lifts the Bar,
 * which takes the finding off every public page and lets the launch key co-sign again; the audit row keeps the finding.
 * Denied leaves it standing, and the creator may appeal again only with new evidence.
 */
export async function decideAppeal(db: Db, operator: Operator, appealId: string, decision: "upheld" | "denied", noteInput: unknown, oneOperator = false) {
  const note = noteOf(noteInput);
  return asOperator(db, async (tx) => {
    const [appeal] = await tx.select().from(barAppeals).where(eq(barAppeals.id, appealId)).for("update");
    if (!appeal) throw new Refused("There is no such appeal.");
    if (appeal.status !== "open") throw new Refused(`This appeal was ${appeal.status} already: another decision was made first.`);
    const [bar] = await tx.select().from(bars).where(eq(bars.id, appeal.barId)).for("update");
    if (!bar) throw new Refused("The appeal's Bar is gone.");
    const sameOperator = bar.confirmedBy === operator.email;
    if (sameOperator && !oneOperator) throw new Refused(`You confirmed this case, so another operator hears its appeal (spec 6.5): ${bar.confirmedBy} may not decide it.`);
    await tx.update(barAppeals).set({ status: decision, decidedAt: sql`now()`, decidedBy: operator.email, decisionNote: note }).where(eq(barAppeals.id, appeal.id));
    if (decision === "upheld") {
      await tx
        .update(bars)
        .set({ liftedAt: sql`now()`, liftedBy: operator.email, liftedAppeal: appeal.id })
        .where(and(eq(bars.id, bar.id), isNull(bars.liftedAt)));
    }
    const [c] = await tx.select().from(bundleCases).where(eq(bundleCases.id, bar.caseId));
    // The finding stays in the audit log whatever the appeal decided: the public record forgets an upheld one, this never does.
    const auditId = await audit(tx, operator, decision === "upheld" ? "appeal_upheld" : "appeal_denied", `bar:${bar.id}`, {
      appeal: appeal.id,
      bar: bar.id,
      case: bar.caseId,
      record: bar.creatorId,
      confirmedBy: bar.confirmedBy,
      confirmedAt: bar.confirmedAt.toISOString(),
      sameOperator,
      grounds: appeal.grounds,
      statement: appeal.statement,
      evidence: appeal.evidence,
      finding: c ? findingOf(c) : { mint: bar.mint, creatorWallet: bar.creatorWallet },
      note,
    });
    return { auditId, lifted: decision === "upheld" };
  });
}
