// Sending a signed transaction for the keeper and the launch service, and waiting for it to confirm, over HTTP. The
// free-tier RPC the devnet build runs on sends 1 transaction a second and answers bursts with 429 (spec 10.5), so a send
// refused that way is tried again a moment later; anything else the RPC refuses is the caller's to judge.
import { createSolanaRpc, isSolanaError, type Base64EncodedWireTransaction, type Commitment, type Signature } from "@solana/kit";

type Rpc = ReturnType<typeof createSolanaRpc>;

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}` : v));

/** Whether the RPC refused a request for its rate limit. */
export function rateLimited(e: unknown): boolean {
  if (!isSolanaError(e)) return /\b429\b/.test((e as Error)?.message ?? "");
  const status = (e.context as { statusCode?: number } | undefined)?.statusCode;
  return status === 429 || /\b429\b|too many requests/i.test(e.message);
}

/** What the program said when a preflight refused a transaction: its error message line, or the RPC's. */
export function preflightRefusal(e: unknown): string {
  if (!isSolanaError(e)) return (e as Error).message;
  const logs = (e.context as { logs?: string[] } | undefined)?.logs ?? [];
  return logs.find((line) => line.includes("Error Message:"))?.replace(/^.*Error Message:\s*/, "") ?? e.message;
}

/** The custom error code a failed transaction's instruction returned, if any. */
export function customError(err: unknown): number | null {
  const custom = (err as { InstructionError?: [unknown, { Custom?: number | bigint }] } | null)?.InstructionError?.[1]?.Custom;
  return custom === undefined ? null : Number(custom);
}

/** A transaction that landed and failed: its fee is spent, and sending it again cannot help. */
export class TransactionFailed extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`${signature} failed: ${json(err)}`);
  }
}

/**
 * Sends a signed transaction, trying again while the RPC answers 429, with a preflight unless `skipPreflight`. A
 * preflight's refusal is thrown as it comes, for the caller to judge.
 */
export async function sendWire(rpc: Rpc, wire: Base64EncodedWireTransaction, o: { skipPreflight?: boolean; preflightCommitment?: Commitment } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: o.skipPreflight ?? false, preflightCommitment: o.preflightCommitment ?? "confirmed" })
        .send(limited());
      return;
    } catch (e) {
      if (!rateLimited(e) || attempt >= 20) throw e;
      await sleep(500 + attempt * 250);
    }
  }
}

/**
 * Waits for a sent transaction to confirm and answers its slot; throws `TransactionFailed` if it landed and failed, and
 * a plain error if it has not confirmed within `timeoutMs` (it may still land: its signature tells).
 */
export async function confirmed(rpc: Rpc, signature: string, timeoutMs = 45_000): Promise<bigint> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await sleep(500);
    // An RPC answering 429 or stalling for a moment is asked again.
    const answer = await rpc
      .getSignatureStatuses([signature as Signature])
      .send(limited())
      .catch(() => null);
    const status = answer?.value[0];
    if (status?.err) throw new TransactionFailed(signature, status.err);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return status.slot;
    if (Date.now() > until) throw new Error(`${signature} did not confirm in time`);
  }
}

/** Sends a signed transaction and waits for it to confirm. */
export async function sendAndConfirm(rpc: Rpc, wire: Base64EncodedWireTransaction, signature: string, o: { skipPreflight?: boolean; timeoutMs?: number } = {}) {
  await sendWire(rpc, wire, o);
  return confirmed(rpc, signature, o.timeoutMs);
}
