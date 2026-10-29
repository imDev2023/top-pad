import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, indexedTransactions, indexerCursors, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { IndexBatchError, indexTransactions, reconcileAccount, type HistorySource, type RawTransaction, type TransactionHandler } from "./index";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());
beforeEach(async () => {
  await db.delete(indexerCursors);
  await db.delete(indexedTransactions);
});

const ACCOUNT = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const tx = (signature: string, slot: number): RawTransaction => ({ slot, blockTime: null, transaction: { signatures: [signature], message: { accountKeys: [], instructions: [] } }, meta: { err: null } });

/** A chain of `n` transactions on one account, oldest first, served newest first as a node lists them. */
function chain(n: number, missing = new Set<string>(), failed = new Set<string>()) {
  const txs = Array.from({ length: n }, (_, i) => tx(`sig${i}`, 100 + i));
  const source: HistorySource = {
    async listSignatures(_account, { before, until, limit }) {
      const newestFirst = [...txs].reverse().map((t) => ({ signature: t.transaction.signatures[0]!, slot: t.slot, failed: failed.has(t.transaction.signatures[0]!) }));
      const from = before ? newestFirst.findIndex((s) => s.signature === before) + 1 : 0;
      const to = until ? newestFirst.findIndex((s) => s.signature === until) : newestFirst.length;
      return newestFirst.slice(from, to === -1 ? newestFirst.length : to).slice(0, limit);
    },
    fetchTransaction: async (signature) => (missing.has(signature) ? null : (txs.find((t) => t.transaction.signatures[0] === signature) ?? null)),
  };
  return { txs, source };
}

const recorder = () => {
  const seen: string[] = [];
  const handle: TransactionHandler = async (_db, t) => {
    seen.push(t.transaction.signatures[0]!);
    return { trades: 1 };
  };
  return { seen, handle };
};

describe("reconciliation", () => {
  it("indexes an account's transactions oldest first, then resumes from its cursor with only the new ones", async () => {
    const { source } = chain(5);
    const { seen, handle } = recorder();
    const first = await reconcileAccount(db, source, handle, ACCOUNT);
    expect(first).toEqual({ indexed: { trades: 5 }, seen: 5, complete: true, cursor: "sig4" });
    expect(seen).toEqual(["sig0", "sig1", "sig2", "sig3", "sig4"]);
    expect((await db.select().from(indexerCursors))[0]).toMatchObject({ account: ACCOUNT, signature: "sig4", slot: 104 });

    const again = await reconcileAccount(db, source, handle, ACCOUNT);
    expect(again).toEqual({ indexed: {}, seen: 0, complete: true, cursor: "sig4" });
  });

  it("stops at a transaction the node can't serve yet, so the cursor never passes an unindexed one", async () => {
    const { seen, handle } = recorder();
    const result = await reconcileAccount(db, chain(5, new Set(["sig2"])).source, handle, ACCOUNT);
    expect(result).toMatchObject({ seen: 2, complete: false });
    expect(seen).toEqual(["sig0", "sig1"]);
    expect((await db.select().from(indexerCursors))[0]?.signature).toBe("sig1");

    await reconcileAccount(db, chain(5).source, handle, ACCOUNT);
    expect(seen).toEqual(["sig0", "sig1", "sig2", "sig3", "sig4"]);
  });

  it("passes over what the live source already indexed without fetching it, and still moves past it", async () => {
    const { source } = chain(5);
    const fetched: string[] = [];
    const counting: HistorySource = { ...source, fetchTransaction: async (s) => (fetched.push(s), source.fetchTransaction(s)) };
    await db.insert(indexedTransactions).values([{ signature: "sig1", slot: 101 }, { signature: "sig3", slot: 103 }]);
    const { seen, handle } = recorder();
    expect(await reconcileAccount(db, counting, handle, ACCOUNT)).toMatchObject({ seen: 5, complete: true });
    expect(fetched).toEqual(["sig0", "sig2", "sig4"]);
    expect(seen).toEqual(["sig0", "sig2", "sig4"]);
    expect((await db.select().from(indexerCursors))[0]?.signature).toBe("sig4");
  });

  it("passes over failed transactions without fetching them, so a failed one at the head never holds the cursor back", async () => {
    const { source } = chain(4, new Set(), new Set(["sig1", "sig3"]));
    const fetched: string[] = [];
    const counting: HistorySource = { ...source, fetchTransaction: async (s) => (fetched.push(s), source.fetchTransaction(s)) };
    const { seen, handle } = recorder();
    expect(await reconcileAccount(db, counting, handle, ACCOUNT)).toMatchObject({ seen: 4, complete: true, cursor: "sig3" });
    expect(fetched).toEqual(["sig0", "sig2"]);
    expect(seen).toEqual(["sig0", "sig2"]);
  });

  it("stops after `limit` transactions for a caller that comes back", async () => {
    const { handle } = recorder();
    expect(await reconcileAccount(db, chain(5).source, handle, ACCOUNT, 3)).toMatchObject({ seen: 3, complete: false });
  });
});

describe("the ingestion entry point", () => {
  it("indexes the rest of a batch when one transaction fails, and names the one that failed", async () => {
    const handle: TransactionHandler = async (_db, t) => {
      if (t.transaction.signatures[0] === "bad") throw new Error("undecodable");
      return { trades: 1 };
    };
    const error = await indexTransactions(db, handle, [tx("a", 1), tx("bad", 2), tx("b", 3)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexBatchError);
    expect((error as IndexBatchError).result).toEqual({ trades: 2 });
    expect((error as IndexBatchError).failed).toEqual([{ signature: "bad", error: "undecodable" }]);
  });
});
