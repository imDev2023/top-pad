// `pnpm --filter @top-pad/chain xstock-multiplier devnet <multiplier> [--send]`: sets devnet's stand-in xStock's Scaled
// UI Amount multiplier, effective at once, as an xStock's issuer does on a split or a dividend (ADR 0007 decision 5), so
// a run can watch every page read the new multiplier and no chart step. Heat's devnet bank holds the multiplier
// authority (`xstock-stand-in`) and pays. It simulates first, and sends only with --send; then it reads the mint back.
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
} from "@solana/kit";
import { fetchMint, getUpdateMultiplierScaledUiMintInstruction } from "@solana-program/token-2022";
import { DEVNET_XSTOCK_STAND_IN, TOKEN_2022_PROGRAM_ADDRESS, displayMultiplier, quoteVerdict } from "../src/quotes";

const [cluster, value, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
const multiplier = Number(value);
if (cluster !== "devnet" || !Number.isFinite(multiplier) || multiplier <= 0) {
  console.error("Usage: pnpm --filter @top-pad/chain xstock-multiplier devnet <multiplier> [--send]");
  process.exit(1);
}

const bank = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster, "bank.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });

const readMultiplier = async () => {
  const mint = await fetchMint(rpc, DEVNET_XSTOCK_STAND_IN, { commitment: "confirmed" });
  const verdict = quoteVerdict({ address: DEVNET_XSTOCK_STAND_IN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: mint.data, tokenBadge: true });
  return displayMultiplier(verdict.powers, BigInt(Math.floor(Date.now() / 1000)));
};
console.log(`The stand-in xStock ${DEVNET_XSTOCK_STAND_IN} shows its amounts through ${await readMultiplier()} now.`);

// Effective now: Token-2022 takes a timestamp at or before the chain's clock as at once.
const instruction = getUpdateMultiplierScaledUiMintInstruction({ mint: DEVNET_XSTOCK_STAND_IN, authority: bank, multiplier, effectiveTimestamp: 0n });
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(bank, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
  ),
);
const wire = getBase64EncodedWireTransaction(transaction);
const { value: simulation } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send();
console.log(`Setting it to ${multiplier}: simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU).`);
if (simulation.err) {
  console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  for (const line of simulation.logs ?? []) console.error(`  ${line}`);
  process.exit(1);
}
if (!send) {
  console.log("Nothing was sent. Run again with --send to set it.");
  process.exit(0);
}
assertIsTransactionWithBlockhashLifetime(transaction);
await sendAndConfirm(transaction, { commitment: "confirmed" });
console.log(`Set: ${getSignatureFromTransaction(transaction)}; it shows its amounts through ${await readMultiplier()} now.`);
