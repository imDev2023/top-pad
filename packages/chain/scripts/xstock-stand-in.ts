// `pnpm --filter @top-pad/chain xstock-stand-in devnet [--send]`: makes devnet's stand-in xStock (ADR 0007, spec 11.2),
// since devnet has no xStocks. It is a Token-2022 mint with exactly NVDAx's extensions as mainnet held them on
// 2026-11-03 (`src/fixtures/xstock-nvdax.json`, the same set all 1,476 badged xStocks carry): Metadata Pointer to itself,
// Permanent Delegate, Default Account State Initialized, Scaled UI Amount, Pausable, Confidential Transfer (no
// auto-approve, no auditor), a Transfer Hook naming no program, Token Metadata, and 8 decimals. Heat's devnet bank holds
// every authority the issuer holds on mainnet (mint, freeze, pause, permanent delegate, multiplier, metadata, hook), so
// the tests can pause it, change its multiplier and move tokens out of any account, as the issuer can.
//
// DBC accepts it as a quote only once Meteora creates its devnet TokenBadge, on request in ticket `devlaunch-6428` (#26):
// the request needs this mint's address, so the mint comes first. It simulates first, and sends only with --send; the
// mint's own key signs its creation alone and is not kept. The RPC is DEVNET_RPC_URL, or the public endpoint.
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
  address,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AccountState,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  getInitializeMint2Instruction,
  getMintSize,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import { quoteVerdict } from "../src/quotes";

const [cluster, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet") {
  console.error("Usage: pnpm --filter @top-pad/chain xstock-stand-in devnet [--send]");
  process.exit(1);
}

const bank = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad", cluster, "bank.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });

const mint = await generateKeyPairSigner();
const issuer = bank.address;
const NO_PROGRAM = address("11111111111111111111111111111111");
const metadata: ExtensionArgs = {
  __kind: "TokenMetadata",
  updateAuthority: some(issuer),
  mint: mint.address,
  name: "Heat stand-in xStock",
  symbol: "STANDx",
  uri: "",
  additionalMetadata: new Map(),
};
// In NVDAx's order, which is the order Token-2022 lays them out in.
const extensions: ExtensionArgs[] = [
  { __kind: "MetadataPointer", authority: some(issuer), metadataAddress: some(mint.address) },
  { __kind: "PermanentDelegate", delegate: issuer },
  { __kind: "DefaultAccountState", state: AccountState.Initialized },
  { __kind: "ScaledUiAmountConfig", authority: issuer, multiplier: 1, newMultiplierEffectiveTimestamp: 0n, newMultiplier: 1 },
  { __kind: "PausableConfig", authority: some(issuer), paused: false },
  { __kind: "ConfidentialTransferMint", authority: some(issuer), autoApproveNewAccounts: false, auditorElgamalPubkey: none() },
  { __kind: "TransferHook", authority: issuer, programId: NO_PROGRAM },
];

// The account is made the size of the extensions set before the mint is initialized; Token Metadata, set after it,
// grows the account, so its rent is paid up front. Rent is asked of the cluster, never hard-coded (CLAUDE.md, Traps).
const space = getMintSize(extensions);
const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize([...extensions, metadata]))).send();
const instructions = [
  getCreateAccountInstruction({ payer: bank, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
  ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
  getInitializeMint2Instruction({ mint: mint.address, decimals: 8, mintAuthority: issuer, freezeAuthority: some(issuer) }),
  ...getPostInitializeInstructionsForMintExtensions(mint.address, bank, [metadata]),
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
  `The stand-in xStock ${mint.address}: simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU, ` +
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

// Read it back and check it against the rules a quote must pass, as a badged mint: the badge is the one thing missing.
const created = await fetchMint(rpc, mint.address, { commitment: "confirmed" });
const verdict = quoteVerdict({ address: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: created.data, tokenBadge: true });
console.log(`Extensions: ${verdict.extensions.join(", ")}`);
console.log(verdict.accepted ? "It passes every quote rule once badged." : `It fails the quote rules: ${verdict.refusals.join(", ")}`);
console.log(`Put ${mint.address} in DEVNET_XSTOCK_STAND_IN, and ask Meteora for its devnet DBC TokenBadge.`);
