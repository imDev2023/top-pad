// Signing in (spec 2.1 step 1, 7, ADR 0008). Anyone launches with a wallet: it signs a Sign In With Solana message naming
// Heat's site, the wallet, a nonce and an expiry, which the API takes once, and the Creator record is the one whose
// Creator wallet it is, or a new one. Linking X is optional: it shows on the record and in its coins' metadata, raises the
// record's wallets to Scored (spec 6.3), and still signs a browser in on its own, as it did before X became optional.
//
// Linking X is OAuth 2.0's authorization code flow with PKCE against the X app, as a confidential client. The browser
// carries a state that must come back both in X's redirect and in a cookie set when it left, so nobody can link someone
// else's browser to their own X account. Linking reads the account once (`GET /2/users/me`) and revokes X's token. A
// browser signed in already links the account to its record; one signed out is signed in as the account's record.
//
// Either way the session is a random token in an HttpOnly cookie, of which only the SHA-256 is stored.
import { getBase58Decoder, getBase64Encoder, getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from "@solana/kit";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WalletSignInRequest, WalletSignInSigned, type Me, type WalletSignInMessage, type WalletSignInRefusal } from "@top-pad/contract";
import { creators, creatorWallets, launches, sessions, walletSignIns, walletVerifications, xAuthorizations, type Db, type DbOrTransaction } from "@top-pad/db";
import { webApp, type Config, type XConfig } from "./env";
import type { AppEnv } from "./http";

export const SESSION_COOKIE = "heat_session";
const STATE_COOKIE = "heat_x_state";
const SESSION_SECONDS = 30 * 24 * 3600;
const AUTHORIZATION_SECONDS = 10 * 60;
/** How long a wallet's sign-in message may wait for its signature. */
export const SIGN_IN_SECONDS = 10 * 60;
/** `users.read` reads the account; X requires `tweet.read` alongside it. */
const SCOPES = "tweet.read users.read";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256Hex(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
const challengeOf = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

/** A path on the web app to return to: relative, same-site, and the launch flow when there is none. */
export function returnPath(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/launch";
  return value;
}

const cookieOptions = (cfg: Config, path: string, maxAge: number) =>
  ({ httpOnly: true, secure: cfg.secureCookies, sameSite: "Lax", path, maxAge }) as const;

/** `GET /auth/x/start?return=<path>`: sends the browser to X to authorize the app. */
export async function startXLink(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  if (!cfg.x) return c.json({ error: "Linking X is not set up on this deployment yet." }, 503);
  const state = randomToken();
  const codeVerifier = randomToken();
  await db.delete(xAuthorizations).where(lt(xAuthorizations.expiresAt, sql`now()`));
  await db.insert(xAuthorizations).values({
    state,
    codeVerifier,
    returnTo: returnPath(c.req.query("return")),
    expiresAt: new Date(Date.now() + AUTHORIZATION_SECONDS * 1000),
  });
  setCookie(c, STATE_COOKIE, state, cookieOptions(cfg, "/auth/x", AUTHORIZATION_SECONDS));
  const url = new URL(cfg.x.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.x.clientId,
    redirect_uri: cfg.x.callbackUrl,
    scope: SCOPES,
    state,
    code_challenge: await challengeOf(codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString(), 302);
}

type XUser = { id: string; name: string; username: string; profile_image_url?: string };

/** `GET /auth/x/callback`: X's redirect back. Links the account and starts the browser's session. */
export async function finishXLink(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const back = (returnTo: string, outcome: "linked" | "denied" | "failed" | "taken") => {
    deleteCookie(c, STATE_COOKIE, { path: "/auth/x", secure: cfg.secureCookies });
    const url = new URL(returnTo, webApp(cfg));
    url.searchParams.set("x", outcome);
    return c.redirect(url.toString(), 302);
  };
  const state = c.req.query("state");
  const cookieState = getCookie(c, STATE_COOKIE);
  if (!cfg.x || !state || !cookieState || state !== cookieState) return back("/launch", "failed");
  const [authorization] = await db.delete(xAuthorizations).where(eq(xAuthorizations.state, state)).returning();
  if (!authorization || authorization.expiresAt.getTime() < Date.now()) return back("/launch", "failed");
  if (c.req.query("error")) return back(authorization.returnTo, "denied");
  const code = c.req.query("code");
  if (!code) return back(authorization.returnTo, "failed");

  let user: XUser;
  try {
    const token = await exchangeCode(cfg.x, code, authorization.codeVerifier);
    user = await readUser(cfg.x, token);
    c.executionCtx.waitUntil(revoke(cfg.x, token).catch((e) => console.error("revoking X's token failed", e)));
  } catch (e) {
    console.error("linking X failed", e);
    return back(authorization.returnTo, "failed");
  }

  const signedIn = await sessionCreator(c);
  if (signedIn) {
    // Linked to the browser's own record: an X account belongs to one record, and a record has one X account.
    const [owner] = await db.select({ id: creators.id }).from(creators).where(eq(creators.xUserId, user.id));
    if ((owner && owner.id !== signedIn.id) || (signedIn.xUserId && signedIn.xUserId !== user.id)) return back(authorization.returnTo, "taken");
    const linked = await db
      .update(creators)
      .set({ xUserId: user.id, xHandle: user.username, xName: user.name, xAvatarUrl: user.profile_image_url ?? null, updatedAt: sql`now()` })
      .where(eq(creators.id, signedIn.id))
      .returning({ id: creators.id })
      .catch((e: { code?: string; cause?: { code?: string } }) => {
        // Linked to another record at the same moment.
        if ((e.cause?.code ?? e.code) === "23505") return [];
        throw e;
      });
    // The browser has just authorized its record's X account: a rotation through X may follow (spec 7).
    if (linked.length > 0) await db.update(sessions).set({ xAt: sql`now()` }).where(eq(sessions.tokenHash, signedIn.tokenHash));
    return back(authorization.returnTo, linked.length > 0 ? "linked" : "taken");
  }

  const [creator] = await db
    .insert(creators)
    .values({ xUserId: user.id, xHandle: user.username, xName: user.name, xAvatarUrl: user.profile_image_url ?? null })
    .onConflictDoUpdate({
      target: creators.xUserId,
      set: { xHandle: user.username, xName: user.name, xAvatarUrl: user.profile_image_url ?? null, updatedAt: sql`now()` },
    })
    .returning({ id: creators.id });
  await startSession(c, creator!.id, null, new Date());
  return back(authorization.returnTo, "linked");
}

/** Signs the browser in as a record, replacing any session it had. */
async function startSession(c: Context<AppEnv>, creatorId: string, wallet: string | null, xAt: Date | null = null) {
  const { cfg, db } = c.var;
  const previous = getCookie(c, SESSION_COOKIE);
  if (previous) await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(previous)));
  const token = randomToken();
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(token),
    creatorId,
    wallet,
    xAt,
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  setCookie(c, SESSION_COOKIE, token, cookieOptions(cfg, "/", SESSION_SECONDS));
}

