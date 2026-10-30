// Devnet for the tests that trade on it (here and tests/ui): wallets funded from Heat's devnet bank, swaps on a Heat
// coin's pool, and a pool created straight on Heat's Instant config, around the launch flow. Every call spends real
// devnet SOL.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type RpcTransport,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { fetchSysvarClock } from "@solana/sysvars";
import { CLUSTERS, dbcPoolAddress, FEE_PROGRAM_ADDRESS, instantLaunchInstructions, swapInstructions } from "@top-pad/chain";
import { fetchRawTransaction, type RawTransaction } from "@top-pad/indexer";

export const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
export const devnet = CLUSTERS.devnet!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The RPC, every call retried while the endpoint answers 429: the public endpoint's per-IP budget is shared with every
 * other session on this Mac, so a run must wait its turn rather than fail.
 */
const http = createDefaultRpcTransport({ url: rpcUrl });
const patient: RpcTransport = async (request) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await http(request);
    } catch (e) {
      const limited = isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
      if (!limited || attempt >= 8) throw e;
      await sleep(Math.min(500 * 2 ** attempt, 8_000));
    }
  }
};
export const rpc = createSolanaRpcFromTransport(patient);

/**
 * Sends a transaction of `instructions`, `payer` paying and every signer they name signing; its signature once confirmed.
 * Confirmation is polled over HTTP, since the public endpoint's WebSocket refuses connections at times; a signed
 * transaction can be sent again safely, since it lands at most once, so a send that fails is simply retried.
 */
export async function send(payer: TransactionSigner, instructions: Instruction[]): Promise<string> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
  for (let poll = 1; ; poll++) {
    await sleep(poll === 1 ? 400 : 1_000);
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    // A blockhash lives about a minute: the transaction's expiry need not be asked about on every poll.
    if (poll % 10 === 0 && (await rpc.getBlockHeight({ commitment: "confirmed" }).send()) > lifetime.lastValidBlockHeight) {
      throw new Error(`transaction ${signature} expired unconfirmed`);
    }
  }
}

/**
 * Heat's devnet bank (~/.config/top-pad/devnet/bank.json), which the owner keeps in devnet SOL and which pays for every
 * test, never the Solana CLI's own wallet (CLAUDE.md).
 */
export const bankFile = join(homedir(), ".config/top-pad/devnet/bank.json");
export const bank = () => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(bankFile, "utf8"))));

/** New wallets funded in one transaction from the bank, one per amount of lamports, in order. */
export async function fundedWallets<T extends bigint[]>(...lamports: T): Promise<{ [K in keyof T]: KeyPairSigner }> {
  const from = await bank();
  const wallets = await Promise.all(lamports.map(() => generateKeyPairSigner()));
  await send(from, wallets.map((w, i) => getTransferSolInstruction({ source: from, destination: w.address, amount: lamports[i]! })));
  return wallets as { [K in keyof T]: KeyPairSigner };
}

/** Sends what is left in throwaway wallets back to the bank, so a run keeps only what it spent. */
export async function sweep(...wallets: KeyPairSigner[]) {
  const to = await bank();
  for (const wallet of wallets) {
    const { value: balance } = await rpc.getBalance(wallet.address, { commitment: "confirmed" }).send();
    // What a transfer's own fee leaves; a wallet holding less is left as it is.
    const amount = balance - 5_000n;
    if (amount > 0n) await send(wallet, [getTransferSolInstruction({ source: wallet, destination: to.address, amount })]);
  }
}

/** An exact-in swap on a coin's pool on the Instant config; its signature once confirmed. */
export async function swap(trader: KeyPairSigner, mint: Address, side: "buy" | "sell", amountIn: bigint): Promise<string> {
  const config = devnet.configs!.instant;
  const pool = await dbcPoolAddress(config, mint, devnet.quote.mint);
  return send(trader, await swapInstructions({ config, pool, mint, quoteMint: devnet.quote.mint, trader, side, amountIn, minimumOut: 1n }));
}

