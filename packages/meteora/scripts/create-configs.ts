// `pnpm --filter @top-pad/meteora configs devnet [--rehearsal] [--send]`: Heat's two DBC configs on a cluster (spec
// 3.2). It builds both `create_config2` transactions and simulates them against the cluster's deployed DBC program; with
// --send, and only once both simulations pass, it creates them. A config cannot be changed once created, so a cluster
// whose configs are already recorded in `@top-pad/chain` is refused. With --rehearsal it builds devnet's rehearsal
// config instead: the Instant config's every value but its Graduation Target, `REHEARSAL_GRADUATION_TARGET`, so
// `tests/devnet` graduates coins for a few hundredths of a SOL rather than 8.5 (spec 11.4). With --quote <mint>
// --target <raw units> it builds a Fair Open and Instant pair in another quote at that Graduation Target, every other
// setting the SOL configs' (ADR 0007, #88), for its `QuoteSettings` (`quote-settings --quote`); the addresses live there,
// on chain, not in `@top-pad/chain`, and the band job makes such pairs as prices move (#89). The payer is Heat's bank (`BANK_KEYPAIR`, or
// ~/.config/top-pad/<cluster>/bank.json); the RPC is `DEVNET_RPC_URL`, or the public endpoint (spec 10.5).
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
import { CLUSTERS, FEE_CLAIMER_ADDRESS, REHEARSAL_GRADUATION_TARGET } from "@top-pad/chain";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, getCreateConfig2Instruction } from "@top-pad/clients/dbc";
import { heatConfigParameters, type LaunchMode } from "../src/configs";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
const rehearsal = flags.includes("--rehearsal");
const option = (name: string) => {
  const at = flags.indexOf(name);
  return at >= 0 ? flags[at + 1] : undefined;
};
const otherQuote = option("--quote");
const otherTarget = option("--target");
if ((otherQuote === undefined) !== (otherTarget === undefined) || (otherQuote && rehearsal)) {
  console.error("--quote <mint> takes --target <raw units>, and neither goes with --rehearsal.");
  process.exit(1);
}
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/meteora configs devnet [--rehearsal] [--send] (mainnet's configs belong to the mainnet effort).");
  process.exit(1);
}
const heat = CLUSTERS[cluster]!;
if (!otherQuote && (rehearsal ? heat.rehearsal : heat.configs)) {
  console.error(`${cluster} already has ${rehearsal ? "its rehearsal config" : "its configs"}; a config cannot be changed.`);
  process.exit(1);
}

const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const keypairPath = process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster, "bank.json");
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
const [eventAuthority] = await getProgramDerivedAddress({
  programAddress: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  seeds: [getUtf8Encoder().encode("__event_authority")],
});

const modes: LaunchMode[] = rehearsal ? ["instant"] : ["fairOpen", "instant"];
const target = otherTarget ? BigInt(otherTarget) : rehearsal ? REHEARSAL_GRADUATION_TARGET : heat.graduationTarget;
const quoteMint = otherQuote ? address(otherQuote) : heat.quote.mint;
console.log(`Configs in ${quoteMint} at a Graduation Target of ${target} raw units.`);
const built = [];
for (const mode of modes) {
  const config = await generateKeyPairSigner();
  const instruction = getCreateConfig2Instruction({
    config,
    feeClaimer: FEE_CLAIMER_ADDRESS,
    leftoverReceiver: FEE_CLAIMER_ADDRESS,
    quoteMint,
    payer,
    eventAuthority,
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    configParameters: heatConfigParameters(mode, target),
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
  console.log("The simulations passed; nothing was sent. Run again with --send to create the configs.");
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
const record = otherQuote ? "Write both into the quote's QuoteSettings (quote-settings --quote)." : `Record ${rehearsal ? "the address" : "both addresses"} in packages/chain.`;
console.log(`Spent ${Number(before - after) / 1e9} SOL. ${record}`);
