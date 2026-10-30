// `pnpm --filter @top-pad/chain fair-open-config devnet [--send]`: sets the Fair Open program's `ProgramConfig` (spec
// 5.3): the admission signer and the keeper recorded for the cluster in `CLUSTERS`, the fee program, and Heat's Fair
// Open config. The first run calls `initialize`, a later one `update_program_config` when the settings differ, which is
// how a leaked admission key is rotated. Both need the upgrade authority's signature, a key kept offline (spec 10.3):
// UPGRADE_AUTHORITY, or ~/.config/top-pad/<cluster>/upgrade-authority.json. Heat's bank pays the rent (BANK_KEYPAIR, or
// ~/.config/top-pad/<cluster>/bank.json). It simulates first and sends only with --send; the RPC is DEVNET_RPC_URL, or
// the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstruction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  fetchMaybeProgramConfig,
  findProgramConfigPda,
  getInitializeInstructionAsync,
  getUpdateProgramConfigInstructionAsync,
} from "@top-pad/clients/fair-open";
import { CLUSTERS, eventAuthorityAddress, FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "../src/index";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/chain fair-open-config devnet [--send] (mainnet's keys belong to the mainnet effort).");
  process.exit(1);
}
const heat = CLUSTERS[cluster]!;
if (!heat.keys || !heat.configs) {
  console.error(`${cluster} has no keys or configs recorded in @top-pad/chain.`);
  process.exit(1);
}

const loadSigner = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const upgradeAuthority = await loadSigner(process.env.UPGRADE_AUTHORITY || join(homedir(), ".config/top-pad", cluster, "upgrade-authority.json"));
const payer = await loadSigner(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster, "bank.json"));
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);

type Settings = { admissionSigner: Address; keeper: Address; feeProgram: Address; dbcConfig: Address };
const settings: Settings = {
  admissionSigner: heat.keys.admission,
  keeper: heat.keys.keeper,
  feeProgram: FEE_PROGRAM_ADDRESS,
  dbcConfig: heat.configs.fairOpen,
};
const describe = (s: Settings) => `admission signer ${s.admissionSigner}, keeper ${s.keeper}, fee program ${s.feeProgram}, config ${s.dbcConfig}`;
const [programConfig] = await findProgramConfigPda();
const current = await fetchMaybeProgramConfig(rpc, programConfig);
const eventAuthority = await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS);

let instruction: Instruction;
if (!current.exists) {
  console.log(`ProgramConfig ${programConfig} does not exist yet: initialize.`);
  instruction = await getInitializeInstructionAsync({ authority: upgradeAuthority, payer, eventAuthority, program: FAIR_OPEN_PROGRAM_ADDRESS, settings });
} else {
  console.log(`ProgramConfig ${programConfig} holds ${describe(current.data)}.`);
  const same = (Object.keys(settings) as (keyof Settings)[]).every((k) => current.data[k] === settings[k]);
  if (same) {
    console.log("It already holds the recorded settings; nothing to do.");
    process.exit(0);
  }
  instruction = await getUpdateProgramConfigInstructionAsync({ authority: upgradeAuthority, eventAuthority, program: FAIR_OPEN_PROGRAM_ADDRESS, settings });
}
console.log(`Settings: ${describe(settings)}.`);

const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
  ),
);
const { value: simulation } = await rpc
  .simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", sigVerify: true, commitment: "confirmed" })
  .send();
console.log(`Simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU).`);
if (simulation.err) {
  console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  for (const line of simulation.logs ?? []) console.error(`  ${line}`);
  process.exit(1);
}
if (!send) {
  console.log("Nothing was sent. Run again with --send to write the settings.");
  process.exit(0);
}
assertIsTransactionWithBlockhashLifetime(transaction);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });
await sendAndConfirm(transaction, { commitment: "confirmed" });
console.log(`Written in ${getSignatureFromTransaction(transaction)}.`);
