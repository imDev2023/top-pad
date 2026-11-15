// Each instruction's compute (spec 11.2), measured on devnet: every transaction that named either of Heat's programs
// since the acceptance run's first slot (ACCEPTANCE_SINCE_SLOT, which `run.ts` passes; or `--since <slot>`) is read back,
// its logs walked invocation by invocation, and each of our programs' instructions credited with what its invocation
// consumed, the Meteora and token programs it called included, as a transaction's compute budget must cover it. A
// refused invocation (the failure simulation's attempts, a race lost to the keeper) is counted apart. Instructions the run
// never sends, the settings Heat's keys write, are measured by simulating each with the values on chain now, so nothing
// is written; `initialize`, which runs once a program, cannot run again, and is left out. Writes `compute.json` and
// `compute.md` into ACCEPTANCE_RUN_DIR when set, and prints the table.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {

  appendTransactionMessageInstruction,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";
import { CLUSTERS, DEVNET_USDC, eventAuthorityAddress, FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import {
  fetchProgramConfig,
  fetchQuoteSettings,
  findProgramConfigPda,
  findQuoteSettingsPda,
  getSetQuoteManagerInstructionAsync,
  getSetQuoteSettingsInstructionAsync,
  getUpdateProgramConfigInstructionAsync,
} from "@top-pad/clients/fair-open";
import { fetchFeeConfig, findFeeConfigPda, getUpdateFeeConfigInstructionAsync } from "@top-pad/clients/fee";
import { readRpc } from "./rpc";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rpc = readRpc();
const sinceArg = process.argv.indexOf("--since");
const since = BigInt(sinceArg >= 0 ? process.argv[sinceArg + 1]! : (process.env.ACCEPTANCE_SINCE_SLOT ?? ""));
if (!since) throw new Error("give the first slot: --since <slot>, or ACCEPTANCE_SINCE_SLOT");

const PROGRAMS = { [FEE_PROGRAM_ADDRESS]: "fee", [FAIR_OPEN_PROGRAM_ADDRESS]: "fair_open" } as Record<string, string>;
const idl = (name: string) =>
  (JSON.parse(readFileSync(join(root, "packages/clients/idl", `${name}.json`), "utf8")) as { instructions: { name: string }[] }).instructions.map((i) => i.name);
const snake = (pascal: string) => pascal.replace(/(?<=[a-z0-9])([A-Z])/g, "_$1").toLowerCase();

type Invocation = { program: string; instruction: string; units: number; ok: boolean; signature: string };

/** Every invocation of our programs in a transaction's logs, outermost and called alike. */
export function invocationsOf(logs: readonly string[], signature: string): Invocation[] {
  const found: Invocation[] = [];
  const stack: { program: string; instruction?: string; units?: number }[] = [];
  for (const line of logs) {
    let m: RegExpExecArray | null;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) stack.push({ program: m[1]! });
    else if ((m = /^Program log: Instruction: (\w+)$/.exec(line)) && stack.length && !stack.at(-1)!.instruction) stack.at(-1)!.instruction = snake(m[1]!);
    else if ((m = /^Program (\w+) consumed (\d+) of \d+ compute units$/.exec(line)) && stack.at(-1)?.program === m[1]) stack.at(-1)!.units = Number(m[2]);
    else if ((m = /^Program (\w+) (success|failed.*)$/.exec(line)) && stack.at(-1)?.program === m[1]) {
      const frame = stack.pop()!;
      if (PROGRAMS[frame.program] && frame.instruction && frame.units !== undefined) {
        found.push({ program: PROGRAMS[frame.program]!, instruction: frame.instruction, units: frame.units, ok: m[2] === "success", signature });
      }
    }
  }
  return found;
}

/** The signatures naming `program` from the newest back to `since`, failed ones included. */
async function signaturesSince(program: Address): Promise<Signature[]> {
  const all: Signature[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }).send();
    for (const s of page) if (s.slot >= since) all.push(s.signature);
    if (page.length < 1000 || page.at(-1)!.slot < since) return all;
    before = page.at(-1)!.signature;
  }
}

const signatures = [...new Set([...(await signaturesSince(FEE_PROGRAM_ADDRESS)), ...(await signaturesSince(FAIR_OPEN_PROGRAM_ADDRESS))])];
console.log(`${signatures.length} transactions named Heat's programs since slot ${since}`);
const invocations: Invocation[] = [];
let truncated = 0;
// A few at a time: the free tier's reads are limited per second.
for (let i = 0; i < signatures.length; i += 4) {
  const batch = await Promise.all(
    signatures.slice(i, i + 4).map(async (signature) => {
      const tx = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      const logs = tx?.meta?.logMessages ?? [];
      if (logs.some((l) => l.startsWith("Log truncated"))) truncated++;
      return invocationsOf(logs, signature);
    }),
  );
  invocations.push(...batch.flat());
  if (i % 200 === 0 && i) console.log(`read ${i} of ${signatures.length}`);
}

