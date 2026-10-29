// The devnet source on free-tier RPC (spec 10.2): `logsSubscribe` on Heat's configs and programs says a transaction
// touched them, the transaction is fetched to be decoded, and `getBlock` gives its place in its block. These are the
// RPC calls and messages that source is made of; the API's indexer Durable Object holds the WebSocket.
import { getBase58Decoder } from "@solana/kit";

const base58 = getBase58Decoder();

/** A JSON-RPC call over HTTP; throws on an RPC error. */
async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`RPC ${method} answered ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw Object.assign(new Error(`RPC ${method} failed: ${body.error.message}`), { code: body.error.code });
  return body.result as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A transaction's place in its block, from the block's signatures in order (`getBlock`), each slot fetched once. A
 * block not served yet is asked for again for up to `waitMs`; a signature missing from its block is an error.
 */
export function blockPositions(rpcUrl: string, { waitMs = 8_000, cacheSlots = 64 } = {}) {
  const blocks = new Map<number, Promise<string[]>>();
  const fetchBlock = async (slot: number) => {
    const until = Date.now() + waitMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const block = await rpcCall<{ signatures: string[] } | null>(rpcUrl, "getBlock", [
          slot,
          { transactionDetails: "signatures", rewards: false, commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ]);
        if (block) return block.signatures;
      } catch (e) {
        if (Date.now() >= until) throw e;
      }
      if (Date.now() >= until) throw new Error(`block ${slot} was not served within ${waitMs} ms`);
      await sleep(Math.min(500 * 2 ** attempt, 2_000));
    }
  };
  return async function blockIndexOf(slot: number, signature: string): Promise<number> {
    let block = blocks.get(slot);
    if (!block) {
      block = fetchBlock(slot);
      blocks.set(slot, block);
      block.catch(() => blocks.delete(slot));
      while (blocks.size > cacheSlots) blocks.delete(blocks.keys().next().value!);
    }
    const index = (await block).indexOf(signature);
    if (index < 0) throw new Error(`transaction ${signature} is not in block ${slot}`);
    return index;
  };
}

/** DBC's pool authority, which holds every pool's vaults (`const_pda::pool_authority`). */
export const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** How many wallets hold some of a coin outside its pool: the owners of its token accounts with a balance. */
export async function holderCount(rpcUrl: string, mint: string, signal?: AbortSignal): Promise<number> {
  const accounts = await rpcCall<{ account: { data: [string, string] } }[]>(
    rpcUrl,
    "getProgramAccounts",
    [
      TOKEN_PROGRAM,
      {
        encoding: "base64",
        commitment: "confirmed",
        // The owner (32 bytes from 32) and the amount (8 bytes from 64) of each classic SPL token account of the mint.
        dataSlice: { offset: 32, length: 40 },
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      },
    ],
    signal,
  );
  const owners = new Set<string>();
  for (const { account } of accounts) {
    const data = Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
    const amount = new DataView(data.buffer).getBigUint64(32, true);
    if (amount === 0n) continue;
    owners.add(base58.decode(data.subarray(0, 32)));
  }
  owners.delete(DBC_POOL_AUTHORITY);
  return owners.size;
}

/** The WebSocket endpoint of an HTTP RPC endpoint: the same URL, key and all, over wss. */
export const webSocketUrlOf = (rpcUrl: string) => rpcUrl.replace(/^http/, "ws");

/** A `logsSubscribe` request for transactions that mention `account`, at confirmed commitment. */
export const logsSubscribeRequest = (id: number, account: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [account] }, { commitment: "confirmed" }] });

/** What a message on the logs WebSocket says. */
export type LogsMessage =
  | { kind: "subscribed"; id: number; subscription: number }
  | { kind: "refused"; id: number; error: string }
  | { kind: "transaction"; subscription: number; slot: number; signature: string; failed: boolean }
  | { kind: "other" };

export function parseLogsMessage(data: string): LogsMessage {
  let message: {
    id?: number;
    result?: unknown;
    error?: { message?: string };
    method?: string;
    params?: { subscription: number; result: { context: { slot: number }; value: { signature: string; err: unknown } } };
  };
  try {
    message = JSON.parse(data);
  } catch {
    return { kind: "other" };
  }
  if (typeof message.id === "number" && typeof message.result === "number") return { kind: "subscribed", id: message.id, subscription: message.result };
  if (typeof message.id === "number" && message.error) return { kind: "refused", id: message.id, error: message.error.message ?? "refused" };
  if (message.method === "logsNotification" && message.params) {
    const { subscription, result } = message.params;
    return { kind: "transaction", subscription, slot: result.context.slot, signature: result.value.signature, failed: result.value.err !== null };
  }
  return { kind: "other" };
}
