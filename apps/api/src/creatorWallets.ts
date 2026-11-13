// Changing a record's Creator wallet (spec 7). One Creator wallet at a time, the only wallet that signs the record's
// launches. It changes by a handover: the old wallet offers the record by signing Heat's message, and the new wallet takes
// it by signing the same message, so both signatures sit on the record for anyone to check. A lost wallet rotates through
// the record's X account instead: a browser that has just authorized that account at X names a new wallet, which signs,
// and the rotation takes effect after a public 7-day cooldown unless the current Creator wallet signs its cancellation.
// A record that linked no X has no way to rotate a lost wallet. One pending change per record at a time.
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  HandoverAcceptance,
  HandoverRequest,
  RotationRequest,
  SignedWalletMessage,
  type CreatorRef,
  type HandoverOffers,
  type WalletChange,
  type WalletChangeMessage,
  type WalletChangeRefusal,
} from "@top-pad/contract";
import { Address } from "@top-pad/contract";
import { creators, creatorWallets, walletChanges, type Db, type DbOrTransaction } from "@top-pad/db";
import { currentCreatorWallet, giveMessage, messageNonce, sessionCreator, signedBy, takeSignedMessage } from "./auth";
import { webApp, type Config } from "./env";
import type { AppEnv } from "./http";
import { getBase58Decoder } from "@solana/kit";

/** How long a rotation through X waits before it takes effect, in public, for the current Creator wallet to cancel it. */
export const ROTATION_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
/** How long a handover's offer stands for the new wallet to take. */
export const HANDOVER_OFFER_MS = 24 * 3600 * 1000;
/** How long a message may wait for the wallet asked to sign it. */
const SIGN_MS = 10 * 60 * 1000;
/** How recently the browser must have authorized the record's X account at X to ask for a rotation. */
export const X_RECENT_MS = 15 * 60 * 1000;

type Status = 400 | 401 | 403 | 404 | 409;
const refuse = (c: Context<AppEnv>, status: Status, body: WalletChangeRefusal) => c.json(body, status);
const short = (a: string) => `${a.slice(0, 4)}\u{2026}${a.slice(-4)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A change as the API shows it. */
export function walletChangeView(row: typeof walletChanges.$inferSelect): WalletChange {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    from: row.fromWallet,
    to: row.toWallet,
    message: row.message,
    fromSignature: row.fromSignature,
    toSignature: row.toSignature,
    xHandle: row.xHandle,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    cancelMessage: row.cancelMessage,
    cancelSignature: row.cancelSignature,
  };
}

/** The lines every change message ends with: where it is from, and the nonce and times that make it Heat's, once. */
function footer(cfg: Config, nonce: string, issuedAt: Date, expiresAt: Date) {
  const site = new URL(webApp(cfg));
  return ["", "Signing sends no transaction and costs nothing.", "", `URI: ${site.origin}`, `Chain ID: ${cfg.cluster}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt.toISOString()}`, `Expiration Time: ${expiresAt.toISOString()}`];
}

export function handoverMessage(cfg: Config, o: { record: string; from: string; to: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  return [
    `${new URL(webApp(cfg)).host} asks two wallets to sign a Creator wallet handover:`,
    "",
    `Record: ${o.record}`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    "",
    `Once both wallets sign this message, ${o.to} is this Heat Creator record's Creator wallet, the only wallet that signs its launches, and ${o.from} no longer is.`,
    ...footer(cfg, o.nonce, o.issuedAt, o.expiresAt),
  ].join("\n");
}

export function rotationMessage(cfg: Config, o: { record: string; handle: string; from: string; to: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  return [
    `${new URL(webApp(cfg)).host} asks this wallet to sign a Creator wallet rotation through X:`,
    "",
    `Record: ${o.record}`,
    `X account: @${o.handle}`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    "",
    `${o.from} is lost. ${o.to} becomes this Heat Creator record's Creator wallet 7 days after Heat records this request, unless ${o.from} cancels it before then.`,
    ...footer(cfg, o.nonce, o.issuedAt, o.expiresAt),
  ].join("\n");
}

export function cancelMessage(cfg: Config, o: { record: string; change: string; kind: "handover" | "rotation"; from: string; to: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  return [
    `${new URL(webApp(cfg)).host} asks the Creator wallet to sign a cancellation:`,
    "",
    `Record: ${o.record}`,
    `Change: ${o.change}`,
    `Cancel the ${o.kind} of the Creator wallet ${o.from} to ${o.to}.`,
    ...footer(cfg, o.nonce, o.issuedAt, o.expiresAt),
  ].join("\n");
}

/** A line of a change message Heat wrote, which the caller has matched to the message Heat gave. */
const field = (message: string, name: string) => new RegExp(`\\n${name}: ([^\\n]+)(?:\\n|$)`).exec(message)?.[1] ?? null;

/** The record whose current Creator wallet `wallet` is. */
async function recordOfCurrent(db: DbOrTransaction, wallet: string) {
  const [row] = await db
    .select({ creatorId: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.wallet, wallet), isNull(creatorWallets.endedAt)));
  return row?.creatorId ?? null;
}

/** One change of a record's wallets at a time: the lock `recordForWallet` and a first launch take too. */
async function lockRecord(tx: DbOrTransaction, creatorId: string) {
  await tx.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId)).for("update");
}

