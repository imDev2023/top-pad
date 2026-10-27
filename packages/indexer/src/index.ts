// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: apps/api/src/indexer.ts, adapted: Kit in
// place of web3.js, a handler in place of Stoker's LaunchLab decoding (this build's decoders come with "The indexer and
// the live coin page"), a narrow source in front of the RPC (spec 10.2), and the cursor kept in `indexer_cursors`.
import { address, createSolanaRpc, type Signature } from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { indexerCursors, type Db } from "@top-pad/db";

/** A confirmed transaction in the JSON shape `getTransaction` answers with `encoding: "json"`, whatever its source. */
export type RawTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: unknown };
  meta: { err: unknown; logMessages?: string[] | null } | null;
};

/** What a batch wrote, counted by kind (trades, launches and so on, as each handler names them). */
export type IndexResult = Record<string, number>;

/**
 * Turns one confirmed transaction into rows. It must be idempotent: the same transaction arrives from more than one
 * source (the live stream, the browser's fast path and reconciliation) and must write its rows once.
 */
export type TransactionHandler = (db: Db, tx: RawTransaction) => Promise<IndexResult>;

/** A batch in which some transactions could not be indexed; the rest were, so a retry only needs to bring these back. */
export class IndexBatchError extends Error {
  constructor(readonly result: IndexResult, readonly failed: { signature: string; error: string }[]) {
    super(`${failed.length} of the transactions could not be indexed: ${failed.map((f) => `${f.signature} (${f.error})`).join("; ")}`);
  }
}

const add = (into: IndexResult, from: IndexResult) => {
  for (const [kind, n] of Object.entries(from)) into[kind] = (into[kind] ?? 0) + n;
};

/**
 * The one ingestion entry point: every source hands its transactions here. One transaction that can't be indexed never
 * stops the others: the batch goes on, and `IndexBatchError` names what failed at the end.
 */
export async function indexTransactions(db: Db, handle: TransactionHandler, txs: RawTransaction[]): Promise<IndexResult> {
  const result: IndexResult = {};
  const failed: { signature: string; error: string }[] = [];
  for (const tx of txs) {
    try {
      add(result, await handle(db, tx));
    } catch (e) {
      const signature = tx?.transaction?.signatures?.[0] ?? "unknown";
      console.error(`indexing ${signature} failed`, e);
      failed.push({ signature, error: (e as Error).message });
    }
  }
  if (failed.length) throw new IndexBatchError(result, failed);
  return result;
}

/** One listed signature of an account, newest first as the node lists them. */
export type ListedSignature = { signature: string; slot: number; failed: boolean };

/** What reconciliation reads from the chain; `rpcSource` is the RPC one, and tests pass their own. */
export type HistorySource = {
  /** Up to `limit` signatures of the account, newest first, older than `before` and newer than `until`. */
  listSignatures(account: string, opts: { before?: string; until?: string; limit: number }): Promise<ListedSignature[]>;
  /** The transaction, or null when the node does not have it yet. */
  fetchTransaction(signature: string): Promise<RawTransaction | null>;
};

const SIGNATURE_PAGE = 1000;
// How many transactions reconciliation fetches from the node at once.
const FETCH_BATCH = 8;

/**
 * Reconciliation (spec 10.2): indexes each confirmed transaction of one account newer than its cursor, oldest first, and
 * moves the cursor to the newest it got to. A listed transaction that can't be fetched yet (an RPC node behind the one
 * that listed it, say) stops it there, so the cursor never moves past a transaction that was not indexed. `limit` stops
 * it after that many transactions, for a caller that comes back; `complete` says whether it reached the newest one.
 */
export async function reconcileAccount(
  db: Db, source: HistorySource, handle: TransactionHandler, account: string, limit = Infinity,
): Promise<{ indexed: IndexResult; seen: number; complete: boolean }> {
  const [cursor] = await db.select().from(indexerCursors).where(eq(indexerCursors.account, account)).limit(1);
  const until = cursor?.signature ?? undefined;
  const listed: ListedSignature[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await source.listSignatures(account, { before, until, limit: SIGNATURE_PAGE });
    listed.push(...page.filter((s) => !s.failed));
    if (page.length < SIGNATURE_PAGE) break;
    before = page.at(-1)!.signature;
  }
  const found = listed.reverse().slice(0, limit);
  let complete = found.length === listed.length;
  let newest: ListedSignature | null = null;
  let seen = 0;
  const indexed: IndexResult = {};
  for (let i = 0; i < found.length && seen === i; i += FETCH_BATCH) {
    const batch = found.slice(i, i + FETCH_BATCH);
    const raws = await Promise.all(batch.map((s) => source.fetchTransaction(s.signature)));
    for (const [j, listedSig] of batch.entries()) {
      const raw = raws[j];
      if (!raw) {
        console.warn(`reconciliation of ${account} stopped at ${listedSig.signature}, which could not be fetched yet`);
        complete = false;
        break;
      }
      add(indexed, await indexTransactions(db, handle, [raw]));
      newest = listedSig;
      seen++;
    }
  }
  if (newest)
    await db
      .insert(indexerCursors)
      .values({ account, signature: newest.signature, slot: newest.slot })
      .onConflictDoUpdate({
        target: indexerCursors.account,
        set: { signature: newest.signature, slot: newest.slot, updatedAt: sql`now()` },
      });
  return { indexed, seen, complete };
}

/** Reconciliation over a plain RPC endpoint: Kit lists the signatures, and transactions come back as raw JSON. */
export function rpcSource(rpcUrl: string): HistorySource {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async listSignatures(account, { before, until, limit }) {
      const page = await rpc
        .getSignaturesForAddress(address(account), {
          before: before as Signature | undefined,
          until: until as Signature | undefined,
          limit,
          commitment: "confirmed",
        })
        .send();
      return page.map((s) => ({ signature: s.signature, slot: Number(s.slot), failed: s.err !== null }));
    },
    fetchTransaction: (signature) => fetchRawTransaction(rpcUrl, signature),
  };
}

/** Fetches one transaction as raw JSON, the shape every source hands the indexer. */
export async function fetchRawTransaction(rpcUrl: string, signature: string): Promise<RawTransaction | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!res.ok) throw new Error(`RPC getTransaction failed: ${res.status}`);
  const body = (await res.json()) as { result: RawTransaction | null; error?: { message: string } };
  if (body.error) throw new Error(`RPC getTransaction failed: ${body.error.message}`);
  return body.result;
}
