// The acceptance run (spec 11, #62): `direnv exec "<main checkout>" pnpm acceptance` from the repo's root runs every
// stage in `stages.ts` against devnet and the deployed devnet site, one at a time, and keeps going past a failed stage so
// one run shows every result. Each stage's whole output goes to `tests/acceptance/runs/<run>/<stage>.log` (gitignored)
// and to this terminal; `results.json` and `results.md` there say what passed, how long each took and what the bank held
// before and after. It exits non-zero unless every stage passed.
//
// Flags: `--only a,b` runs just those stages, `--skip a,b` leaves them out, `--from a` starts at one, `--list` prints the
// plan and runs nothing. The measurement stages (`compute`, `opens`) always read from the run's own start, so a partial
// run measures only what it ran.
//
// It needs what its stages need: DATABASE_URL (the devnet database) and HELIUS_API_KEY from the main checkout's
// environment, which `direnv exec` gives, and Heat's devnet keys in ~/.config/top-pad/devnet. Real devnet SOL: about 5 a
// run from Heat's bank, about 10 of it lent at once at the 8.5 SOL Graduation, and some from the keeper key, which pays
// the launch key's fees and the deployed keeper's sends: a stage starts only while the keeper holds 0.5 SOL. About four
// and a half hours.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { STAGES, type Stage } from "./stages";
import { readRpc } from "./rpc";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const argv = process.argv.slice(2);
const option = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const list = (name: string) => option(name)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

function plan(): Stage[] {
  const names = new Set(STAGES.map((s) => s.name));
  const only = list("--only");
  const skip = list("--skip");
  const from = option("--from");
  for (const name of [...only, ...skip, ...(from ? [from] : [])]) if (!names.has(name)) throw new Error(`no stage named ${name}: ${[...names].join(", ")}`);
  let stages = STAGES;
  if (from) stages = stages.slice(stages.findIndex((s) => s.name === from));
  if (only.length) stages = stages.filter((s) => only.includes(s.name));
  return stages.filter((s) => !skip.includes(s.name));
}

const stages = plan();
const total = stages.reduce((m, s) => m + s.minutes, 0);
console.log(`The acceptance run: ${stages.length} stages, about ${Math.round(total / 6) / 10} hours`);
for (const s of stages) console.log(`  ${s.name.padEnd(24)} ${String(s.minutes).padStart(3)} min  ${s.proves}`);
if (argv.includes("--list")) process.exit(0);

for (const name of ["DATABASE_URL", "HELIUS_API_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} is not set: run it as \`direnv exec "<main checkout>" pnpm acceptance\`.`);
}

const rpc = readRpc();
const bank = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/top-pad/devnet/bank.json"), "utf8")) as number[]));
const bankSol = async () => Number((await rpc.getBalance(bank.address, { commitment: "confirmed" }).send()).value) / 1e9;
// The keeper key pays too: the launch key's fees in the tests, and the deployed keeper's migrations, nonces and claims. A
// run took it from about 2 SOL to nothing on 2026-11-15, and every keeper send after that failed for rent.
const keeper = CLUSTERS.devnet!.keys!.keeper;
const keeperSol = async () => Number((await rpc.getBalance(keeper, { commitment: "confirmed" }).send()).value) / 1e9;
/** The most a stage has taken from the keeper key, with room: a stage starts only with this much there. */
const KEEPER_NEEDS = 0.5;

const runName = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(root, "tests", "acceptance", "runs", runName);
mkdirSync(dir, { recursive: true });
// A number, so the results file can hold it; slots stay far below 2^53.
const startSlot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
const startedAt = new Date();
console.log(`run ${runName}: logs in ${dir}; from slot ${startSlot}`);

type Result = {
  name: string;
  proves: string;
  status: "passed" | "failed" | "not run";
  why?: string;
  minutes: number;
  bankBefore: number;
  bankAfter: number;
  keeperBefore: number;
  keeperAfter: number;
  log: string;
};
const results: Result[] = [];
const bankAtStart = await bankSol();
const keeperAtStart = await keeperSol();

const portOpen = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.end(), done(true)));
    socket.once("error", () => done(false));
  });

const stopGroup = (child: ChildProcess) => {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    // Already gone.
  }
};

