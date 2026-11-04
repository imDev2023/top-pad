// `pnpm --filter @top-pad/chain devnet-usdc devnet <SOL> [--send]`: buys Circle's devnet USDC for Heat's devnet bank,
// for the tests of Fair Opens in a quote other than SOL (ADR 0007, #88). Circle's faucet asks a person to solve a
// captcha, so the bank swaps some of its SOL through Meteora's deepest devnet DAMM v2 pool of SOL and USDC instead, at
// whatever price devnet's pools hold (about 10 USDC a SOL on 2026-11-04): it wraps the SOL, swaps it, and unwraps what is
// left. The bank pays (BANK_KEYPAIR, or ~/.config/top-pad/devnet/bank.json). It simulates first and sends only with
// --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { CP_AMM_PROGRAM_ADDRESS, getPoolDecoder, getPoolSize, getSwapInstruction, type Pool } from "@top-pad/clients/damm-v2";
import { DEVNET_USDC, eventAuthorityAddress, TOKEN_PROGRAM_ADDRESS, WSOL_MINT } from "../src/index";

const [cluster, sol, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
if (cluster !== "devnet" || !sol || !(Number(sol) > 0 && Number(sol) <= 1)) {
  console.error("Usage: pnpm --filter @top-pad/chain devnet-usdc devnet <SOL, at most 1> [--send]");
  process.exit(1);
}
const lamports = BigInt(Math.round(Number(sol) * 1e9));

const bank = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad/devnet/bank.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);

// Every DAMM v2 pool of SOL and USDC, either way round (`Pool`: the discriminator, its fees, then token A's and B's mints).
const MINTS_AT = 8 + 160;
const pools: { address: Address; pool: Pool }[] = [];
for (const [a, b] of [
  [WSOL_MINT, DEVNET_USDC],
  [DEVNET_USDC, WSOL_MINT],
]) {
  const found = await rpc
    .getProgramAccounts(CP_AMM_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getPoolSize()) },
        { memcmp: { offset: BigInt(MINTS_AT), bytes: a as string as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: BigInt(MINTS_AT + 32), bytes: b as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  for (const p of found) pools.push({ address: p.pubkey, pool: getPoolDecoder().decode(getBase64Encoder().encode(p.account.data[0])) });
}
const usdcVault = (p: (typeof pools)[number]) => (p.pool.tokenAMint === DEVNET_USDC ? p.pool.tokenAVault : p.pool.tokenBVault);
const held = await Promise.all(pools.map(async (p) => (await rpc.getTokenAccountBalance(usdcVault(p), { commitment: "confirmed" }).send()).value));
const deepest = pools.map((p, i) => ({ ...p, usdc: BigInt(held[i]!.amount) })).sort((x, y) => (y.usdc > x.usdc ? 1 : -1))[0];
if (!deepest) throw new Error("devnet has no DAMM v2 pool of SOL and USDC");
const { pool } = deepest;
const solIsA = pool.tokenAMint === WSOL_MINT;
// The price of SOL in USDC's raw units a lamport, from the pool's square-root price (Q64.64, B in A).
const sqrt = Number(pool.sqrtPrice) / 2 ** 64;
const usdcPerLamport = solIsA ? sqrt * sqrt : 1 / (sqrt * sqrt);
const expected = BigInt(Math.floor(Number(lamports) * usdcPerLamport));
console.log(`The deepest pool ${deepest.address} holds ${Number(deepest.usdc) / 1e6} USDC, at ${(usdcPerLamport * 1e3).toFixed(4)} USDC a SOL.`);
console.log(`Swapping ${sol} SOL for about ${Number(expected) / 1e6} USDC, at least ${Number((expected * 8n) / 10n) / 1e6}.`);

const tokens = { tokenProgram: TOKEN_PROGRAM_ADDRESS };
const [wsol] = await findAssociatedTokenPda({ owner: bank.address, mint: WSOL_MINT, ...tokens });
const [usdc] = await findAssociatedTokenPda({ owner: bank.address, mint: DEVNET_USDC, ...tokens });
const instructions = [
  getCreateAssociatedTokenIdempotentInstruction({ payer: bank, ata: wsol, owner: bank.address, mint: WSOL_MINT }),
  getTransferSolInstruction({ source: bank, destination: wsol, amount: lamports }),
  getSyncNativeInstruction({ account: wsol }),
  getCreateAssociatedTokenIdempotentInstruction({ payer: bank, ata: usdc, owner: bank.address, mint: DEVNET_USDC }),
  getSwapInstruction({
    pool: deepest.address,
    inputTokenAccount: wsol,
    outputTokenAccount: usdc,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    payer: bank,
    tokenAProgram: TOKEN_PROGRAM_ADDRESS,
    tokenBProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: await eventAuthorityAddress(CP_AMM_PROGRAM_ADDRESS),
    program: CP_AMM_PROGRAM_ADDRESS,
    amountIn: lamports,
    minimumAmountOut: (expected * 8n) / 10n,
  }),
  getCloseAccountInstruction({ account: wsol, destination: bank.address, owner: bank }),
];

const balance = async (account: Address) =>
  BigInt((await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }))).value.amount);
const before = await balance(usdc);
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(bank, m),
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
  console.log("Nothing was sent. Run again with --send to swap.");
  process.exit(0);
}
// Confirmed over HTTP: a WebSocket subscription to some devnet endpoints never answers (2026-11-04).
const signature = getSignatureFromTransaction(transaction);
await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
for (let i = 0; ; i++) {
  const { value } = await rpc.getSignatureStatuses([signature]).send();
  if (value[0]?.err) throw new Error(`the swap failed: ${JSON.stringify(value[0].err)}`);
  if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
  if (i > 60) throw new Error(`the swap ${signature} did not confirm within a minute`);
  await new Promise((r) => setTimeout(r, 1_000));
}
const after = await balance(usdc);
console.log(`Swapped: ${signature}. The bank holds ${Number(after) / 1e6} USDC (${Number(after - before) / 1e6} more).`);
