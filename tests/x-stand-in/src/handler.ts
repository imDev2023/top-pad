// A stand-in for X's OAuth 2.0 and users API (spec 2.1 step 1), until Heat has its own X app: the authorize page, the
// token, `users/me` and revoke endpoints, enough for the API's linking code to run unchanged against it. On its authorize
// page the browser picks the handle to link as, where a creator would press "Authorize app" on X.
// It keeps no state, so it runs alike as a Worker (devnet) and in Node (the end-to-end test): the code carries the PKCE
// challenge, the callback and the handle, and the access token carries the handle. A handle must be longer than X allows
// (16 to 30 characters), so a test coin's metadata, which links the handle's X profile and stays on Arweave forever, can
// never point at a real person's account.

export type XStandInOptions = {
  /** The callback URLs it sends a browser back to, as an X app lists them; it refuses any other. */
  callbacks: string[];
  /** The clock, in milliseconds; tests move it. */
  now?: () => number;
};

export type StandInUser = { id: string; name: string; username: string };

const HANDLE = /^[A-Za-z0-9_]{16,30}$/;
const CODE_SECONDS = 10 * 60;
const SCOPE = "tweet.read users.read";
const TOKEN_PREFIX = "standin.";

const utf8 = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const seal = (value: unknown) => base64url(utf8.encode(JSON.stringify(value)));
function unseal<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(value))) as T;
  } catch {
    return null;
  }
}
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));

/** The account a handle stands for: the same id for the same handle in any case, as X's handles are case-insensitive. */
export async function standInUser(username: string): Promise<StandInUser> {
  // An X id is a decimal string; seven bytes of the handle's hash keep it below 2^56.
  const id = (await sha256(username.toLowerCase())).slice(0, 7).reduce((n, b) => n * 256n + BigInt(b), 0n).toString();
  return { id, name: username, username };
}

/** What the authorize page carries from the API's request to its own form. */
type Authorization = { clientId: string; redirectUri: string; state: string; codeChallenge: string };
type Code = { challenge: string; redirectUri: string; username: string; expiresAt: number };

/** The authorization the API asked for, or why it cannot be granted; the callback is checked before anything else. */
function authorizationOf(params: URLSearchParams, callbacks: string[]): Authorization | string {
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!callbacks.includes(redirectUri)) return `The callback ${redirectUri || "(none)"} is not one this app lists.`;
  if (params.get("response_type") !== "code") return "response_type must be code.";
  if (params.get("code_challenge_method") !== "S256") return "code_challenge_method must be S256.";
  const clientId = params.get("client_id") ?? "";
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!clientId || !state || !codeChallenge) return "client_id, state and code_challenge are all required.";
  return { clientId, redirectUri, state, codeChallenge };
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function suggestedHandle() {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]);
  return `heat_tester_${letters.join("")}`;
}