/**
 * The Sign In With Solana message (CAIP-122, as Phantom and Solflare read it) for `wallet` to sign in to Heat's site: the
 * domain and URI are the web app's, so a wallet can warn when another site asks for it.
 */
export function signInMessage(o: { webApp: string; wallet: string; cluster: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  const site = new URL(o.webApp);
  return [
    `${site.host} wants you to sign in with your Solana account:`,
    o.wallet,
    "",
    "Sign in to Heat. Signing sends no transaction and costs nothing.",
    "",
    `URI: ${site.origin}`,
    "Version: 1",
    `Chain ID: ${o.cluster}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${o.issuedAt.toISOString()}`,
    `Expiration Time: ${o.expiresAt.toISOString()}`,
  ].join("\n");
}

const signInRefusal = (c: Context<AppEnv>, status: 400 | 401, body: WalletSignInRefusal) => c.json(body, status);

/** A purpose Heat gives a wallet a message to sign for: each message is taken only for its own. */
export type MessagePurpose = (typeof walletSignIns.$inferSelect)["purpose"];

/** A fresh nonce for a message: 32 hex characters, as `takeSignedMessage` finds it. */
export const messageNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Keeps a message Heat gives a wallet to sign, taken once for `purpose` before `expiresAt`. */
export async function giveMessage(db: Db, o: { nonce: string; wallet: string; purpose: MessagePurpose; message: string; expiresAt: Date }) {
  await db.delete(walletSignIns).where(lt(walletSignIns.expiresAt, sql`now()`));
  await db.insert(walletSignIns).values(o);
}

/** Whether `signature`, base64, is `wallet`'s ed25519 signature over `message`. */
export async function signedBy(wallet: string, message: string, signature: string): Promise<Uint8Array | null> {
  let bytes: Uint8Array;
  try {
    bytes = getBase64Encoder().encode(signature) as Uint8Array;
  } catch {
    return null;
  }
  const ok =
    bytes.length === 64 &&
    (await verifySignature(await getPublicKeyFromAddress(wallet as Address), bytes as SignatureBytes, new TextEncoder().encode(message)).catch(() => false));
  return ok ? bytes : null;
}

export type Taken = { ok: true; signature: string } | { ok: false; code: "expired" | "invalid"; error: string };

/**
 * Takes a message Heat gave `wallet` for `purpose`, signed: once, before it expires. A replayed or expired message, or one
 * given for another purpose, is `expired`; one edited, given to another wallet, or a signature not the wallet's is
 * `invalid`, and none of those uses the message up. The signature comes back base58, as a record keeps it.
 */
export async function takeSignedMessage(db: Db, purpose: MessagePurpose, wallet: string, message: string, signature: string): Promise<Taken> {
  const expired = { ok: false, code: "expired", error: "This message was used already or has expired. Ask for a new one." } as const;
  const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(message)?.[1];
  const [given] = nonce ? await db.select().from(walletSignIns).where(eq(walletSignIns.nonce, nonce)) : [];
  if (!given || given.purpose !== purpose) return expired;
  if (given.wallet !== wallet || given.message !== message) return { ok: false, code: "invalid", error: "That is not the message Heat gave this wallet. Ask for a new one." };
  const bytes = await signedBy(wallet, message, signature);
  if (!bytes) return { ok: false, code: "invalid", error: "The signature is not this wallet's over that message." };
  // Taken once: of two requests racing with one message, only the first deletes it.
  const [taken] = await db.delete(walletSignIns).where(eq(walletSignIns.nonce, given.nonce)).returning();
  if (!taken || taken.expiresAt.getTime() < Date.now()) return expired;
  return { ok: true, signature: getBase58Decoder().decode(bytes) };
}

/** `POST /auth/wallet/message`: the message a wallet signs to sign in, taken once within ten minutes. */
export async function walletSignInMessage(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const body = WalletSignInRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return signInRefusal(c, 400, { error: "Say which wallet signs in.", code: "invalid" });
  const nonce = messageNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + SIGN_IN_SECONDS * 1000);
  const message = signInMessage({ webApp: webApp(cfg), wallet: body.data.wallet, cluster: cfg.cluster, nonce, issuedAt, expiresAt });
  await giveMessage(db, { nonce, wallet: body.data.wallet, purpose: "sign_in", message, expiresAt });
  return c.json({ message, expiresAt: expiresAt.toISOString() } satisfies WalletSignInMessage);
}

