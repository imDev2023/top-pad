// The stand-in for X in Node, for the launch flow's end-to-end test and for local development: the same handler the
// devnet Worker runs, behind node:http. `pnpm --filter @top-pad/x-stand-in dev` serves it on X_STAND_IN_PORT (8890)
// for the local API's callback until stopped.
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { xStandIn, type XStandInOptions } from "./handler";

export function serveXStandIn(port: number, options: XStandInOptions): Promise<Server> {
  const handle = xStandIn(options);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
      }
      const response = await handle(
        new Request(new URL(req.url ?? "/", `http://localhost:${port}`), {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error("the X stand-in failed", e);
      res.writeHead(500).end();
    }
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

// The path compare goes through fileURLToPath: the folder has a space, which a file URL keeps as %20.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.X_STAND_IN_PORT ?? 8890);
  await serveXStandIn(port, { callbacks: [process.env.X_STAND_IN_CALLBACK ?? "http://localhost:8801/auth/x/callback"] });
  console.log(`The X stand-in is on http://localhost:${port}`);
}