/** The coins a wallet holds of a mint, in raw units. */
export async function coinBalance(owner: Address, mint: Address): Promise<bigint> {
  const { value } = await rpc.getTokenAccountsByOwner(owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }).send();
  return value.reduce((sum, a) => sum + BigInt((a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), 0n);
}

/**
 * A pool created straight on Heat's Instant config by a stranger, without the launch key or the fee program's record:
 * what anyone can do (spec 2.4). Its page must say it was not launched through Heat.
 */
export async function poolAroundHeat(creator: KeyPairSigner): Promise<{ mint: Address; pool: Address }> {
  const mint = await generateKeyPairSigner();
  const launch = {
    config: devnet.configs!.instant,
    quoteMint: devnet.quote.mint,
    creator,
    mint,
    // Never signs: its only instruction, the fee program's record, is left out.
    launchKey: creator,
    coin: { name: "Around Heat", ticker: "AROUND", uri: "https://example.com/around-heat.json" },
    computeUnitPrice: 0n,
  };
  const instructions = (await instantLaunchInstructions(launch)).filter((ix) => ix.programAddress !== FEE_PROGRAM_ADDRESS);
  await send(creator, instructions);
  return { mint: mint.address, pool: await dbcPoolAddress(launch.config, mint.address, launch.quoteMint) };
}

/**
 * The chain's clock now, as programs read it: the Clock sysvar at the latest confirmed slot. Not that slot's block time,
 * which the public endpoint at times cannot serve yet ("Block not available for slot").
 */
export async function chainTime(): Promise<bigint> {
  return (await fetchSysvarClock(rpc, { commitment: "confirmed" })).unixTimestamp;
}

/**
 * A landed transaction as the RPC serves it, asked again while it is not served yet or the public endpoint answers
 * 429, whose per-IP budget every session on this Mac shares.
 */
export async function landed(signature: string): Promise<RawTransaction> {
  for (let attempt = 0; ; attempt++) {
    const raw = await fetchRawTransaction(rpcUrl, signature).catch((e: Error) => {
      if (!/429/.test(e.message) || attempt > 8) throw e;
      return null;
    });
    if (raw) return raw;
    if (attempt > 12) throw new Error(`${signature} was not served`);
    await sleep(Math.min(1_000 * 2 ** Math.min(attempt, 3), 8_000));
  }
}

/** What one of our programs used of a landed transaction's compute: the last of its log lines is the instruction's own. */
export async function programCompute(signature: string, program: Address): Promise<number> {
  const pattern = new RegExp(`^Program ${program} consumed (\\d+) of`);
  const used = ((await landed(signature)).meta?.logMessages ?? []).flatMap((line) => pattern.exec(line)?.[1] ?? []);
  return Number(used.at(-1));
}

/** A transaction of `instructions`, `payer` paying and every signer they name signing. */
async function signed(payer: TransactionSigner, instructions: Instruction[]) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
}

/** The custom error a failed transaction's instruction returned, or -1 for another failure, or null for none. */
const customError = (err: unknown) => {
  const custom = (err as { InstructionError?: [number, { Custom?: bigint | number }] } | null)?.InstructionError?.[1]?.Custom;
  return custom !== undefined ? Number(custom) : err ? -1 : null;
};

/** The custom error a simulated transaction of `instructions` fails with, `payer` paying. */
export async function simulatedError(payer: TransactionSigner, instructions: Instruction[]): Promise<number | null> {
  const transaction = await signed(payer, instructions);
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", commitment: "confirmed" }).send();
  return customError(value.err);
}

/**
 * Sends a transaction the program will refuse, with no preflight, so the refusal lands on chain as a failed transaction
 * (its fee paid): its signature and the custom error it failed with.
 */
export async function sendRefused(payer: TransactionSigner, instructions: Instruction[]): Promise<{ signature: string; error: number | null }> {
  const transaction = await signed(payer, instructions);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", skipPreflight: true }).send();
  for (let poll = 0; poll < 60; poll++) {
    await sleep(1_000);
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { signature, error: customError(status.err) };
  }
  throw new Error(`transaction ${signature} did not land`);
}
