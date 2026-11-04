// `pnpm --filter @top-pad/chain quote-settings devnet [--send]`: names the Fair Open program's quote manager and writes
// SOL's `QuoteSettings` (ADR 0007 decision 4). The quote manager recorded in `CLUSTERS` is named by the upgrade
// authority (UPGRADE_AUTHORITY, or ~/.config/top-pad/<cluster>/upgrade-authority.json), which also grows a
// `ProgramConfig` made before the quote manager existed; then the quote manager (QUOTE_MANAGER, or
// ~/.config/top-pad/<cluster>/quote-manager.json) writes SOL's settings: Heat's two SOL configs and the 0.01 SOL step.
// Other quotes' settings are the band job's (#89); until it runs, --quote <mint> --fair-open <config> --instant <config>
// --step <raw units> writes one quote's by hand, its configs from `@top-pad/meteora`'s `configs --quote` (#88). Heat's bank pays (BANK_KEYPAIR, or ~/.config/top-pad/<cluster>/bank.json).
// It simulates each step first and sends only with --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstruction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  getAddressDecoder,
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
  fetchMaybeQuoteSettings,
  findProgramConfigPda,
  findQuoteSettingsPda,
  getSetQuoteManagerInstructionAsync,
  getSetQuoteSettingsInstructionAsync,
} from "@top-pad/clients/fair-open";
import { CLUSTERS, DEPOSIT_STEP, eventAuthorityAddress, FAIR_OPEN_PROGRAM_ADDRESS } from "../src/index";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
const option = (name: string) => {
  const at = flags.indexOf(name);
  return at >= 0 ? flags[at + 1] : undefined;
};
const other = option("--quote");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/chain quote-settings devnet [--send] (mainnet's keys belong to the mainnet effort).");
  process.exit(1);
}
const heat = CLUSTERS[cluster]!;
if (!heat.keys || !heat.configs) {
  console.error(`${cluster} has no keys or configs recorded in @top-pad/chain.`);
  process.exit(1);
}

const keyPath = (env: string | undefined, name: string) => env || join(homedir(), ".config/top-pad", cluster, `${name}.json`);
const loadSigner = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const upgradeAuthority = await loadSigner(keyPath(process.env.UPGRADE_AUTHORITY, "upgrade-authority"));
const quoteManager = await loadSigner(keyPath(process.env.QUOTE_MANAGER, "quote-manager"));
const payer = await loadSigner(keyPath(process.env.BANK_KEYPAIR, "bank"));
if (quoteManager.address !== heat.keys.quoteManager) {
  console.error(`The quote manager key is ${quoteManager.address}, but CLUSTERS.${cluster} records ${heat.keys.quoteManager}.`);
  process.exit(1);
}
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });
const eventAuthority = await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS);
const program = FAIR_OPEN_PROGRAM_ADDRESS;

/** Simulates `instruction`, the bank paying, and sends it with --send; false if it was only simulated. */
async function run(what: string, instruction: Instruction): Promise<boolean> {
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
  console.log(`${what}: simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU).`);
  if (simulation.err) {
    console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    for (const line of simulation.logs ?? []) console.error(`  ${line}`);
    process.exit(1);
  }
  if (!send) return false;
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirm(transaction, { commitment: "confirmed" });
  console.log(`${what}: ${getSignatureFromTransaction(transaction)}`);
  return true;
}

// The ProgramConfig is read raw: one made before the quote manager is 32 bytes short of what the client decodes.
const [programConfig] = await findProgramConfigPda();
const account = await fetchEncodedAccount(rpc, programConfig, { commitment: "confirmed" });
if (!account.exists) {
  console.error(`ProgramConfig ${programConfig} does not exist: run fair-open-config first.`);
  process.exit(1);
}
const QUOTE_MANAGER_OFFSET = 8 + 4 * 32 + 1;
const named = account.data.length >= QUOTE_MANAGER_OFFSET + 32 ? getAddressDecoder().decode(account.data, QUOTE_MANAGER_OFFSET) : null;
console.log(`ProgramConfig ${programConfig}: ${account.data.length} bytes, quote manager ${named ?? "none (made before it existed)"}.`);
let managerNamed = named === quoteManager.address;
if (!managerNamed) {
  const ix = await getSetQuoteManagerInstructionAsync({ authority: upgradeAuthority, payer, eventAuthority, program, quoteManager: quoteManager.address });
  managerNamed = await run(`Name the quote manager ${quoteManager.address}`, ix);
}

const quoteMint = other ? address(other) : heat.quote.mint;
const name = other ? `${quoteMint}'s` : "SOL's";
const [fairOpenArg, instantArg, stepArg] = [option("--fair-open"), option("--instant"), option("--step")];
if (other && !(fairOpenArg && instantArg && stepArg)) {
  console.error("--quote <mint> takes --fair-open <config> --instant <config> --step <raw units>.");
  process.exit(1);
}
const [quoteSettings] = await findQuoteSettingsPda({ quoteMint });
const current = await fetchMaybeQuoteSettings(rpc, quoteSettings, { commitment: "confirmed" });
const wanted = other
  ? { fairOpenConfig: address(fairOpenArg!), instantConfig: address(instantArg!), step: BigInt(stepArg!) }
  : { fairOpenConfig: heat.configs.fairOpen, instantConfig: heat.configs.instant, step: DEPOSIT_STEP };
if (current.exists) {
  const d = current.data;
  console.log(`${name} QuoteSettings ${quoteSettings}: Fair Open ${d.fairOpenConfig}, Instant ${d.instantConfig}, step ${d.step}.`);
  if (d.fairOpenConfig === wanted.fairOpenConfig && d.instantConfig === wanted.instantConfig && d.step === wanted.step) {
    console.log("They already hold the recorded settings; nothing to do.");
    process.exit(0);
  }
}
if (!managerNamed) {
  console.log(`Nothing was sent. Run again with --send to name the quote manager, then write ${name} QuoteSettings.`);
  process.exit(0);
}
const ix = await getSetQuoteSettingsInstructionAsync({
  quoteManager,
  payer,
  quoteMint,
  fairOpenConfig: wanted.fairOpenConfig,
  instantConfig: wanted.instantConfig,
  referenceConfig: heat.configs.fairOpen,
  eventAuthority,
  program,
  step: wanted.step,
});
const written = await run(`Write ${name} QuoteSettings ${quoteSettings}`, ix);
if (!written) console.log("Nothing was sent. Run again with --send to write them.");