/**
 * `POST /auth/wallet`: the signed message. Takes its nonce, once, and signs the browser in as the record whose Creator
 * wallet the wallet is; else as the browser's own record, or the one the wallet was verified for (spec 6.3), when that
 * record has no Creator wallet yet, the wallet becoming it; else as a new record, the wallet its Creator wallet.
 */
export async function walletSignIn(c: Context<AppEnv>) {
  const { db } = c.var;
  const body = WalletSignInSigned.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return signInRefusal(c, 400, { error: "Send the wallet, the message it signed and the signature.", code: "invalid" });
  const { wallet, message, signature } = body.data;
  const taken = await takeSignedMessage(db, "sign_in", wallet, message, signature);
  if (!taken.ok) {
    return taken.code === "expired"
      ? signInRefusal(c, 401, { error: "This sign-in was used already or has expired. Sign in again.", code: "expired" })
      : signInRefusal(c, 400, { error: taken.error.replace("Ask for a new one.", "Sign in again."), code: "invalid" });
  }

  const browser = await sessionCreator(c);
  const creatorId = await recordForWallet(db, wallet, { proof: taken.signature, proofMessage: message }, browser?.id ?? null);
  await startSession(c, creatorId, wallet);
  return c.json(await meOf(db, creatorId, wallet));
}