function page(status: number, title: string, body: string) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} - stand-in for X</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f8fa; --card: #ffffff; --text: #0f1419; --muted: #536471; --line: #cfd9de;
    --button: #0f1419; --button-text: #ffffff; --bad: #b4232a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #000000; --card: #16181c; --text: #e7e9ea; --muted: #8b98a5; --line: #2f3336; --button: #eff3f4;
      --button-text: #0f1419; --bad: #f4212e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg);
    color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; }
  .tag { margin: 0 0 12px; color: var(--muted); font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.25; }
  p { margin: 0 0 16px; color: var(--muted); }
  label { display: block; margin: 20px 0 6px; font-weight: 600; }
  .field { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 8px; padding: 0 12px; }
  .field:focus-within { outline: 2px solid #1d9bf0; outline-offset: -1px; }
  .field span { color: var(--muted); }
  input { flex: 1; min-width: 0; border: 0; background: transparent; color: inherit; font: inherit; padding: 12px 0 12px 2px; outline: none; }
  .hint { margin: 8px 0 0; font-size: 13px; }
  .error { color: var(--bad); }
  .actions { display: grid; gap: 12px; margin-top: 24px; }
  button { font: inherit; font-weight: 700; border-radius: 999px; padding: 12px 16px; cursor: pointer; border: 1px solid var(--line); }
  .allow { background: var(--button); color: var(--button-text); border-color: var(--button); }
  .deny { background: transparent; color: var(--text); }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  // No form-action: browsers apply it to every redirect after a post, and the approval's chain ends on the web app, an
  // origin the stand-in never learns.
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", "frame-ancestors 'none'", "base-uri 'none'"];
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp.join("; "),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

function authorizePage(authorization: Authorization, handle: string, error: string | null) {
  const hidden = Object.entries({
    response_type: "code",
    client_id: authorization.clientId,
    redirect_uri: authorization.redirectUri,
    state: authorization.state,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256",
  })
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`)
    .join("\n");
  return page(
    error ? 400 : 200,
    "Authorize Heat",
    `<p class="tag">Stand-in for X</p>
<h1>Heat wants to read your X account</h1>
<p>Heat's devnet prototype links this stand-in until it has its own X app, so no real X account is read. Pick the handle to link as: it is longer than X allows, so it can never be someone's real account.</p>
<form method="post" action="/i/oauth2/authorize">
${hidden}
<label for="username">Handle</label>
<div class="field"><span>@</span><input id="username" name="username" value="${escape(handle)}" autocomplete="off" autocapitalize="off" spellcheck="false" required minlength="16" maxlength="30" pattern="[A-Za-z0-9_]{16,30}" aria-describedby="handle-rule"></div>
<p id="handle-rule" class="hint${error ? " error" : ""}">${escape(error ?? "16 to 30 letters, digits or underscores.")}</p>
<div class="actions">
<button class="allow" type="submit" name="decision" value="allow">Authorize app</button>
<button class="deny" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
</div>
</form>`,
  );
}

/** A request it cannot authorize: shown, never redirected, as X does with an unknown callback. */
const refused = (reason: string) =>
  page(400, "Cannot authorize", `<p class="tag">Stand-in for X</p>\n<h1>This request cannot be authorized</h1>\n<p>${escape(reason)}</p>`);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The stand-in, as a fetch handler. */
export function xStandIn({ callbacks, now = Date.now }: XStandInOptions) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/i/oauth2/authorize" && request.method === "GET") {
      const authorization = authorizationOf(url.searchParams, callbacks);
      if (typeof authorization === "string") return refused(authorization);
      return authorizePage(authorization, suggestedHandle(), null);
    }

    if (url.pathname === "/i/oauth2/authorize" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const authorization = authorizationOf(form, callbacks);
      if (typeof authorization === "string") return refused(authorization);
      const back = new URL(authorization.redirectUri);
      back.searchParams.set("state", authorization.state);
      if (form.get("decision") !== "allow") {
        back.searchParams.set("error", "access_denied");
        return Response.redirect(back.toString(), 302);
      }
      const username = (form.get("username") ?? "").trim().replace(/^@/, "");
      if (!HANDLE.test(username)) return authorizePage(authorization, username, "A handle here is 16 to 30 letters, digits or underscores.");
      const code: Code = { challenge: authorization.codeChallenge, redirectUri: authorization.redirectUri, username, expiresAt: now() + CODE_SECONDS * 1000 };
      back.searchParams.set("code", seal(code));
      return Response.redirect(back.toString(), 302);
    }

    if (url.pathname === "/2/oauth2/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const invalid = (description: string) => json(400, { error: "invalid_request", error_description: description });
      if (form.get("grant_type") !== "authorization_code") return invalid("grant_type must be authorization_code.");
      const code = unseal<Code>(form.get("code") ?? "");
      if (!code?.challenge || !code.username) return invalid("Value passed for the authorization code was invalid.");
      if (code.expiresAt < now()) return invalid("The authorization code has expired.");
      if (form.get("redirect_uri") !== code.redirectUri) return invalid("redirect_uri does not match the authorization request.");
      if (base64url(await sha256(form.get("code_verifier") ?? "")) !== code.challenge) return invalid("The code_verifier does not match the code_challenge.");
      return json(200, { token_type: "bearer", expires_in: 7200, access_token: TOKEN_PREFIX + seal({ username: code.username }), scope: SCOPE });
    }

    if (url.pathname === "/2/users/me" && request.method === "GET") {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const claims = token.startsWith(TOKEN_PREFIX) ? unseal<{ username?: string }>(token.slice(TOKEN_PREFIX.length)) : null;
      if (!claims?.username || !HANDLE.test(claims.username)) return json(401, { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" });
      return json(200, { data: await standInUser(claims.username) });
    }

    if (url.pathname === "/2/oauth2/revoke" && request.method === "POST") return json(200, { revoked: true });

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("A stand-in for X's OAuth 2.0, for Heat's devnet prototype until it has its own X app.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return json(404, { title: "Not Found", type: "about:blank", status: 404, detail: "Not Found" });
  };
}
