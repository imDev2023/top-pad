// What spec 11.1's attack simulations share (#60): wallets derived from Heat's bank key and a run's name, so a run stopped
// partway can be swept back by name; the chain's clock; and every swap a pool has run, read back from the chain, with
// the sniper tax each one should have paid. Every call that sends spends real devnet SOL.
import { readFileSync } from "node:fs";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  getBase64Encoder,
  getUtf8Encoder,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { FEE_DENOMINATOR, SNIPER_TAX, sniperTaxNumerator } from "@top-pad/chain";
import { decodeTransaction, type Swap } from "@top-pad/indexer";
import { bankFile, chainTime, devnet, landed, rpc } from "./devnet";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Heat's two configs, as the indexer decodes their swaps. */
export const HEAT_CONFIGS = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);

/** A run's name: what its wallets derive from, logged so a stopped run can be swept back. */
export const newRun = (simulation: string) => `${simulation}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

/** A wallet derived from Heat's bank key, the simulation, the run and a label: found again by name after a stopped run. */
export async function simulationWallet(simulation: string, run: string, label: string): Promise<KeyPairSigner> {
  const secret = Uint8Array.from(JSON.parse(readFileSync(bankFile, "utf8")) as number[]).slice(0, 32);
  const seed = await crypto.subtle.digest("SHA-256", new Uint8Array([...secret, ...getUtf8Encoder().encode(`heat devnet ${simulation} ${run} ${label}`)]));
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
}

/** Waits until the chain's clock reaches `at` (Unix seconds), which can trail this Mac's by a few seconds. */
export async function untilChainTime(at: bigint) {
  for (let now = await chainTime(); now < at; now = await chainTime()) await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 300);
}

/**
 * The partner's part of a swap's fee: DBC takes Meteora's fifth (its referral share comes out of that fifth) and leaves
 * the rest to the partner, the fee program, since Heat's configs give the creator nothing (spec 4).
 */
export const partnerShare = (fee: bigint) => fee - fee / 5n;

/** A swap on a pool, with the slot and transaction it ran in. */
export type PoolSwap = Swap & { signature: Signature; slot: bigint };

/**
 * Every swap a pool ran in a transaction that succeeded, oldest first, read from the chain alone: its transactions
 * (`getSignaturesForAddress`, which covers a young pool's whole history) each decoded as the indexer decodes them.
 */
export async function poolSwaps(pool: Address): Promise<PoolSwap[]> {
  const history = await rpc.getSignaturesForAddress(pool, { limit: 1_000, commitment: "confirmed" }).send();
  const swaps: PoolSwap[] = [];
  for (const h of [...history].reverse()) {
    if (h.err) continue;
    const decoded = decodeTransaction(await landed(h.signature), HEAT_CONFIGS);
    for (const s of decoded.swaps) if (s.pool === pool) swaps.push({ ...s, signature: h.signature, slot: h.slot });
    // The public endpoint's per-method budget is about 10 calls in 10 s: a pool's history is read gently.
    await sleep(250);
  }
  return swaps;
}

/**
 * A pool's swaps split at a transaction of its (a window claim): those that ran before it and those after, a swap in
 * the claim's own slot placed by its transaction's place in the block.
 */
export async function splitAt(swaps: PoolSwap[], signature: string, slot: bigint): Promise<{ before: PoolSwap[]; after: PoolSwap[] }> {
  const same = swaps.filter((s) => s.slot === slot);
  let order: string[] = [];
  if (same.length) {
    const block = await rpc.getBlock(slot, { commitment: "confirmed", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 }).send();
    order = [...(block?.signatures ?? [])].map(String);
    if (!order.includes(signature)) throw new Error(`slot ${slot}'s block does not list ${signature}`);
  }
  const ran = (s: PoolSwap) => (s.slot < slot ? true : s.slot > slot ? false : order.indexOf(s.signature) < order.indexOf(signature));
  return { before: swaps.filter(ran), after: swaps.filter((s) => !ran(s)) };
}

/** A swap's fee as a numerator over DBC's 1,000,000,000, from what it paid: the fee rides on a buy's quote in. */
export const feeNumeratorOf = (s: Swap) => (s.fee * FEE_DENOMINATOR) / s.quoteAmount;

/**
 * How a buy's fee stands against the sniper tax (spec 6.1): in the creation slot it must be the 99% cliff (DBC rounds a
 * fee up, so at least the cliff's share); later, the linear schedule at the second the chain's clock says the swap ran,
 * to within one 1-second step either way.
 */
export function sniperTaxVerdict(s: Swap, activation: bigint, inCreationSlot: boolean) {
  const seconds = Number(s.timestamp - activation);
  const paid = feeNumeratorOf(s);
  if (inCreationSlot) return { seconds, paid, expected: SNIPER_TAX.cliffFeeNumerator, ok: s.fee * FEE_DENOMINATOR >= s.quoteAmount * SNIPER_TAX.cliffFeeNumerator };
  const expected = sniperTaxNumerator(seconds);
  // A fee is whole lamports, rounded up: the numerator read back from it may sit up to one lamport's share above.
  const rounding = FEE_DENOMINATOR / s.quoteAmount + 1n;
  const low = sniperTaxNumerator(seconds + 1) - rounding;
  const high = sniperTaxNumerator(Math.max(seconds - 1, 0)) + rounding;
  return { seconds, paid, expected, ok: paid >= low && paid <= high };
}

/** The custom error a landed transaction failed with, -1 for another failure, or null if it succeeded. */
const customError = (err: unknown) => {
  const custom = (err as { InstructionError?: [number, { Custom?: bigint | number }] } | null)?.InstructionError?.[1]?.Custom;
  return custom !== undefined ? Number(custom) : err ? -1 : null;
};

/**
 * Sends a signed transaction, base64, with no preflight, so a refusal lands on chain as a failed transaction (its fee
 * paid) rather than stopping at the endpoint's simulation: its signature and the custom error it failed with.
 */
export async function landRefused(wire: string): Promise<{ signature: Signature; error: number | null; err: unknown }> {
  const signature = getBase58Decoder().decode(getBase64Encoder().encode(wire).slice(1, 65)) as Signature;
  await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true }).send();
  for (let poll = 0; poll < 60; poll++) {
    await sleep(1_000);
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { signature, error: customError(status.err), err: status.err };
  }
  throw new Error(`transaction ${signature} did not land`);
}

/** A value as JSON, bigints as strings: a transaction's error carries its custom code as a bigint. */
export const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}` : v));

/** A fee numerator as a percentage, to three places. */
export const percent = (numerator: bigint) => `${(Number(numerator) / 1e7).toFixed(3)}%`;