// The settings instructions, simulated with what is on chain now: the same values, so even a sent one would change nothing.
async function simulated(program: string, instruction: string, ix: Instruction, payer: Address): Promise<Invocation | null> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(payer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const { value } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
  const found = invocationsOf(value.logs ?? [], "simulated").find((v) => v.instruction === instruction && v.program === program);
  if (value.err || !found) {
    console.log(`simulating ${program}::${instruction} failed: ${JSON.stringify(value.err, (_, v) => (typeof v === "bigint" ? `${v}` : v))}\n  ${(value.logs ?? []).join("\n  ")}`);
    return null;
  }
  return found;
}
const keyAddress = async (file: string) =>
  (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/top-pad/devnet", file), "utf8")) as number[]))).address;
const heat = CLUSTERS.devnet!;
const authority = createNoopSigner(await keyAddress("upgrade-authority.json"));
const bank = await keyAddress("bank.json");
const feeConfig = (await fetchFeeConfig(rpc, (await findFeeConfigPda())[0])).data;
const programConfig = (await fetchProgramConfig(rpc, (await findProgramConfigPda())[0])).data;
const usdcSettings = (await fetchQuoteSettings(rpc, (await findQuoteSettingsPda({ quoteMint: DEVNET_USDC }))[0])).data;
const feeEvents = await eventAuthorityAddress(FEE_PROGRAM_ADDRESS);
const fairOpenEvents = await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS);
const simulations = await Promise.all([
  simulated(
    "fee",
    "update_fee_config",
    await getUpdateFeeConfigInstructionAsync({
      authority,
      eventAuthority: feeEvents,
      program: FEE_PROGRAM_ADDRESS,
      settings: { treasury: feeConfig.treasury, launchKey: feeConfig.launchKey, fairOpenProgram: feeConfig.fairOpenProgram },
    }),
    bank,
  ),
  simulated(
    "fair_open",
    "update_program_config",
    await getUpdateProgramConfigInstructionAsync({
      authority,
      eventAuthority: fairOpenEvents,
      program: FAIR_OPEN_PROGRAM_ADDRESS,
      settings: { admissionSigner: programConfig.admissionSigner, keeper: programConfig.keeper, feeProgram: programConfig.feeProgram, dbcConfig: programConfig.dbcConfig },
    }),
    bank,
  ),
  simulated(
    "fair_open",
    "set_quote_manager",
    await getSetQuoteManagerInstructionAsync({ authority, payer: createNoopSigner(bank), eventAuthority: fairOpenEvents, program: FAIR_OPEN_PROGRAM_ADDRESS, quoteManager: programConfig.quoteManager }),
    bank,
  ),
  simulated(
    "fair_open",
    "set_quote_settings",
    await getSetQuoteSettingsInstructionAsync({
      quoteManager: createNoopSigner(programConfig.quoteManager),
      payer: createNoopSigner(bank),
      quoteMint: DEVNET_USDC,
      fairOpenConfig: usdcSettings.fairOpenConfig,
      instantConfig: usdcSettings.instantConfig,
      referenceConfig: heat.configs!.fairOpen,
      eventAuthority: fairOpenEvents,
      program: FAIR_OPEN_PROGRAM_ADDRESS,
      step: usdcSettings.step,
    }),
    bank,
  ),
]);

type Row = { program: string; instruction: string; source: "run" | "simulated" | "none"; landed: number; refused: number; min?: number; median?: number; max?: number; example?: string };
const rows: Row[] = [];
for (const program of ["fee", "fair_open"]) {
  for (const instruction of idl(program)) {
    const ran = invocations.filter((v) => v.program === program && v.instruction === instruction);
    const ok = ran.filter((v) => v.ok).map((v) => v.units).sort((a, b) => a - b);
    const sim = simulations.find((s) => s?.program === program && s.instruction === instruction);
    const units = ok.length ? ok : sim ? [sim.units] : [];
    rows.push({
      program,
      instruction,
      source: ok.length ? "run" : sim ? "simulated" : "none",
      landed: ok.length,
      refused: ran.length - ok.length,
      ...(units.length ? { min: units[0], median: units[Math.floor(units.length / 2)], max: units.at(-1) } : {}),
      ...(ok.length ? { example: ran.find((v) => v.ok)!.signature } : {}),
    });
  }
}
const n = (v?: number) => (v === undefined ? "-" : v.toLocaleString("en-US"));
const table = [
  "| Program | Instruction | Measured from | Landed | Refused | Min CU | Median CU | Max CU |",
  "| - | - | - | -: | -: | -: | -: | -: |",
  ...rows.map((r) => `| ${r.program} | \`${r.instruction}\` | ${r.source === "run" ? "the run" : r.source === "simulated" ? "simulation" : "not measured"} | ${r.landed} | ${r.refused} | ${n(r.min)} | ${n(r.median)} | ${n(r.max)} |`),
].join("\n");
console.log(table);
if (truncated) console.log(`${truncated} transactions' logs were truncated; their inner invocations may be missing`);
const dir = process.env.ACCEPTANCE_RUN_DIR;
if (dir) {
  writeFileSync(join(dir, "compute.json"), JSON.stringify({ since: `${since}`, transactions: signatures.length, truncated, rows }, null, 2));
  writeFileSync(join(dir, "compute.md"), `${table}\n`);
}
// Every instruction but each program's one-time `initialize` must have a measure.
const missing = rows.filter((r) => r.source === "none" && r.instruction !== "initialize");
if (missing.length) {
  console.log(`not measured: ${missing.map((r) => `${r.program}::${r.instruction}`).join(", ")}`);
  process.exit(1);
}
