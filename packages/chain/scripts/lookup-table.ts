// `pnpm --filter @top-pad/chain lookup-table devnet [--refresh] [--send]`: makes Heat's shared address lookup table
// (spec 2.1 step 10), which every open's creation transaction and every push compresses its common accounts through: it
// creates the table with every address `fairOpenLookupTableAddresses` lists, then freezes it, so no one can ever change
// what a signed rung's lookups resolve to. A frozen table is never changed, so a new address means a new table:
// --refresh makes one beside the cluster's current table, which every rung already signed keeps naming and which stays
// on chain, frozen; the new one must hold every address the current one does (#88 added Token-2022 and the quotes). Heat's bank pays and holds the table's authority until the freeze (BANK_KEYPAIR, or
// ~/.config/top-pad/<cluster>/bank.json). It prints the table's address, which goes into `CLUSTERS`. It simulates first
// and sends only with --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
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
const refresh = flags.includes("--refresh");
const heat = cluster === "devnet" ? CLUSTERS.devnet : null;
if (!heat?.configs) {
  console.error("Usage: pnpm --filter @top-pad/chain lookup-table devnet [--refresh] [--send]");
  process.exit(1);
}
if (heat.lookupTable && !refresh) {
  console.error(`${cluster} has its lookup table already, ${heat.lookupTable}; a frozen table is never replaced lightly (--refresh).`);
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
if (heat.lookupTable) {
  const current = await fetchAddressLookupTable(rpc, heat.lookupTable, { commitment: "confirmed" });
  const missing = current.data.addresses.filter((a) => !addresses.includes(a));
  if (missing.length > 0) throw new Error(`the new table would leave out ${missing.join(", ")}, which ${heat.lookupTable} holds`);
  const added = addresses.filter((a) => !current.data.addresses.includes(a));
  if (added.length === 0) {
    console.log(`${heat.lookupTable} holds every address already; nothing to refresh.`);
    process.exit(0);
  }
  console.log(`Refreshing ${heat.lookupTable}, adding ${added.length}: ${added.join(", ")}`);
}
// A table's address commits to a recent slot the program finds in the SlotHashes sysvar, newest first: one a few entries
// back (each a slot and a hash, after the list's length), so a node of the endpoint that trails the others has it too.
const slotHashes = await fetchEncodedAccount(rpc, address("SysvarS1otHashes111111111111111111111111111"), { commitment: "confirmed" });
if (!slotHashes.exists) throw new Error("no SlotHashes sysvar");
const recentSlot = new DataView(slotHashes.data.buffer, slotHashes.data.byteOffset).getBigUint64(8 + 40 * 8, true);
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
