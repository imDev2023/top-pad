// Indexes again, with today's handler, every transaction of one account, oldest first: for a deploy whose indexer learns
// events from transactions it had already indexed through another account, which it would otherwise pass over as known
// (spec 10.2). #45's first deploy needed it: every `create_launch` names Heat's Fair Open config, so the indexer before
// it had indexed each one without its Fair Open, and the program's failures then had no launch to fail. The handler
// writes every row once, so whatever is already there stays as it was.
// `DATABASE_URL=... RPC_URL=... pnpm --filter @top-pad/indexer reindex <cluster> <account>`; it exits 1 if any fails.
import { CLUSTERS } from "@top-pad/chain";
import { createDb } from "@top-pad/db";
import { heatHandler } from "../src/heat";
import { IndexBatchError, reindexTransactions, rpcSource, type IndexResult, type ListedSignature } from "../src/index";
import { blockPositions } from "../src/live";

const [cluster, account] = process.argv.slice(2);
const heat = CLUSTERS[cluster as keyof typeof CLUSTERS];
if (!heat || !account) throw new Error("Usage: reindex <cluster> <account>, on a cluster where Heat has its configs.");
const url = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL;
if (!url || !rpcUrl) throw new Error("Set DATABASE_URL to the database to index into and RPC_URL to the cluster's RPC.");

const source = rpcSource(rpcUrl);
const listed: ListedSignature[] = [];
for (let before: string | undefined; ; ) {
  const page = await source.listSignatures(account, { before, limit: 1000 });
  listed.push(...page);
  if (page.length < 1000) break;
  before = page.at(-1)!.signature;
}
const history = listed.reverse().filter((s) => !s.failed);
console.log(`${account}: ${history.length} transactions to index again`);

const { db, close } = createDb(url);
const handle = heatHandler({ heat, blockIndexOf: blockPositions(rpcUrl) });
const indexed: IndexResult = {};
const failed: string[] = [];
try {
  for (const { signature } of history) {
    const raw = await source.fetchTransaction(signature);
    if (!raw) {
      failed.push(`${signature} (not served)`);
      continue;
    }
    try {
      for (const [kind, n] of Object.entries(await reindexTransactions(db, handle, [raw]))) indexed[kind] = (indexed[kind] ?? 0) + n;
    } catch (e) {
      failed.push(e instanceof IndexBatchError ? e.failed.map((f) => `${f.signature} (${f.error})`).join("; ") : `${signature} (${(e as Error).message})`);
    }
  }
  console.log(`indexed again: ${JSON.stringify(indexed)}`);
  for (const f of failed) console.log(`  failed: ${f}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await close();
}