/** A record's pending change, after letting a handover offer that lapsed untaken go. */
async function pendingChange(db: DbOrTransaction, creatorId: string, now = new Date()) {
  await db
    .update(walletChanges)
    .set({ status: "expired", endedAt: now })
    .where(and(eq(walletChanges.creatorId, creatorId), eq(walletChanges.status, "pending"), eq(walletChanges.kind, "handover"), lte(walletChanges.expiresAt, now)));
  const [row] = await db.select().from(walletChanges).where(and(eq(walletChanges.creatorId, creatorId), eq(walletChanges.status, "pending")));
  return row ?? null;
}

const pendingRefusal = (kind: "handover" | "rotation"): WalletChangeRefusal => ({
  error:
    kind === "rotation"
      ? "A rotation of this record's Creator wallet is waiting out its cooldown. Its Creator wallet can cancel it first."
      : "This record's Creator wallet has offered a handover not yet taken. It can cancel the offer first.",
  code: "pending",
});

const takenRefusal = (wallet: string): WalletChangeRefusal => ({
  error: `${short(wallet)} is another Creator record's Creator wallet. Choose a wallet that is none.`,
  code: "wallet_taken",
});

/** `POST /creators/handover/message`: the message the current Creator wallet signs to offer its record to another wallet. */
export async function handoverMessageRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const body = HandoverRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Say which Creator wallet hands over, and to which wallet.", code: "invalid" });
  const { from, to } = body.data;
  if (from === to) return refuse(c, 400, { error: "Hand over to another wallet: this one is the Creator wallet already.", code: "invalid" });
  const record = await recordOfCurrent(db, from);
  if (!record) return refuse(c, 403, { error: `${short(from)} is no Creator record's Creator wallet.`, code: "not_the_creator_wallet" });
  if (await recordOfCurrent(db, to)) return refuse(c, 409, takenRefusal(to));
  const pending = await pendingChange(db, record);
  if (pending) return refuse(c, 409, pendingRefusal(pending.kind));
  const nonce = messageNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + HANDOVER_OFFER_MS);
  const message = handoverMessage(cfg, { record, from, to, nonce, issuedAt, expiresAt });
  await giveMessage(db, { nonce, wallet: from, purpose: "handover", message, expiresAt: new Date(issuedAt.getTime() + SIGN_MS) });
  return c.json({ message, expiresAt: expiresAt.toISOString(), wallet: from } satisfies WalletChangeMessage);
}

/** `POST /creators/handover`: the old wallet's signature, which offers the record to the new wallet until the offer lapses. */
export async function offerHandover(c: Context<AppEnv>) {
  const { db } = c.var;
  const body = SignedWalletMessage.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Send the wallet, the message it signed and the signature.", code: "invalid" });
  const { wallet, message, signature } = body.data;
  const taken = await takeSignedMessage(db, "handover", wallet, message, signature);
  if (!taken.ok) return refuse(c, taken.code === "expired" ? 401 : 400, { error: taken.error, code: taken.code });
  const record = field(message, "Record")!;
  const to = field(message, "To")!;
  const expiresAt = new Date(field(message, "Expiration Time")!);
  const outcome = await db.transaction(async (tx) => {
    await lockRecord(tx, record);
    if ((await currentCreatorWallet(tx, record)) !== wallet) return { refusal: { error: `${short(wallet)} is no longer this record's Creator wallet.`, code: "not_the_creator_wallet" } as const };
    if (await recordOfCurrent(tx, to)) return { refusal: takenRefusal(to) };
    const pending = await pendingChange(tx, record);
    if (pending) return { refusal: pendingRefusal(pending.kind) };
    const [row] = await tx
      .insert(walletChanges)
      .values({ creatorId: record, kind: "handover", fromWallet: wallet, toWallet: to, message, fromSignature: taken.signature, expiresAt })
      .returning();
    return { change: row! };
  });
  if (outcome.refusal) return refuse(c, 409, outcome.refusal);
  return c.json(walletChangeView(outcome.change), 201);
}

