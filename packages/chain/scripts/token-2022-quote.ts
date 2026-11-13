// `pnpm --filter @top-pad/chain token-2022-quote devnet [--send]`: makes devnet's Token-2022 test quote (#91), so a coin
// priced in a Token-2022 quote runs through Graduation against Meteora's deployed programs before Meteora badges the
// stand-in xStock. DBC takes a Token-2022 quote with no TokenBadge when its only extensions are Metadata Pointer and Token
// Metadata (Meteora, "DBC Token 2022 Support"), and DBC's migration creates the DAMM v2 pool with no mint validation, so
// this mint carries exactly those two, 8 decimals as every xStock has, and no freeze authority. Every swap, claim and
// migration then names Token-2022 for the quote, as an xStock's will; the pause, the permanent delegate and the other
// issuer powers only the stand-in carries stay with the LiteSVM tests until its badge.
//
// It is for tests only: never listed in `CLUSTERS.<cluster>.quotes`, so neither the site nor the band job offers it. Heat's
// devnet bank is its mint authority and is minted 1,000,000 of it at once, so a test funds its wallets by minting rather
// than swapping. It simulates first, and sends only with --send; the mint's own key signs its creation alone and is not
// kept. The RPC is DEVNET_RPC_URL, or the public endpoint.
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
  none,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import { quoteVerdict } from "../src/quotes";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/chain token-2022-quote devnet [--send]");
  process.exit(1);
}

const DECIMALS = 8;
/** What the bank is minted at once: 1,000,000 whole tokens. */
const MINTED = 1_000_000n * 10n ** BigInt(DECIMALS);

const bank = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster, "bank.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });

const mint = await generateKeyPairSigner();
const metadata: ExtensionArgs = {
  __kind: "TokenMetadata",
  updateAuthority: some(bank.address),
  mint: mint.address,
  name: "Heat Token-2022 test quote",
  symbol: "T22Q",
  uri: "",
  additionalMetadata: new Map(),
};
const extensions: ExtensionArgs[] = [{ __kind: "MetadataPointer", authority: some(bank.address), metadataAddress: some(mint.address) }];

// The account is made the size of the extensions set before the mint is initialized; Token Metadata, set after it,
// grows the account, so its rent is paid up front. Rent is asked of the cluster, never hard-coded (CLAUDE.md, Traps).
const space = getMintSize(extensions);
const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize([...extensions, metadata]))).send();
const [bankAccount] = await findAssociatedTokenPda({ owner: bank.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
const instructions = [
  getCreateAccountInstruction({ payer: bank, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
  ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
  getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: bank.address, freezeAuthority: none() }),
  ...getPostInitializeInstructionsForMintExtensions(mint.address, bank, [metadata]),
  getCreateAssociatedTokenIdempotentInstruction({ payer: bank, ata: bankAccount, owner: bank.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  getMintToCheckedInstruction({ mint: mint.address, token: bankAccount, mintAuthority: bank, amount: MINTED, decimals: DECIMALS }),
];

const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(bank, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  ),
);
const wire = getBase64EncodedWireTransaction(transaction);
const { value: simulation } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send();
console.log(
  `The Token-2022 test quote ${mint.address}: simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU, ` +
    `${Buffer.from(wire, "base64").length} bytes, ${lamports} lamports of rent).`,
);
if (simulation.err) {
  console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  for (const line of simulation.logs ?? []) console.error(`  ${line}`);
  process.exit(1);
}
if (!send) {
  console.log("Nothing was sent. Run again with --send to make it.");
  process.exit(0);
}
assertIsTransactionWithBlockhashLifetime(transaction);
await sendAndConfirm(transaction, { commitment: "confirmed" });
console.log(`Created: ${getSignatureFromTransaction(transaction)}`);

// Read it back: DBC must take it with no badge, and Heat's rules must take it.
const created = await fetchMint(rpc, mint.address, { commitment: "confirmed" });
const verdict = quoteVerdict({ address: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: created.data, tokenBadge: false });
console.log(`Extensions: ${verdict.extensions.join(", ")}`);
console.log(verdict.dbcAccepts && verdict.accepted ? "DBC takes it with no badge, and so does Heat." : `Refused: ${verdict.refusals.join(", ")}`);
console.log(`Put ${mint.address} in DEVNET_TOKEN_2022_TEST_QUOTE.`);
