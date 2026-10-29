// A stand-in for X's OAuth 2.0 and users API, for the launch flow's end-to-end test and for local development before
// an X app exists: it authorizes every request at once, as a creator pressing "Authorize app" on X would, and checks
// PKCE like X does. Point the API at it with X_AUTHORIZE_URL=<origin>/i/oauth2/authorize and X_API_URL=<origin>.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FakeXUser = { id: string; username: string; name: string };

export function startFakeX(port: number, user: FakeXUser): Promise<Server> {
  const challenges = new Map<string, string>();
  const tokens = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const form = async () =>
      new URLSearchParams(
        await new Promise<string>((done) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => done(body));
        }),
      );

    if (url.pathname === "/i/oauth2/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      const code = randomUUID();
      challenges.set(code, url.searchParams.get("code_challenge") ?? "");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      redirect.searchParams.set("code", code);
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === "/2/oauth2/token" && req.method === "POST") {
      const body = await form();
      const challenge = challenges.get(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        return json(400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." });
      }
      challenges.delete(body.get("code")!);
      const token = randomUUID();
      tokens.add(token);
      return json(200, { token_type: "bearer", access_token: token, expires_in: 7200, scope: "tweet.read users.read" });
    }
    if (url.pathname === "/2/users/me") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.has(token)) return json(401, { title: "Unauthorized" });
      return json(200, { data: user });
    }
    if (url.pathname === "/2/oauth2/revoke" && req.method === "POST") {
      tokens.delete((await form()).get("token") ?? "");
      return json(200, { revoked: true });
    }
    json(404, { title: "Not Found" });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

// `pnpm exec tsx tests/ui/src/fake-x.ts` serves it on FAKE_X_PORT (8890) as @heat_tester until stopped.
// The path compare goes through fileURLToPath: the folder has a space, which a file URL keeps as %20.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.FAKE_X_PORT ?? 8890);
  await startFakeX(port, { id: process.env.FAKE_X_USER_ID ?? "424242", username: process.env.FAKE_X_HANDLE ?? "heat_tester", name: "Heat Tester" });
  console.log(`fake X on http://localhost:${port}`);
}
