// The Bundle Radar evaluation (spec 11.5), in one command:
//
//   pnpm --filter @top-pad/tests-radar-eval evaluate [--refetch] [--collect-only] [--concurrency <n>]
//
// It lists the launch list's day of pump.fun launches if `data/launches.json` is missing, reads every launch on it that
// `data/set.jsonl` does not hold yet, reads the Cryptstarter and Harmonized fleet into `data/fleet.json` if missing, then
// scores Bundle Radar's signals and writes the report, `docs/bundle-radar-evaluation.md`. `--refetch` reads every
// launch and the fleet again (the launch list stays, so a rerun reads the same launches). Only free reads: Solana's
// public mainnet endpoint and Jito's public API, no key and no transaction.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collectLaunch, Histories, type LaunchRecord, type SkippedRecord } from "./collect";
import { evaluate } from "./evaluate";
import { collectFleet, type FleetSet } from "./fleet";
import { jitoRecords } from "./jito";
import { launchList, type LaunchList } from "./launches";
import { writeReport } from "./report";
import { publicRpc } from "./rpc";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));
const REPORT = fileURLToPath(new URL("../../../docs/bundle-radar-evaluation.md", import.meta.url));
const LAUNCHES = `${DATA}launches.json`;
const SET = `${DATA}set.jsonl`;
const FLEET = `${DATA}fleet.json`;

/** The day the launch list is drawn from: a whole UTC day whose 7 days after every launch have passed. */
const DAY = "2026-10-25";
const COUNT = 2000;

const { values: args } = parseArgs({
  options: { refetch: { type: "boolean", default: false }, "collect-only": { type: "boolean", default: false }, concurrency: { type: "string", default: "6" } },
});
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

mkdirSync(DATA, { recursive: true });
const rpc = publicRpc();
const jito = jitoRecords();

let list: LaunchList;
if (existsSync(LAUNCHES)) list = JSON.parse(readFileSync(LAUNCHES, "utf8")) as LaunchList;
else {
  log(`listing every pump.fun launch of ${DAY}`);
  list = await launchList(rpc, DAY, COUNT, log);
  writeFileSync(LAUNCHES, `${JSON.stringify(list, null, 1)}\n`);
  log(`${list.creations} creations that day; ${list.launches.length} on the list`);
}

if (args.refetch && existsSync(SET)) renameSync(SET, `${SET}.old`);
const readSet = () =>
  existsSync(SET)
    ? readFileSync(SET, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LaunchRecord | SkippedRecord)
    : [];
const done = new Set(readSet().map((r) => r.signature));
const todo = list.launches.filter((l) => !done.has(l.signature));
if (todo.length) {
  log(`reading ${todo.length} launches (${done.size} already in the set)`);
  const histories = Histories.forDay(rpc, list.day);
  const started = Date.now();
  let finished = 0;
  let failed = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Number(args.concurrency) }, async () => {
      for (let launch = queue.shift(); launch; launch = queue.shift()) {
        try {
          const record = await collectLaunch(rpc, jito, histories, launch);
          appendFileSync(SET, `${JSON.stringify(record)}\n`);
        } catch (e) {
          failed++;
          log(`${launch.signature} failed, left for the next run: ${e instanceof Error ? e.message : String(e)}`);
        }
        finished++;
        if (finished % 25 === 0) {
          const eta = ((Date.now() - started) / finished) * (todo.length - finished);
          log(`${finished}/${todo.length} read, ${failed} failed, about ${Math.round(eta / 60_000)} min to go`);
        }
      }
    }),
  );
  if (failed) {
    log(`${failed} launches failed to read; run the command again to read them`);
    process.exit(1);
  }
}

if (args.refetch || !existsSync(FLEET)) {
  log("reading the Cryptstarter and Harmonized fleet");
  writeFileSync(FLEET, `${JSON.stringify(await collectFleet(rpc, jito, log), null, 1)}\n`);
}
if (args["collect-only"]) process.exit(0);

const results = evaluate(list, readSet(), JSON.parse(readFileSync(FLEET, "utf8")) as FleetSet);
writeFileSync(REPORT, writeReport(results));
log(`wrote ${REPORT}`);