/** `GET /creators/offers/:wallet`: the handovers offered to a wallet and not yet taken, each with the record it would join. */
export async function handoverOffers(c: Context<AppEnv>) {
  const { db } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return refuse(c, 400, { error: "That is not a Solana wallet address.", code: "invalid" });
  const rows = await db
    .select({ change: walletChanges, handle: creators.xHandle })
    .from(walletChanges)
    .innerJoin(creators, eq(creators.id, walletChanges.creatorId))
    .where(and(eq(walletChanges.toWallet, wallet), eq(walletChanges.kind, "handover"), eq(walletChanges.status, "pending"), sql`${walletChanges.expiresAt} > now()`));
  const body: HandoverOffers = {
    offers: rows.map((r) => ({
      change: walletChangeView(r.change),
      record: { id: r.change.creatorId, handle: r.handle, wallet: r.change.fromWallet } satisfies CreatorRef,
    })),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/** Ends a record's current Creator wallet and starts `wallet` in its place, for a completed change. */
async function switchWallet(tx: DbOrTransaction, change: typeof walletChanges.$inferSelect, signature: string, now: Date) {
  await tx.update(creatorWallets).set({ endedAt: now }).where(and(eq(creatorWallets.creatorId, change.creatorId), isNull(creatorWallets.endedAt)));
  await tx.insert(creatorWallets).values({
    creatorId: change.creatorId,
    wallet: change.toWallet,
    via: change.kind,
    proof: signature,
    proofMessage: change.message,
    changeId: change.id,
    startedAt: now,
  });
}

/** `POST /creators/changes/:id/accept`: the new wallet's signature over the handover's message, which completes it. */
export async function acceptHandover(c: Context<AppEnv>) {
  const { db } = c.var;
  const id = c.req.param("id")!;
  const body = HandoverAcceptance.safeParse(await c.req.json().catch(() => null));
  if (!UUID.test(id) || !body.success) return refuse(c, 400, { error: "Send the new wallet's signature over the handover's message.", code: "invalid" });
  const [change] = await db.select().from(walletChanges).where(eq(walletChanges.id, id));
  if (!change || change.kind !== "handover") return refuse(c, 404, { error: "Heat has no such handover.", code: "not_found" });
  const bytes = await signedBy(change.toWallet, change.message, body.data.signature);
  if (!bytes) return refuse(c, 400, { error: `The signature is not ${short(change.toWallet)}'s over the handover's message.`, code: "invalid" });
  const signature = getBase58Decoder().decode(bytes);
  const now = new Date();
  const outcome = await db
    .transaction(async (tx) => {
      await lockRecord(tx, change.creatorId);
      const pending = await pendingChange(tx, change.creatorId, now);
      if (!pending || pending.id !== change.id) return { refusal: { error: "This handover was cancelled, lapsed or completed already.", code: "expired" } as const, status: 409 as const };
      if ((await currentCreatorWallet(tx, change.creatorId)) !== change.fromWallet) {
        await tx.update(walletChanges).set({ status: "void", endedAt: now }).where(eq(walletChanges.id, change.id));
        return { refusal: { error: "The wallet that offered this handover is no longer the record's Creator wallet.", code: "expired" } as const, status: 409 as const };
      }
      if (await recordOfCurrent(tx, change.toWallet)) return { refusal: takenRefusal(change.toWallet), status: 409 as const };
      await switchWallet(tx, change, signature, now);
      const [done] = await tx.update(walletChanges).set({ status: "completed", toSignature: signature, endedAt: now }).where(eq(walletChanges.id, change.id)).returning();
      return { change: done! };
    })
    .catch((e: { code?: string; cause?: { code?: string } }) => {
      // The new wallet became another record's Creator wallet at the same moment.
      if ((e.cause?.code ?? e.code) === "23505") return { refusal: takenRefusal(change.toWallet), status: 409 as const };
      throw e;
    });
  if (outcome.refusal) return refuse(c, outcome.status ?? 409, outcome.refusal);
  return c.json(walletChangeView(outcome.change));
}

/** The signed-in record, when the browser authorized its X account at X recently enough to rotate through it. */
async function xRecentRecord(c: Context<AppEnv>, now = new Date()) {
  const session = await sessionCreator(c);
  if (!session) return { refusal: { error: "Sign in with the record's X account first.", code: "not_signed_in" } as const, status: 401 as const };
  if (!session.xUserId || !session.xHandle) {
    return { refusal: { error: "This record linked no X account, so a lost Creator wallet cannot rotate through X.", code: "no_x" } as const, status: 403 as const };
  }
  if (!session.xAt || now.getTime() - session.xAt.getTime() > X_RECENT_MS) {
    return { refusal: { error: `Sign in with @${session.xHandle} at X again: a rotation needs X's word from the last 15 minutes.`, code: "x_not_recent" } as const, status: 403 as const };
  }
  return { session };
}

/** `POST /creators/rotation/message`: the message the new wallet signs to rotate a lost Creator wallet through X. */
export async function rotationMessageRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const body = RotationRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Say which wallet becomes the Creator wallet.", code: "invalid" });
  const signedIn = await xRecentRecord(c);
  if (signedIn.refusal) return refuse(c, signedIn.status ?? 403, signedIn.refusal);
  const { session } = signedIn;
  const { to } = body.data;
  const from = await currentCreatorWallet(db, session.id);
  if (!from) return refuse(c, 409, { error: "This record has no Creator wallet yet: sign in with the new wallet from this browser and it becomes the record's.", code: "invalid" });
  if (from === to) return refuse(c, 400, { error: "That wallet is the record's Creator wallet already.", code: "invalid" });
  if (await recordOfCurrent(db, to)) return refuse(c, 409, takenRefusal(to));
  const pending = await pendingChange(db, session.id);
  if (pending) return refuse(c, 409, pendingRefusal(pending.kind));
  const nonce = messageNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + SIGN_MS);
  const message = rotationMessage(cfg, { record: session.id, handle: session.xHandle!, from, to, nonce, issuedAt, expiresAt });
  await giveMessage(db, { nonce, wallet: to, purpose: "rotation", message, expiresAt });
  return c.json({ message, expiresAt: expiresAt.toISOString(), wallet: to } satisfies WalletChangeMessage);
}

