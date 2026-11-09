// What an operator can do from the queue (spec 6.2, 6.3, 6.6): clear a refused launch or keep it refused, clear a wallet
// for future Fair Opens, name its funding root a hub or keep its refusal or merge, and open a case's evidence pack. Each
// runs as `heat_operator` and writes its audit row in the same transaction. Confirming cases and hearing their appeals
// come with the Bars (#56).
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { admissionReviews, auditLog, launchReviews, linkageHubs, vampAppeals, vampClearances, walletClearances, type Db, type DbOrTransaction, type OperatorAction } from "@top-pad/db";
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
      creator: { id: key.creatorId, handle: item.handle },
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
