// Two operator apps on this Mac (`pnpm --filter @top-pad/tests-ui operators`), for the bundler simulation
// (bundler-simulation.spec.ts): spec 6.5 has one operator confirm a case and a different one hear its appeal, and the
// deployed app, behind Cloudflare Access, signs in only the owner. Each runs `wrangler dev` from apps/operator with its own
// copy of the config, whose `access.dev` block stands in for Access with its own identity, against the database
// `DATABASE_URL` names (the devnet database, through `direnv exec`), and with appeals by the confirming operator refused,
// so the rule is exercised as on mainnet. Stop it with Ctrl-C, or TaskStop from an agent session.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPERATORS = [
  { port: 8803, email: "devnet-operator-1@heat.local" },
  { port: 8804, email: "devnet-operator-2@heat.local" },
] as const;

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "operator");

function configFor(email: string, webApp: string) {
  // JSONC: the comments go, then the identity, the web app and the appeal rule are set on the parsed config.
  const text = readFileSync(join(app, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text) as { main: string; access: { dev: { identity: { email: string } } }; vars: Record<string, string>; env?: unknown; $schema?: string };
  config.access.dev.identity.email = email;
  config.vars.WEB_APP = webApp;
  delete config.vars.APPEALS_BY_CONFIRMER;
  delete config.env;
  delete config.$schema;
  // Written under .wrangler (gitignored), so `main` reaches back to the app's source.
  config.main = join("..", config.main);
  const dir = join(app, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `operator-${email.split("@")[0]}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

// The path compare goes through fileURLToPath: the folder has a space, which a file URL keeps as %20.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error("Run through direnv exec, so DATABASE_URL names the database the operators work on.");
  const webApp = process.env.OPERATOR_WEB_APP ?? "https://top-pad-web-devnet.rc-labs.workers.dev";
  // Each keeps its local state (R2) apart: two runtimes on one state directory lock each other's SQLite out.
  const children: ChildProcess[] = OPERATORS.map(({ port, email }) =>
    spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "-c", configFor(email, webApp), "--port", `${port}`, "--inspector-port", `${port + 1000}`, "--persist-to", join(app, ".wrangler", `state-${port}`)],
      { cwd: app, stdio: "inherit", env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: database } },
    ),
  );
  const stop = () => children.forEach((c) => c.kill("SIGTERM"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // One that stops takes the other with it, and its exit code is the script's: half the pair is no use to the spec.
  for (const child of children) {
    child.on("exit", (code) => {
      stop();
      process.exitCode = code ?? 1;
    });
  }
  for (const { port, email } of OPERATORS) console.log(`operator ${email} on http://localhost:${port}`);
}