/** `POST /creators/rotation`: the new wallet's signature, which starts the rotation's public cooldown. */
export async function requestRotation(c: Context<AppEnv>) {
  const { db } = c.var;
  const body = SignedWalletMessage.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Send the wallet, the message it signed and the signature.", code: "invalid" });
  const signedIn = await xRecentRecord(c);
  if (signedIn.refusal) return refuse(c, signedIn.status ?? 403, signedIn.refusal);
  const { session } = signedIn;
  const { wallet, message, signature } = body.data;
  if (field(message, "Record") !== session.id) return refuse(c, 400, { error: "That rotation is another record's.", code: "invalid" });
  const taken = await takeSignedMessage(db, "rotation", wallet, message, signature);
  if (!taken.ok) return refuse(c, taken.code === "expired" ? 401 : 400, { error: taken.error, code: taken.code });
  const from = field(message, "From")!;
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    await lockRecord(tx, session.id);
    if ((await currentCreatorWallet(tx, session.id)) !== from) return { refusal: { error: "The record's Creator wallet changed meanwhile. Ask again.", code: "expired" } as const };
    if (await recordOfCurrent(tx, wallet)) return { refusal: takenRefusal(wallet) };
    const pending = await pendingChange(tx, session.id, now);
    if (pending) return { refusal: pendingRefusal(pending.kind) };
    const [row] = await tx
      .insert(walletChanges)
      .values({
        creatorId: session.id,
        kind: "rotation",
        fromWallet: from,
        toWallet: wallet,
        message,
        toSignature: taken.signature,
        xUserId: session.xUserId,
        xHandle: session.xHandle,
        requestedAt: now,
        effectiveAt: new Date(now.getTime() + ROTATION_COOLDOWN_MS),
      })
      .returning();
    return { change: row! };
  });
  if (outcome.refusal) return refuse(c, 409, outcome.refusal);
  return c.json(walletChangeView(outcome.change), 201);
}

