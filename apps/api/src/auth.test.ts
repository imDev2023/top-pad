import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Me } from "@top-pad/contract";
import { createDb, creators, type Db } from "@top-pad/db";
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

async function link() {
  const { state } = await startLink();
  const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}` } });
  const session = cookieValue(setCookies(res).get("heat_session"));
  return { res, session };
}

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
    expect(me.x.handle).toBe("lumen_renamed");
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