/** The operator apps the bundler simulation drives, started for it unless already up, and stopped after it. */
async function startOperators(log: NodeJS.WritableStream): Promise<ChildProcess | null> {
  if ((await portOpen(8803)) && (await portOpen(8804))) return null;
  if ((await portOpen(8803)) || (await portOpen(8804))) throw new Error("only one of ports 8803 and 8804 answers: something else holds the other");
  // In a process group of its own, so stopping it stops both `wrangler dev`s under it.
  const child = spawn("pnpm", ["--filter", "@top-pad/tests-ui", "operators"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  for (let i = 0; i < 120; i++) {
    if ((await portOpen(8803)) && (await portOpen(8804))) return child;
    if (child.exitCode !== null) throw new Error(`the operator apps stopped (${child.exitCode})`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  stopGroup(child);
  throw new Error("the operator apps did not answer within 2 minutes");
}

function runStage(stage: Stage, log: NodeJS.WritableStream): Promise<number> {
  return new Promise((done) => {
    const env = { ...process.env, ...stage.env, ACCEPTANCE_SINCE_SLOT: `${startSlot}`, ACCEPTANCE_STARTED_AT: startedAt.toISOString(), ACCEPTANCE_RUN_DIR: dir };
    const child = spawn(stage.command[0]!, stage.command.slice(1), { cwd: join(root, stage.cwd), env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (chunk: Buffer) => {
        log.write(chunk);
        process.stdout.write(chunk);
      });
    }
    child.on("close", (code) => done(code ?? 1));
  });
}

for (const stage of stages) {
  const logFile = join(dir, `${stage.name}.log`);
  const log = createWriteStream(logFile);
  const bankBefore = await bankSol();
  const keeperBefore = await keeperSol();
  const started = Date.now();
  const result: Result = { name: stage.name, proves: stage.proves, status: "not run", minutes: 0, bankBefore, bankAfter: bankBefore, keeperBefore, keeperAfter: keeperBefore, log: logFile };
  results.push(result);
  console.log(`\n=== ${stage.name} (bank ${bankBefore.toFixed(3)} SOL, keeper ${keeperBefore.toFixed(3)} SOL): ${stage.proves}`);
  // A stage that would leave the bank or the keeper short stops there, not halfway through with its wallets holding the SOL.
  if (bankBefore < stage.peakSol + 1 || keeperBefore < KEEPER_NEEDS) {
    result.why =
      bankBefore < stage.peakSol + 1
        ? `the bank held ${bankBefore.toFixed(3)} SOL, short of the ${stage.peakSol + 1} this stage needs at once`
        : `the keeper key held ${keeperBefore.toFixed(3)} SOL, short of ${KEEPER_NEEDS}: top it up from the bank`;
    console.log(`not run: ${result.why}`);
    log.end();
    continue;
  }
  let operators: ChildProcess | null = null;
  try {
    if (stage.operators) operators = await startOperators(log);
    const code = await runStage(stage, log);
    result.status = code === 0 ? "passed" : "failed";
    if (code !== 0) result.why = `exited with ${code}`;
  } catch (e) {
    result.status = "failed";
    result.why = (e as Error).message;
  } finally {
    if (operators) stopGroup(operators);
  }
  result.minutes = Math.round((Date.now() - started) / 6_000) / 10;
  result.bankAfter = await bankSol();
  result.keeperAfter = await keeperSol();
  console.log(
    `=== ${stage.name}: ${result.status}${result.why ? ` (${result.why})` : ""}, ${result.minutes} min, bank ${result.bankAfter.toFixed(3)} SOL, keeper ${result.keeperAfter.toFixed(3)} SOL`,
  );
  log.end();
  writeFileSync(join(dir, "results.json"), JSON.stringify({ run: runName, startSlot, startedAt, bankAtStart, results }, null, 2));
}

const bankAtEnd = await bankSol();
const keeperAtEnd = await keeperSol();
const passed = results.filter((r) => r.status === "passed").length;
const lines = [
  `# Acceptance run ${runName}`,
  "",
  `From slot ${startSlot}, started ${startedAt.toISOString()}, ended ${new Date().toISOString()}.`,
  `${passed} of ${results.length} stages passed; the bank held ${bankAtStart.toFixed(3)} SOL before and ${bankAtEnd.toFixed(3)} after (airdrops landing meanwhile count too), the keeper key ${keeperAtStart.toFixed(3)} and ${keeperAtEnd.toFixed(3)}.`,
  "",
  "| Stage | Result | Minutes | Bank change (SOL) | Keeper change (SOL) | Proves |",
  "| - | - | -: | -: | -: | - |",
  ...results.map(
    (r) => `| ${r.name} | ${r.status}${r.why ? `: ${r.why}` : ""} | ${r.minutes} | ${(r.bankAfter - r.bankBefore).toFixed(3)} | ${(r.keeperAfter - r.keeperBefore).toFixed(3)} | ${r.proves} |`,
  ),
  "",
];
writeFileSync(join(dir, "results.json"), JSON.stringify({ run: runName, startSlot, startedAt, endedAt: new Date(), bankAtStart, bankAtEnd, keeperAtStart, keeperAtEnd, results }, null, 2));
writeFileSync(join(dir, "results.md"), lines.join("\n"));
console.log(`\n${lines.join("\n")}`);
process.exit(passed === results.length ? 0 : 1);
