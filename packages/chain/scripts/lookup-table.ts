// `pnpm --filter @top-pad/chain lookup-table devnet [--send]`: makes Heat's shared address lookup table (spec 2.1 step
// 10), which every open's creation transaction and every push compresses its common accounts through: it creates the
// table with every address `fairOpenLookupTableAddresses` lists, then freezes it, so no one can ever change what a signed
// rung's lookups resolve to. Heat's bank pays and holds the table's authority until the freeze (BANK_KEYPAIR, or
// ~/.config/top-pad/<cluster>/bank.json). It prints the table's address, which goes into `CLUSTERS`. It simulates first
// and sends only with --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
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
  type KeyPairSigner,
} from "@solana/kit";
import {
  fetchAddressLookupTable,
  findAddressLookupTablePda,
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
  getFreezeLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { CLUSTERS, fairOpenLookupTableAddresses } from "../src/index";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
const heat = cluster === "devnet" ? CLUSTERS.devnet : null;
if (!heat?.configs) {
  console.error("Usage: pnpm --filter @top-pad/chain lookup-table devnet [--send]");
  process.exit(1);
}
if (heat.lookupTable) {
  console.error(`${cluster} has its lookup table already, ${heat.lookupTable}; a frozen table is never replaced lightly.`);
  process.exit(1);
}

const bank = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster!, "bank.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });

/** Simulates a transaction of `instructions`, the bank paying, and sends it with --send. */
async function run(what: string, payer: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
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
  if (!send) return;
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirm(transaction, { commitment: "confirmed" });
  console.log(`${what}: ${getSignatureFromTransaction(transaction)}`);
}

const addresses = await fairOpenLookupTableAddresses(heat);
const recentSlot = await rpc.getSlot({ commitment: "finalized" }).send();
const [table] = await findAddressLookupTablePda({ authority: bank.address, recentSlot });
console.log(`The lookup table ${table}, holding ${addresses.length} addresses:`);
for (const a of addresses) console.log(`  ${a}`);
await run("create and extend", bank, [
  await getCreateLookupTableInstructionAsync({ authority: bank, payer: bank, recentSlot }),
  getExtendLookupTableInstruction({ address: table, authority: bank, payer: bank, addresses }),
]);
if (!send) {
  console.log("Nothing was sent. Run again with --send to make and freeze it.");
  process.exit(0);
}
await run("freeze", bank, [getFreezeLookupTableInstruction({ address: table, authority: bank })]);
const frozen = await fetchAddressLookupTable(rpc, table, { commitment: "confirmed" });
if (frozen.data.authority.__option !== "None" || frozen.data.addresses.length !== addresses.length) {
  throw new Error(`the table did not freeze with every address: ${JSON.stringify(frozen.data, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`);
}
console.log(`Frozen with ${frozen.data.addresses.length} addresses. Put ${table} in CLUSTERS.${cluster}.lookupTable.`);
