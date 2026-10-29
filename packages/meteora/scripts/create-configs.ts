// `pnpm --filter @top-pad/meteora configs devnet [--send]`: Heat's two DBC configs on a cluster (spec 3.2). It builds
// both `create_config2` transactions and simulates them against the cluster's deployed DBC program; with --send, and
// only once both simulations pass, it creates them. A config cannot be changed once created, so a cluster whose configs
// are already recorded in `@top-pad/chain` is refused. The payer is the Solana CLI's keypair (`SOLANA_KEYPAIR` to pick
// another); the RPC is `DEVNET_RPC_URL`, or the public endpoint (spec 10.5).
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
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getUtf8Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { CLUSTERS, FEE_CLAIMER_ADDRESS } from "@top-pad/chain";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, getCreateConfig2Instruction } from "@top-pad/clients/dbc";
import { heatConfigParameters, type LaunchMode } from "../src/configs";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/meteora configs devnet [--send] (mainnet's configs belong to the mainnet effort).");
  process.exit(1);
}
const heat = CLUSTERS[cluster]!;
if (heat.configs) {
  console.error(`${cluster} already has its configs (${heat.configs.fairOpen}, ${heat.configs.instant}); a config cannot be changed.`);
  process.exit(1);
}

const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const keypairPath = process.env.SOLANA_KEYPAIR || join(homedir(), ".config/solana/id.json");
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
const [eventAuthority] = await getProgramDerivedAddress({
  programAddress: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  seeds: [getUtf8Encoder().encode("__event_authority")],
});

const modes: LaunchMode[] = ["fairOpen", "instant"];
const built = [];
for (const mode of modes) {
  const config = await generateKeyPairSigner();
  const instruction = getCreateConfig2Instruction({
    config,
    feeClaimer: FEE_CLAIMER_ADDRESS,
    leftoverReceiver: FEE_CLAIMER_ADDRESS,
    quoteMint: heat.quote.mint,
    payer,
    eventAuthority,
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    configParameters: heatConfigParameters(mode, heat.graduationTarget),
    transferFeeParameters: null,
  });
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
  console.log(`${mode}: config ${config.address}, simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU)`);
  if (simulation.err) {
    console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    for (const line of simulation.logs ?? []) console.error(`  ${line}`);
    process.exit(1);
  }
  built.push({ mode, config: config.address, transaction });
}

if (!send) {
  console.log("Both simulations passed; nothing was sent. Run again with --send to create the configs.");
  process.exit(0);
}

const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")),
});
const before = (await rpc.getBalance(payer.address, { commitment: "confirmed" }).send()).value;
for (const { mode, config, transaction } of built) {
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirm(transaction, { commitment: "confirmed" });
  console.log(`${mode}: created ${config} in ${getSignatureFromTransaction(transaction)}`);
}
const after = (await rpc.getBalance(payer.address, { commitment: "confirmed" }).send()).value;
console.log(`Spent ${Number(before - after) / 1e9} SOL. Record both addresses in packages/chain.`);
