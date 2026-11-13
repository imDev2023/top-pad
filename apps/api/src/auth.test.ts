import { generateKeyPairSigner, getBase58Encoder, getPublicKeyFromAddress, signBytes, verifySignature, type Address, type KeyPairSigner, type SignatureBytes } from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Me, WalletSignInMessage, WalletSignInRefusal } from "@top-pad/contract";
import { createDb, creators, creatorWallets, walletSignIns, walletVerifications, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import { Fakes, ORIGINS, testBindings, testContext } from "./test/fakes";

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
});
afterAll(async () => {
  await closeDb();
  await drop();
});

let fakes: Fakes;
beforeEach(() => {
  fakes = new Fakes();
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const request = (path: string, init: RequestInit = {}) => app.request(path, init, testBindings(url), ctx);

/** The cookies a response sets, by name, with their attributes. */
function setCookies(res: Response) {
  return new Map(res.headers.getSetCookie().map((c) => [c.split("=")[0]!, c]));
}
const cookieValue = (setCookie: string | undefined) => setCookie?.split(";")[0]!.split("=").slice(1).join("=");

async function startLink(returnTo = "/launch") {
  const res = await request(`/auth/x/start?return=${encodeURIComponent(returnTo)}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  return { location, state: location.searchParams.get("state")!, stateCookie: cookieValue(setCookies(res).get("heat_x_state")) };
}

async function link(session?: string) {
  const { state } = await startLink();
  const cookie = [`heat_x_state=${state}`, ...(session ? [`heat_session=${session}`] : [])].join("; ");
  const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie } });
  return { res, session: cookieValue(setCookies(res).get("heat_session")) };
}

const post = (path: string, body: unknown, session?: string) =>
  request(path, {
    method: "POST",
    headers: { origin: ORIGINS.web, "content-type": "application/json", ...(session ? { cookie: `heat_session=${session}` } : {}) },
    body: JSON.stringify(body),
  });
const sign = async (signer: KeyPairSigner, text: string) => Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(text))).toString("base64");

/** Asks for the sign-in message for `signer`. */
async function askSignIn(signer: KeyPairSigner) {
  const res = await post("/auth/wallet/message", { wallet: signer.address });
  expect(res.status, await res.clone().text()).toBe(200);
  return WalletSignInMessage.parse(await res.json());
}

/** Signs `signer` in, in a browser holding `session` if given; the answer, and the session the browser holds after. */
async function signIn(signer: KeyPairSigner, session?: string) {
  const { message } = await askSignIn(signer);
  const res = await post("/auth/wallet", { wallet: signer.address, message, signature: await sign(signer, message) }, session);
  return { res, message, session: cookieValue(setCookies(res).get("heat_session")) };
}

const meOf = async (session: string | undefined) => Me.nullable().parse(await (await request("/me", { headers: session ? { cookie: `heat_session=${session}` } : {} })).json());

describe("linking X", () => {
  it("sends the browser to X with PKCE and a state bound to a cookie", async () => {
    const { location, state, stateCookie } = await startLink();
    expect(`${location.origin}${location.pathname}`).toBe(`${ORIGINS.x}/i/oauth2/authorize`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-id",
      redirect_uri: `${ORIGINS.api}/auth/x/callback`,
      scope: "tweet.read users.read",
      code_challenge_method: "S256",
    });
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(stateCookie).toBe(state);
  });

  it("links the account, starts a session and sends the browser back to the launch flow", async () => {
    const { location, state } = await startLink("/launch");
    const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=linked`);
    const session = setCookies(res).get("heat_session")!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);

    // The code is exchanged as a confidential client, with the verifier whose challenge went to X.
    const sent = fakes.tokenRequests[0]!;
    expect(Object.fromEntries(sent)).toMatchObject({ grant_type: "authorization_code", code: "the-code", redirect_uri: `${ORIGINS.api}/auth/x/callback` });
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent.get("code_verifier")!)))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(location.searchParams.get("code_challenge"));
    expect(fakes.tokenAuthorizations[0]).toBe(`Basic ${btoa("client-id:client-secret")}`);

    // X's token is revoked once the account is read: nothing is kept.
    await settle();
    expect(fakes.revoked).toEqual(["x-access-token"]);

    const me = await request("/me", { headers: { cookie: `heat_session=${cookieValue(session)}` } });
    expect(me.status).toBe(200);
    expect(Me.parse(await me.json())).toEqual({
      x: { handle: "lumen_lab", name: "Lumen Lab", avatarUrl: "https://pbs.twimg.com/lumen.png" },
      wallet: null,
      creatorWallet: null,
      launches: 0,
    });
  });

  it("keeps one record per X account, following a handle change", async () => {
    await link();
    fakes.xUser = { ...fakes.xUser, username: "lumen_renamed" };
    const { session } = await link();
    const rows = await db.select().from(creators);
    expect(rows.filter((r) => r.xUserId === "1001")).toHaveLength(1);
    const me = Me.parse(await (await request("/me", { headers: { cookie: `heat_session=${session}` } })).json());
    expect(me.x?.handle).toBe("lumen_renamed");
  });

  it("refuses a callback whose state did not leave from this browser", async () => {
    const { state } = await startLink();
    const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: "heat_x_state=someone-elses" } });
    expect(res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=failed`);
    expect(setCookies(res).get("heat_session")).toBeUndefined();
    expect(fakes.tokenRequests).toHaveLength(0);
  });

  it("uses a state once", async () => {
    const { state } = await startLink();
    const headers = { cookie: `heat_x_state=${state}` };
    await request(`/auth/x/callback?state=${state}&code=the-code`, { headers });
    const replay = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers });
    expect(replay.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=failed`);
    expect(fakes.tokenRequests).toHaveLength(1);
  });

  it("returns a creator who declined at X to the launch flow, unlinked", async () => {
    const { state } = await startLink();
    const res = await request(`/auth/x/callback?state=${state}&error=access_denied`, { headers: { cookie: `heat_x_state=${state}` } });
    expect(res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=denied`);
    expect(setCookies(res).get("heat_session")).toBeUndefined();
  });

  it("returns only to paths on the web app", async () => {
    for (const evil of ["//evil.example/launch", "https://evil.example", "\\\\evil.example"]) {
      const { state } = await startLink(evil);
      const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}` } });
      expect(new URL(res.headers.get("location")!).origin).toBe(ORIGINS.web);
    }
  });

  it("answers /me with null for a browser that has not linked X", async () => {
    for (const res of [await request("/me"), await request("/me", { headers: { cookie: "heat_session=made-up" } })]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    }
  });

  it("signs out on a request from the web app, and only from there", async () => {
    const { session } = await link();
    const cookie = `heat_session=${session}`;
    expect((await request("/auth/logout", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await request("/auth/logout", { method: "POST", headers: { cookie, origin: "http://elsewhere.test" } })).status).toBe(403);
    expect((await request("/auth/logout", { method: "POST", headers: { cookie, origin: ORIGINS.web } })).status).toBe(204);
    expect(await (await request("/me", { headers: { cookie } })).json()).toBeNull();
  });

  it("says linking is off when the X app is not configured", async () => {
    const res = await app.request("/auth/x/start", {}, testBindings(url, { X_CLIENT_ID: undefined }), ctx);
    expect(res.status).toBe(503);
  });

  it("lets the web app call with its cookie from the browser", async () => {
    const res = await request("/me", { headers: { origin: ORIGINS.web } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGINS.web);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("signing in with a wallet", () => {
  it("gives a Sign In With Solana message naming the web app, the wallet, a nonce and an expiry", async () => {
    const signer = await generateKeyPairSigner();
    const before = Date.now();
    const { message, expiresAt } = await askSignIn(signer);
    const lines = message.split("\n");
    expect(lines.slice(0, 7)).toEqual([
      `${new URL(ORIGINS.web).host} wants you to sign in with your Solana account:`,
      signer.address,
      "",
      "Sign in to Heat. Signing sends no transaction and costs nothing.",
      "",
      `URI: ${ORIGINS.web}`,
      "Version: 1",
    ]);
    expect(lines[7]).toMatch(/^Chain ID: (devnet|localnet|mainnet)$/);
    expect(lines[8]).toMatch(/^Nonce: [0-9a-f]{32}$/);
    const issued = Date.parse(lines[9]!.replace("Issued At: ", ""));
    const expires = Date.parse(lines[10]!.replace("Expiration Time: ", ""));
    expect(issued).toBeGreaterThanOrEqual(before - 1_000);
    expect(expires - issued).toBe(10 * 60_000);
    expect(Date.parse(expiresAt)).toBe(expires);
    // Every message has its own nonce.
    expect((await askSignIn(signer)).message).not.toContain(lines[8]);
  });

  it("signs a wallet in as a new record whose Creator wallet it is, with no X account, and again as the same record", async () => {
    const signer = await generateKeyPairSigner();
    const { res, message, session } = await signIn(signer);
    expect(res.status, await res.clone().text()).toBe(200);
    const cookie = setCookies(res).get("heat_session")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const expected = { x: null, wallet: signer.address, creatorWallet: signer.address, launches: 0 };
    expect(Me.parse(await res.json())).toEqual(expected);
    expect(await meOf(session)).toEqual(expected);

    // The proof is kept so anyone can check it again: the signature over the very message.
    const [bound] = await db.select().from(creatorWallets).where(eq(creatorWallets.wallet, signer.address));
    expect(bound).toMatchObject({ via: "sign_in", proofMessage: message, endedAt: null });
    const signature = getBase58Encoder().encode(bound!.proof);
    expect(await verifySignature(await getPublicKeyFromAddress(signer.address as Address), signature as SignatureBytes, new TextEncoder().encode(message))).toBe(true);
    const [record] = await db.select().from(creators).where(eq(creators.id, bound!.creatorId));
    expect(record).toMatchObject({ xUserId: null, xHandle: null, xName: null });

    // Signing in again, from another browser, finds the same record.
    const again = await signIn(signer);
    expect(again.res.status).toBe(200);
    expect(again.session).not.toBe(session);
    expect(await db.select().from(creatorWallets).where(eq(creatorWallets.wallet, signer.address))).toHaveLength(1);
    expect(await meOf(again.session)).toEqual(expected);
  });

  it("takes a message once: a replayed one is refused", async () => {
    const signer = await generateKeyPairSigner();
    const { message } = await askSignIn(signer);
    const body = { wallet: signer.address, message, signature: await sign(signer, message) };
    expect((await post("/auth/wallet", body)).status).toBe(200);
    const replay = await post("/auth/wallet", body);
    expect({ status: replay.status, ...WalletSignInRefusal.parse(await replay.json()) }).toMatchObject({ status: 401, code: "expired" });
    expect(setCookies(replay).get("heat_session")).toBeUndefined();
  });

  it("refuses a message signed after it expired, and takes it no more", async () => {
    const signer = await generateKeyPairSigner();
    const { message } = await askSignIn(signer);
    const nonce = /Nonce: (\w+)/.exec(message)![1]!;
    await db.update(walletSignIns).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(walletSignIns.nonce, nonce));
    const body = { wallet: signer.address, message, signature: await sign(signer, message) };
    const late = await post("/auth/wallet", body);
    expect({ status: late.status, ...WalletSignInRefusal.parse(await late.json()) }).toMatchObject({ status: 401, code: "expired" });
    expect(setCookies(late).get("heat_session")).toBeUndefined();
    expect(await db.select().from(walletSignIns).where(eq(walletSignIns.nonce, nonce))).toHaveLength(0);
    expect(await db.select().from(creatorWallets).where(eq(creatorWallets.wallet, signer.address))).toHaveLength(0);
  });

  it("refuses a message edited, one given to another wallet, one Heat never gave, and a signature not the wallet's", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const { message } = await askSignIn(signer);
    const attempt = async (wallet: string, text: string, signature: string) => {
      const res = await post("/auth/wallet", { wallet, message: text, signature });
      expect(setCookies(res).get("heat_session")).toBeUndefined();
      return { status: res.status, ...WalletSignInRefusal.parse(await res.json()) };
    };
    const edited = message.replace("Sign in to Heat.", "Sign in to Heat, and more.");
    expect(await attempt(signer.address, edited, await sign(signer, edited))).toMatchObject({ status: 400, code: "invalid" });
    const forOther = message.replace(signer.address, other.address);
    expect(await attempt(other.address, forOther, await sign(other, forOther))).toMatchObject({ status: 400, code: "invalid" });
    const madeUp = message.replace(/Nonce: \w+/, `Nonce: ${"0".repeat(32)}`);
    expect(await attempt(signer.address, madeUp, await sign(signer, madeUp))).toMatchObject({ status: 401, code: "expired" });
    expect(await attempt(signer.address, message, await sign(other, message))).toMatchObject({ status: 400, code: "invalid" });
    // None of those used the message up.
    expect((await post("/auth/wallet", { wallet: signer.address, message, signature: await sign(signer, message) })).status).toBe(200);
  });

  it("is a write the web app alone may make", async () => {
    const signer = await generateKeyPairSigner();
    const res = await request("/auth/wallet/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: signer.address }) });
    expect(res.status).toBe(403);
  });

  it("links X to the wallet's record, which then shows it, and refuses an X account another record holds", async () => {
    const signer = await generateKeyPairSigner();
    const { session } = await signIn(signer);
    fakes.xUser = { id: "2001", username: "wallet_first", name: "Wallet First" };
    const linked = await link(session);
    expect(linked.res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=linked`);
    // The browser keeps its session, now with X on the record.
    expect(linked.session).toBeUndefined();
    expect(await meOf(session)).toEqual({ x: { handle: "wallet_first", name: "Wallet First", avatarUrl: null }, wallet: signer.address, creatorWallet: signer.address, launches: 0 });

    // An X account linked to another record already stays there.
    fakes.xUser = { id: "2002", username: "elsewhere", name: "Elsewhere" };
    await link();
    const second = await signIn(await generateKeyPairSigner());
    const taken = await link(second.session);
    expect(taken.res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=taken`);
    expect((await meOf(second.session))?.x).toBeNull();
    // And a record with an X account takes no other.
    const other = await link(session);
    expect(other.res.headers.get("location")).toBe(`${ORIGINS.web}/launch?x=taken`);
    expect((await meOf(session))?.x?.handle).toBe("wallet_first");
  });

  it("makes the wallet the Creator wallet of the record the browser linked X for, when it has none yet", async () => {
    fakes.xUser = { id: "2101", username: "x_first", name: "X First" };
    const { session } = await link();
    const signer = await generateKeyPairSigner();
    const signed = await signIn(signer, session);
    expect(signed.res.status).toBe(200);
    expect(await meOf(signed.session)).toEqual({ x: { handle: "x_first", name: "X First", avatarUrl: null }, wallet: signer.address, creatorWallet: signer.address, launches: 0 });
    // The X session it replaced is over.
    expect(await meOf(session)).toBeNull();

    // A record with a Creator wallet keeps it: another wallet signs in as a record of its own.
    const another = await generateKeyPairSigner();
    const elsewhere = await signIn(another, signed.session);
    expect(await meOf(elsewhere.session)).toMatchObject({ x: null, wallet: another.address, creatorWallet: another.address });
  });

  it("signs a wallet verified for an X account in as that account's record, when it has no Creator wallet yet", async () => {
    fakes.xUser = { id: "2201", username: "depositor", name: "Depositor" };
    await link();
    const [record] = await db.select().from(creators).where(eq(creators.xUserId, "2201"));
    const signer = await generateKeyPairSigner();
    await db.insert(walletVerifications).values({ wallet: signer.address, creatorId: record!.id, method: "x", message: "m", signature: "s" });
    const { session } = await signIn(signer);
    expect(await meOf(session)).toMatchObject({ x: { handle: "depositor" }, creatorWallet: signer.address });
  });
});
