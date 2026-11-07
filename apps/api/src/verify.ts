// "Verify once" (spec 6.3): a person links X once (`auth.ts`), and each wallet of theirs proves it is theirs by signing a
// message that names that X account, the session's own. The wallet is then Scored in every Fair Open, signed in or not,
// and shares the person's one seat with their other wallets (`admission.ts`). The message carries the wallet, the person,
// the cluster and when it was issued, and is taken for ten minutes, so a signature cannot be replayed for anyone else.
// A wallet belongs to one person: one verified for another X account, or another record's Creator wallet, is refused.
import { getBase64Encoder, getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from "@solana/kit";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { VerifyRequest, VerifySigned, type VerifiedWallet, type VerifyMessage, type VerifyRefusal } from "@top-pad/contract";
import { creatorWallets, walletVerifications } from "@top-pad/db";
import { rpcFundingSource, traceFunding } from "@top-pad/indexer";
import { linkageOf } from "./admission";
import { sessionCreator } from "./auth";
import type { AppEnv } from "./http";

/** How long a message may wait for its wallet's signature. */
const MESSAGE_MS = 10 * 60_000;
/** How far ahead of Heat's clock a message's time may be: a few seconds of drift between Workers. */
const SKEW_MS = 60_000;

const refuse = (c: Context<AppEnv>, status: 400 | 401 | 409, body: VerifyRefusal) => c.json(body, status);

/** The message a wallet signs to be verified for the person: each line a field the server checks again. */
export function verifyMessage(o: { wallet: string; handle: string; person: string; cluster: string; issued: Date }) {
  return [
    "Heat: verify this wallet once.",
    "",
    `Wallet: ${o.wallet}`,
    `X account: @${o.handle}`,
    `Person: ${o.person}`,
    `Network: ${o.cluster}`,
    `Issued: ${o.issued.toISOString()}`,
    "",
    "Signing sends no transaction and costs nothing.",
  ].join("\n");
}

/** A message's fields, if it is one `verifyMessage` wrote. */
function fieldsOf(message: string) {
  const m =
    /^Heat: verify this wallet once\.\n\nWallet: (\S+)\nX account: @(\S+)\nPerson: (\S+)\nNetwork: (\S+)\nIssued: (\S+)\n\nSigning sends no transaction and costs nothing\.$/.exec(
      message,
    );
  if (!m) return null;
  const issued = new Date(m[5]!);
  return Number.isNaN(issued.getTime()) ? null : { wallet: m[1]!, handle: m[2]!, person: m[3]!, cluster: m[4]!, issued };
}

const signedOut = (c: Context<AppEnv>) => refuse(c, 401, { error: "Link X first: a wallet is verified for the X account linked in this browser.", code: "signed_out" });

/** `POST /verify/message`: the message the signed-in person's wallet signs. */
export async function verifyMessageRoute(c: Context<AppEnv>) {
  const body = VerifyRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Say which wallet to verify.", code: "invalid" });
  const session = await sessionCreator(c);
  if (!session) return signedOut(c);
  const message = verifyMessage({ wallet: body.data.wallet, handle: session.xHandle, person: session.id, cluster: c.var.cfg.cluster, issued: new Date() });
  return c.json({ message } satisfies VerifyMessage);
}

/** `POST /verify`: the signed message. Verifies the wallet for the session's X account, once and for every Fair Open. */
export async function verifyRoute(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const body = VerifySigned.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Send the wallet, the message it signed and the signature.", code: "invalid" });
  const session = await sessionCreator(c);
  if (!session) return signedOut(c);
  const { wallet, message, signature } = body.data;
  const fields = fieldsOf(message);
  const age = fields ? Date.now() - fields.issued.getTime() : NaN;
  if (!fields || fields.wallet !== wallet || fields.person !== session.id || fields.handle !== session.xHandle || fields.cluster !== cfg.cluster || !(age <= MESSAGE_MS && age >= -SKEW_MS)) {
    return refuse(c, 400, { error: "That is not a message Heat gave this wallet in the last ten minutes. Start again.", code: "invalid" });
  }
  const signed = await (async () => {
    const bytes = getBase64Encoder().encode(signature);
    if (bytes.length !== 64) return false;
    return verifySignature(await getPublicKeyFromAddress(wallet as Address), bytes as SignatureBytes, new TextEncoder().encode(message));
  })().catch(() => false);
  if (!signed) return refuse(c, 400, { error: "The signature is not this wallet's over that message.", code: "invalid" });

  const [record] = await db
    .select({ creatorId: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.wallet, wallet), sql`${creatorWallets.endedAt} is null`));
  const [existing] = await db.select().from(walletVerifications).where(eq(walletVerifications.wallet, wallet));
  if ((record && record.creatorId !== session.id) || (existing && existing.creatorId !== session.id)) {
    return refuse(c, 409, { error: "This wallet is already verified for another X account: a wallet belongs to one person.", code: "taken" });
  }
  if (!existing) {
    // Where its SOL came from, so wallets funded from there join the person too; a wallet whose funding cannot be read
    // now is verified all the same, with no root.
    let root: string | null = null;
    if (cfg.heat) {
      root = await linkageOf(db, cfg.heat, rpcFundingSource(cfg.rpcUrl))
        .then((linkage) => traceFunding(db, linkage.source, wallet, linkage.hubs))
        .then((trace) => trace.root)
        .catch((e) => {
          console.warn(`reading ${wallet}'s funding at verification failed`, e);
          return null;
        });
    }
    await db.insert(walletVerifications).values({ wallet, creatorId: session.id, method: "x", message, signature, root }).onConflictDoNothing();
    // Two people verifying one wallet at once: the first to land has it.
    const [kept] = await db.select({ creatorId: walletVerifications.creatorId }).from(walletVerifications).where(eq(walletVerifications.wallet, wallet));
    if (kept?.creatorId !== session.id) return refuse(c, 409, { error: "This wallet is already verified for another X account: a wallet belongs to one person.", code: "taken" });
  }
  return c.json({ wallet, tier: "scored", handle: session.xHandle } satisfies VerifiedWallet);
}
