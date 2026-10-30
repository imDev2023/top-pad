// `pnpm --filter @top-pad/chain fair-open devnet [--in <seconds>] [--min-raise <SOL>] [--send]`: schedules a Fair Open by
// script, as this build does until the creator's scheduling flow exists (spec 14, slice 4): its window opens `--in`
// seconds from now (60 by default; down to -599, a window already running) and runs 10 minutes, with an optional minimum
// raise. Its coin is a made-up test coin sealed behind its hash. The Solana CLI's keypair is the creator, signing and
// paying the rent (SOLANA_KEYPAIR to pick another); our keeper co-signs and holds the nonce (KEEPER_KEYPAIR, or
// ~/.config/top-pad/<cluster>/keeper.json). It simulates first and sends only with --send; the RPC is DEVNET_RPC_URL, or
// the public endpoint.
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
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { CLUSTERS, createLaunchInstructions, fairOpenAccounts, identityHash, NONCE_ACCOUNT_SPACE } from "../src/index";

const [cluster, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const send = args.includes("--send");
const heat = cluster === "devnet" ? CLUSTERS.devnet : null;
if (!heat?.configs) {
  console.error("Usage: pnpm --filter @top-pad/chain fair-open devnet [--in <seconds>] [--min-raise <SOL>] [--send]");
  process.exit(1);
}
const opensIn = BigInt(flag("--in") ?? "60");
const minRaise = BigInt(Math.round(Number(flag("--min-raise") ?? "0") * 1e9));

const loadSigner = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const creator = await loadSigner(process.env.SOLANA_KEYPAIR || join(homedir(), ".config/solana/id.json"));
const keeper = await loadSigner(process.env.KEEPER_KEYPAIR || join(homedir(), ".config/top-pad", cluster!, "keeper.json"));
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);

const nonce = await generateKeyPairSigner();
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
const coin = { name: `Sealed test ${tag}`, ticker: `S${tag}`, uri: `https://turbo-gateway.com/sealed-test-${tag.toLowerCase()}` };
const depositsOpenAt = BigInt(Math.floor(Date.now() / 1000)) + opensIn;
const instructions = await createLaunchInstructions({
  creator,
  keeper,
  nonce,
  nonceRent: await rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SPACE).send(),
  dbcConfig: heat.configs.fairOpen,
  depositsOpenAt,
  minRaise,
  identityHash: await identityHash(coin),
  computeUnitPrice: 0n,
});
const { launch } = await fairOpenAccounts(nonce.address);
const at = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000", "");
console.log(`Fair Open ${launch}, by ${creator.address}, nonce ${nonce.address}.`);
console.log(`Window ${at(depositsOpenAt)} to ${at(depositsOpenAt + 600n)}; late, and failable by anyone, from ${at(depositsOpenAt + 1500n)}.`);
console.log(`Minimum raise ${Number(minRaise) / 1e9} SOL. Sealed coin: ${coin.name} (${coin.ticker}), ${coin.uri}.`);

const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(creator, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
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
  console.log("Nothing was sent. Run again with --send to schedule it.");
  process.exit(0);
}
assertIsTransactionWithBlockhashLifetime(transaction);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });
await sendAndConfirm(transaction, { commitment: "confirmed" });
console.log(`Scheduled in ${getSignatureFromTransaction(transaction)}.`);
console.log(`Its page: https://top-pad-web-devnet.imdev2023.workers.dev/fair-open/${launch}`);
