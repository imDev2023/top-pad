// `pnpm --filter @top-pad/chain fee-config devnet [--send]`: sets Heat's settings in the fee program (spec 5.2): the
// treasury and the launch key recorded for the cluster in `CLUSTERS`, and the Fair Open program. The first run calls
// `initialize`, a later one `update_fee_config` when the settings differ, which is how a lost launch key is rotated.
// Both need the upgrade authority's signature, a key kept offline (spec 10.3): UPGRADE_AUTHORITY, or
// ~/.config/top-pad/<cluster>/upgrade-authority.json. The Solana CLI's keypair pays the rent (SOLANA_KEYPAIR to pick
// another). It simulates first and sends only with --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
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
  type Instruction,
} from "@solana/kit";
import {
  FEE_PROGRAM_ADDRESS,
  fetchMaybeFeeConfig,
  findFeeConfigPda,
  getInitializeInstructionAsync,
  getUpdateFeeConfigInstructionAsync,
} from "@top-pad/clients/fee";
import { CLUSTERS, eventAuthorityAddress, FAIR_OPEN_PROGRAM_ADDRESS } from "../src/index";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/chain fee-config devnet [--send] (mainnet's keys belong to the mainnet effort).");
  process.exit(1);
}
const keys = CLUSTERS[cluster]!.keys;
if (!keys) {
  console.error(`${cluster} has no treasury or keeper recorded in @top-pad/chain.`);
  process.exit(1);
}

const loadSigner = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const upgradeAuthority = await loadSigner(process.env.UPGRADE_AUTHORITY || join(homedir(), ".config/top-pad", cluster, "upgrade-authority.json"));
const payer = await loadSigner(process.env.SOLANA_KEYPAIR || join(homedir(), ".config/solana/id.json"));
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);

const settings = { treasury: keys.treasury, launchKey: keys.keeper, fairOpenProgram: FAIR_OPEN_PROGRAM_ADDRESS };
const [feeConfig] = await findFeeConfigPda();
const current = await fetchMaybeFeeConfig(rpc, feeConfig);
const eventAuthority = await eventAuthorityAddress(FEE_PROGRAM_ADDRESS);

let instruction: Instruction;
if (!current.exists) {
  console.log(`FeeConfig ${feeConfig} does not exist yet: initialize.`);
  instruction = await getInitializeInstructionAsync({ authority: upgradeAuthority, payer, eventAuthority, program: FEE_PROGRAM_ADDRESS, settings });
} else {
  const { treasury, launchKey, fairOpenProgram } = current.data;
  console.log(`FeeConfig ${feeConfig} holds treasury ${treasury}, launch key ${launchKey}, Fair Open program ${fairOpenProgram}.`);
  if (treasury === settings.treasury && launchKey === settings.launchKey && fairOpenProgram === settings.fairOpenProgram) {
    console.log("It already holds the recorded settings; nothing to do.");
    process.exit(0);
  }
  instruction = await getUpdateFeeConfigInstructionAsync({ authority: upgradeAuthority, eventAuthority, program: FEE_PROGRAM_ADDRESS, settings });
}
console.log(`Settings: treasury ${settings.treasury}, launch key ${settings.launchKey}, Fair Open program ${settings.fairOpenProgram}.`);

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