/** The record a wallet signs in as, binding the wallet as a record's Creator wallet when it is none yet. */
export async function recordForWallet(db: Db, wallet: string, proof: { proof: string; proofMessage: string }, browserCreatorId: string | null): Promise<string> {
  return db.transaction(async (tx) => {
    // One sign-in at a time per wallet, so two cannot make two records for it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sign-in:${wallet}`}))`);
    const [current] = await tx
      .select({ creatorId: creatorWallets.creatorId })
      .from(creatorWallets)
      .where(and(eq(creatorWallets.wallet, wallet), isNull(creatorWallets.endedAt)));
    if (current) return current.creatorId;
    const [verified] = await tx.select({ creatorId: walletVerifications.creatorId }).from(walletVerifications).where(eq(walletVerifications.wallet, wallet));
    for (const candidate of [browserCreatorId, verified?.creatorId ?? null]) {
      if (!candidate) continue;
      // Locked as `bindCreatorWallet` locks it, so a first launch cannot bind another wallet meanwhile.
      await tx.select({ id: creators.id }).from(creators).where(eq(creators.id, candidate)).for("update");
      if (await currentCreatorWallet(tx, candidate)) continue;
      await tx.insert(creatorWallets).values({ creatorId: candidate, wallet, via: "sign_in", ...proof });
      return candidate;
    }
    const [record] = await tx.insert(creators).values({}).returning({ id: creators.id });
    await tx.insert(creatorWallets).values({ creatorId: record!.id, wallet, via: "sign_in", ...proof });
    return record!.id;
  });
}

const basicAuth = (x: XConfig) => `Basic ${btoa(`${encodeURIComponent(x.clientId)}:${encodeURIComponent(x.clientSecret)}`)}`;

async function exchangeCode(x: XConfig, code: string, codeVerifier: string): Promise<string> {
  const res = await fetch(`${x.apiUrl}/2/oauth2/token`, {
    method: "POST",
    headers: { authorization: basicAuth(x), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: x.callbackUrl, code_verifier: codeVerifier, client_id: x.clientId }),
  });
  if (!res.ok) throw new Error(`X's token endpoint answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("X's token endpoint returned no access token");
  return body.access_token;
}

async function readUser(x: XConfig, token: string): Promise<XUser> {
  const res = await fetch(`${x.apiUrl}/2/users/me?user.fields=profile_image_url`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`X's users/me answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { data?: XUser };
  if (!body.data?.id || !body.data.username) throw new Error("X's users/me returned no user");
  return body.data;
}

async function revoke(x: XConfig, token: string) {
  await fetch(`${x.apiUrl}/2/oauth2/revoke`, {
    method: "POST",
    headers: { authorization: basicAuth(x), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "access_token", client_id: x.clientId }),
  });
}

/** The Creator a request's session belongs to, with the wallet it signed in with, or null when it has none or it has expired. */
export async function sessionCreator(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await c.var.db
    .select({
      id: creators.id,
      xUserId: creators.xUserId,
      xHandle: creators.xHandle,
      xName: creators.xName,
      xAvatarUrl: creators.xAvatarUrl,
      wallet: sessions.wallet,
      xAt: sessions.xAt,
      tokenHash: sessions.tokenHash,
    })
    .from(sessions)
    .innerJoin(creators, eq(creators.id, sessions.creatorId))
    .where(and(eq(sessions.tokenHash, await sha256Hex(token)), gt(sessions.expiresAt, sql`now()`)));
  return row ?? null;
}

export type SessionCreator = NonNullable<Awaited<ReturnType<typeof sessionCreator>>>;

/** A record's current Creator wallet, or null before a wallet signs in for it or its first launch. */
export async function currentCreatorWallet(db: DbOrTransaction, creatorId: string) {
  const [row] = await db
    .select({ wallet: creatorWallets.wallet })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.creatorId, creatorId), sql`${creatorWallets.endedAt} is null`));
  return row?.wallet ?? null;
}

async function meOf(db: DbOrTransaction, creatorId: string, wallet: string | null): Promise<Me> {
  const [creator] = await db
    .select({ xHandle: creators.xHandle, xName: creators.xName, xAvatarUrl: creators.xAvatarUrl })
    .from(creators)
    .where(eq(creators.id, creatorId));
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(launches)
    .where(and(eq(launches.creatorId, creatorId), eq(launches.status, "landed")));
  return {
    x: creator?.xHandle && creator.xName ? { handle: creator.xHandle, name: creator.xName, avatarUrl: creator.xAvatarUrl } : null,
    wallet,
    creatorWallet: await currentCreatorWallet(db, creatorId),
    launches: count,
  };
}

/** `GET /me`. */
export async function me(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return c.json(null);
  return c.json(await meOf(c.var.db, creator.id, creator.wallet));
}

/** `POST /auth/logout`: ends this browser's session. */
export async function logout(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.var.db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.var.cfg.secureCookies });
  return c.body(null, 204);
}
