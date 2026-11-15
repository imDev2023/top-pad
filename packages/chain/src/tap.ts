// The cohort tap's transfer (spec 10.2, 11.3): 1 SOL from the tap key to a cohort member's Creator wallet, the tap key
// paying the fee, so the member needs nothing to receive it.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

/** What the tap gives each member who linked X, once: 1 devnet SOL (spec 11.3). */
export const TAP_LAMPORTS = 1_000_000_000n;

/**
 * What the tap keeps back beyond a member's SOL, so a transfer never leaves the tap key below rent exemption or short of
 * its fee: a tap holding less than `TAP_LAMPORTS` plus this pays nobody.
 */
export const TAP_RESERVE_LAMPORTS = 10_000_000n;

/** The tap's transfer to `to`, unsigned, on a recent blockhash. */
export function tapTransferMessage(o: { tap: TransactionSigner; to: Address; lamports: bigint; blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint } }) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(o.tap, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(o.blockhash, m),
    (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: o.tap, destination: o.to, amount: o.lamports })], m),
  );
}
