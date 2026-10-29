import { describe, expect, it } from "vitest";
import { standInUser, xStandIn } from "./handler";

const CALLBACK = "https://api.example/auth/x/callback";
const ORIGIN = "https://x-stand-in.example";
const HANDLE = "heat_tester_abc123";

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challengeOf = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

function standIn(now = () => 1_800_000_000_000) {
  const handle = xStandIn({ callbacks: [CALLBACK], now });
  const get = (path: string, headers: Record<string, string> = {}) => handle(new Request(`${ORIGIN}${path}`, { headers }));
  const post = (path: string, form: Record<string, string>) =>
    handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) }));
  return { get, post };
}

/** What the API sends a browser to X with (apps/api/src/auth.ts). */
async function authorizeParams(verifier = "the-verifier-the-verifier-the-verifier-0123") {
  return {
    response_type: "code",
    client_id: "x-stand-in",
    redirect_uri: CALLBACK,
    scope: "tweet.read users.read",
    state: "the-state",
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
  };
}

/** The browser pressing "Authorize app" as `username`: the callback X sends it back to. */
async function authorize(x: ReturnType<typeof standIn>, username: string, verifier?: string) {
  const res = await x.post("/i/oauth2/authorize", { ...(await authorizeParams(verifier)), username, decision: "allow" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe("the X stand-in", () => {
  it("runs X's authorization code flow with PKCE, as the API's linking code calls it", async () => {
    const x = standIn();
    const params = await authorizeParams();
    const page = await x.get(`/i/oauth2/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("Authorize app");
    // The form carries the API's request on to the approval.
    for (const value of [params.state, params.code_challenge, CALLBACK]) expect(html).toContain(`value="${value}"`);
    expect(html).toMatch(/name="username" value="heat_tester_[a-z0-9]{6}"/);

    const back = await authorize(x, HANDLE);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("the-state");

    const token = await x.post("/2/oauth2/token", {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: CALLBACK,
      code_verifier: "the-verifier-the-verifier-the-verifier-0123",
      client_id: "x-stand-in",
    });
    expect(token.status).toBe(200);
    const { access_token, token_type, scope } = (await token.json()) as Record<string, string>;
    expect({ token_type, scope }).toEqual({ token_type: "bearer", scope: "tweet.read users.read" });

    const me = await x.get("/2/users/me?user.fields=profile_image_url", { authorization: `Bearer ${access_token}` });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ data: await standInUser(HANDLE) });
    expect((await x.post("/2/oauth2/revoke", { token: access_token! })).status).toBe(200);
  });

  it("gives a handle the same X id in any case, and other handles other ids", async () => {
    const user = await standInUser(HANDLE);
    expect(user).toMatchObject({ username: HANDLE, name: HANDLE });
    expect(user.id).toMatch(/^[1-9]\d{0,16}$/);
    expect((await standInUser(HANDLE.toUpperCase())).id).toBe(user.id);
    expect((await standInUser("heat_tester_abc124")).id).not.toBe(user.id);
  });

  it("never sends a browser to a callback the app does not list", async () => {
    const x = standIn();
    const params = { ...(await authorizeParams()), redirect_uri: "https://evil.example/cb" };
    const page = await x.get(`/i/oauth2/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(400);
    expect(page.headers.get("location")).toBeNull();
    expect(await page.text()).toContain("is not one this app lists");
    const approval = await x.post("/i/oauth2/authorize", { ...params, username: HANDLE, decision: "allow" });
    expect(approval.status).toBe(400);
    expect(approval.headers.get("location")).toBeNull();
  });

  it("refuses a handle X could hold, so test metadata never names a real account", async () => {
    const x = standIn();
    const res = await x.post("/i/oauth2/authorize", { ...(await authorizeParams()), username: "elonmusk", decision: "allow" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("16 to 30 letters, digits or underscores");
    // An @ typed in front is X's own way of writing a handle, not part of it.
    expect((await authorize(x, `@${HANDLE}`)).searchParams.get("code")).toBeTruthy();
  });

  it("sends the browser back with access_denied when the creator cancels", async () => {
    const x = standIn();
    const res = await x.post("/i/oauth2/authorize", { ...(await authorizeParams()), username: "", decision: "deny" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(Object.fromEntries(back.searchParams)).toEqual({ state: "the-state", error: "access_denied" });
  });

  it("exchanges a code only with its verifier, its callback and before it expires", async () => {
    let now = 1_800_000_000_000;
    const x = standIn(() => now);
    const code = (await authorize(x, HANDLE)).searchParams.get("code")!;
    const exchange = (form: Record<string, string>) =>
      x.post("/2/oauth2/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: "the-verifier-the-verifier-the-verifier-0123", ...form });

    expect((await exchange({ code_verifier: "another-verifier" })).status).toBe(400);
    expect((await exchange({ redirect_uri: "https://api.example/elsewhere" })).status).toBe(400);
    expect((await exchange({ code: "not-a-code" })).status).toBe(400);
    now += 11 * 60 * 1000;
    const late = await exchange({});
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: "invalid_request", error_description: "The authorization code has expired." });
  });

  it("reads no account without a token it issued", async () => {
    const x = standIn();
    expect((await x.get("/2/users/me")).status).toBe(401);
    expect((await x.get("/2/users/me", { authorization: "Bearer someone-elses-token" })).status).toBe(401);
  });

  it("escapes what it echoes into its page", async () => {
    const x = standIn();
    const params = { ...(await authorizeParams()), state: `"><script>alert(1)</script>` };
    const html = await (await x.get(`/i/oauth2/authorize?${new URLSearchParams(params)}`)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
