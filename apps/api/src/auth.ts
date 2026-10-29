// Linking X (spec 2.1 step 1, 7): every launch needs an X account, which the Creator record belongs to. OAuth 2.0's
// authorization code flow with PKCE against the X app, as a confidential client. The browser carries a state that must
// come back both in X's redirect and in a cookie set when it left, so nobody can link someone else's browser to their own
// X account. Linking reads the account once (`GET /2/users/me`), revokes X's token, and starts a session: a random token
// in an HttpOnly cookie, of which only the SHA-256 is stored.
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { creators, creatorWallets, launches, sessions, xAuthorizations, type DbOrTransaction } from "@top-pad/db";
import type { Me } from "@top-pad/contract";
import { webApp, type Config, type XConfig } from "./env";
import type { AppEnv } from "./http";

export const SESSION_COOKIE = "heat_session";
const STATE_COOKIE = "heat_x_state";
const SESSION_SECONDS = 30 * 24 * 3600;
const AUTHORIZATION_SECONDS = 10 * 60;
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
  const back = (returnTo: string, outcome: "linked" | "denied" | "failed") => {
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

  const [creator] = await db
    .insert(creators)
    .values({ xUserId: user.id, xHandle: user.username, xName: user.name, xAvatarUrl: user.profile_image_url ?? null })
    .onConflictDoUpdate({
      target: creators.xUserId,
      set: { xHandle: user.username, xName: user.name, xAvatarUrl: user.profile_image_url ?? null, updatedAt: sql`now()` },
    })
    .returning({ id: creators.id });
  const token = randomToken();
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(token),
    creatorId: creator!.id,
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  setCookie(c, SESSION_COOKIE, token, cookieOptions(cfg, "/", SESSION_SECONDS));
  return back(authorization.returnTo, "linked");
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

/** The Creator a request's session belongs to, or null when it has none or it has expired. */
export async function sessionCreator(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await c.var.db
    .select({ id: creators.id, xHandle: creators.xHandle, xName: creators.xName, xAvatarUrl: creators.xAvatarUrl })
    .from(sessions)
    .innerJoin(creators, eq(creators.id, sessions.creatorId))
    .where(and(eq(sessions.tokenHash, await sha256Hex(token)), gt(sessions.expiresAt, sql`now()`)));
  return row ?? null;
}

export type SessionCreator = NonNullable<Awaited<ReturnType<typeof sessionCreator>>>;

/** A record's current Creator wallet, or null before its first launch. */
export async function currentCreatorWallet(db: DbOrTransaction, creatorId: string) {
  const [row] = await db
    .select({ wallet: creatorWallets.wallet })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.creatorId, creatorId), sql`${creatorWallets.endedAt} is null`));
  return row?.wallet ?? null;
}

/** `GET /me`. */
export async function me(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return c.json(null);
  const [{ count } = { count: 0 }] = await c.var.db
    .select({ count: sql<number>`count(*)::int` })
    .from(launches)
    .where(and(eq(launches.creatorId, creator.id), eq(launches.status, "landed")));
  const body: Me = {
    x: { handle: creator.xHandle, name: creator.xName, avatarUrl: creator.xAvatarUrl },
    creatorWallet: await currentCreatorWallet(c.var.db, creator.id),
    launches: count,
  };
  return c.json(body);
}

/** `POST /auth/logout`: ends this browser's session. */
export async function logout(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.var.db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.var.cfg.secureCookies });
  return c.body(null, 204);
}
