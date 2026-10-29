// The indexer from the API's side (spec 10.2): the one Durable Object, and its fast path, which takes a transaction the
// API knows has landed straight to indexing, rather than waiting for the logs socket or reconciliation to report it. It
// runs after the answer (`waitUntil`): a confirmed transaction can take seconds to be served for indexing, and a page
// asking for the coin meanwhile waits for it on its own side.
import type { Bindings } from "./env";

/** The indexer, or null where it is not bound (the API's tests). */
export const indexerOf = (env: Bindings) => (env.INDEXER ? env.INDEXER.get(env.INDEXER.idFromName("indexer")) : null);

/** How long the fast path may take before it is let go; the socket and reconciliation still catch up. */
const FAST_PATH_MS = 30_000;

/** Indexes landed transactions now, so the pages asked for next already show them. Never fails the caller. */
export async function indexNow(env: Bindings, signatures: string[]) {
  const indexer = indexerOf(env);
  if (!indexer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([indexer.indexNow(signatures), new Promise((done) => (timer = setTimeout(done, FAST_PATH_MS)))]);
  } catch (e) {
    console.warn("the indexer's fast path failed; the socket or reconciliation will index", signatures, e);
  } finally {
    clearTimeout(timer);
  }
}