/** `POST /creators/changes/:id/cancel/message`: the message the current Creator wallet signs to cancel a pending change. */
export async function cancelMessageRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const id = c.req.param("id")!;
  if (!UUID.test(id)) return refuse(c, 404, { error: "Heat has no such change.", code: "not_found" });
  const [change] = await db.select().from(walletChanges).where(eq(walletChanges.id, id));
  if (!change) return refuse(c, 404, { error: "Heat has no such change.", code: "not_found" });
  const pending = await pendingChange(db, change.creatorId);
  if (!pending || pending.id !== id) return refuse(c, 409, { error: "This change is no longer pending.", code: "expired" });
  const current = await currentCreatorWallet(db, change.creatorId);
  if (!current) return refuse(c, 409, { error: "This record has no Creator wallet to cancel it.", code: "not_the_creator_wallet" });
  const nonce = messageNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + SIGN_MS);
  const message = cancelMessage(cfg, { record: change.creatorId, change: id, kind: change.kind, from: change.fromWallet, to: change.toWallet, nonce, issuedAt, expiresAt });
  await giveMessage(db, { nonce, wallet: current, purpose: "cancel", message, expiresAt });
  return c.json({ message, expiresAt: expiresAt.toISOString(), wallet: current } satisfies WalletChangeMessage);
}

/** `POST /creators/changes/:id/cancel`: the current Creator wallet's signature, which cancels the change. */
export async function cancelChange(c: Context<AppEnv>) {
  const { db } = c.var;
  const id = c.req.param("id")!;
  const body = SignedWalletMessage.safeParse(await c.req.json().catch(() => null));
  if (!UUID.test(id) || !body.success) return refuse(c, 400, { error: "Send the wallet, the message it signed and the signature.", code: "invalid" });
  const { wallet, message, signature } = body.data;
  if (field(message, "Change") !== id) return refuse(c, 400, { error: "That cancellation is another change's.", code: "invalid" });
  const taken = await takeSignedMessage(db, "cancel", wallet, message, signature);
  if (!taken.ok) return refuse(c, taken.code === "expired" ? 401 : 400, { error: taken.error, code: taken.code });
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [change] = await tx.select().from(walletChanges).where(eq(walletChanges.id, id));
    if (!change) return { refusal: { error: "Heat has no such change.", code: "not_found" } as const };
    await lockRecord(tx, change.creatorId);
    const pending = await pendingChange(tx, change.creatorId, now);
    if (!pending || pending.id !== id) return { refusal: { error: "This change is no longer pending.", code: "expired" } as const };
    if ((await currentCreatorWallet(tx, change.creatorId)) !== wallet) return { refusal: { error: `${short(wallet)} is no longer this record's Creator wallet.`, code: "not_the_creator_wallet" } as const };
    const [done] = await tx
      .update(walletChanges)
      .set({ status: "cancelled", cancelMessage: message, cancelSignature: taken.signature, endedAt: now })
      .where(eq(walletChanges.id, id))
      .returning();
    return { change: done! };
  });
  if (outcome.refusal) return refuse(c, 409, outcome.refusal);
  return c.json(walletChangeView(outcome.change));
}

/**
 * Every rotation whose cooldown has ended by `now`, one record's or all, takes effect: the new wallet becomes the
 * record's Creator wallet, unless it became another record's first, which voids the rotation. Run by the cron, and
 * before a record is read.
 */
export async function completeRotations(db: Db, now = new Date(), creatorId?: string) {
  const due = await db
    .select()
    .from(walletChanges)
    .where(
      and(
        eq(walletChanges.kind, "rotation"),
        eq(walletChanges.status, "pending"),
        lte(walletChanges.effectiveAt, now),
        creatorId ? eq(walletChanges.creatorId, creatorId) : undefined,
      ),
    );
  let completed = 0;
  let voided = 0;
  for (const change of due) {
    const outcome = await db
      .transaction(async (tx) => {
        await lockRecord(tx, change.creatorId);
        const [still] = await tx.select({ status: walletChanges.status }).from(walletChanges).where(eq(walletChanges.id, change.id));
        if (still?.status !== "pending") return "gone";
        if (await recordOfCurrent(tx, change.toWallet)) {
          await tx.update(walletChanges).set({ status: "void", endedAt: now }).where(eq(walletChanges.id, change.id));
          return "void";
        }
        await switchWallet(tx, change, change.toSignature!, now);
        await tx.update(walletChanges).set({ status: "completed", endedAt: now }).where(eq(walletChanges.id, change.id));
        return "completed";
      })
      .catch((e: { code?: string; cause?: { code?: string } }) => {
        if ((e.cause?.code ?? e.code) === "23505") return "raced";
        throw e;
      });
    if (outcome === "completed") completed++;
    if (outcome === "void") voided++;
  }
  return { completed, voided };
}
