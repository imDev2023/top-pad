// The window claim (spec 4, 10.2): Heat's keeper sends it the moment each Instant launch's Tax window ends, from the
// keeper's Workflow for the launch (./keeperWorkflow). Anyone may send it and it runs once per coin, so every step here
// is safe to repeat: a step tried again after its claim landed finds the claim done and sends nothing.
import {
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Signature,
} from "@solana/kit";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { claimablePool, windowClaimMessage, type ClaimablePool } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchAllMaybeCoinRecord, fetchMaybeCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import { coins, windowClaims, type Db } from "@top-pad/db";
import { blockPositions, decodeTransaction, fetchRawTransaction, heatHandler, reindexTransactions } from "@top-pad/indexer";
import { config, type Bindings, type Config, type SecretBinding } from "./env";
import { loadKeeper } from "./keeper";

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
/** How long one try waits for its claim to confirm before the step tries again. */
const CONFIRM_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one Workflow needs to keep an Instant launch: the coin it keeps. */
export type KeeperParams = { mint: string };

/** A Heat coin's record and pool as the chain holds them now, or null for a mint with no record. */
export async function coinWindow(cfg: Config, mint: Address): Promise<{ pool: ClaimablePool; windowClaimed: boolean } | null> {
  const heat = cfg.heat;
  if (!heat) throw new Error(`Heat has no configs on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const record = await fetchMaybeCoinRecord(rpc, (await findCoinRecordPda({ mint }))[0], limited());
  if (!record.exists) return null;
  const pool = await fetchVirtualPool(rpc, record.data.pool, limited());
  return { pool: claimablePool(record.data.pool, pool.data.poolState, heat.quote.mint), windowClaimed: record.data.windowClaimed };
}

/** When a Heat coin's Tax window ends, in milliseconds since the epoch. */
export async function windowEnd(cfg: Config, mint: Address): Promise<number> {
  const coin = await coinWindow(cfg, mint);
  if (!coin) throw new Error(`${mint} has no CoinRecord on chain yet`);
  return Number(coin.pool.windowEndsAt) * 1000;
}

/** What one try of the window claim did: sent the claim, or found it had run. */
export type WindowClaimSent = {
  signature: string | null;
  /** How long after the window ended the claim was sent, by this Worker's clock; the chain's own is in its event. */
  sentLateMs: number | null;
};

/**
 * Sends a Heat coin's window claim, signed and paid for by the keeper, unless it has run. Throws while the chain's clock
 * is still inside the window (the claim's preflight is refused) and when the claim does not confirm in time, so the
 * Workflow's step tries again a second later; a claim that landed meanwhile is then found done.
 */
export async function sendWindowClaim(cfg: Config, keeperKey: SecretBinding, mint: Address): Promise<WindowClaimSent> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const coin = await coinWindow(cfg, mint);
  if (!coin) throw new Error(`${mint} has no CoinRecord on chain yet`);
  if (coin.windowClaimed) return { signature: null, sentLateMs: null };

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const message = await windowClaimMessage(
    { pool: coin.pool, heat: true, treasury: heat.keys.treasury, payer: keeper.signer, computeUnitPrice: cfg.computeUnitPrice },
    lifetime,
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  const sentAt = Date.now();
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send(limited());

  const until = Date.now() + CONFIRM_WAIT_MS;
  for (;;) {
    await sleep(500);
    // An RPC answering 429 or stalling for a moment is asked again: a try that gave up here would send the claim twice.
    const answer = await rpc
      .getSignatureStatuses([signature as Signature])
      .send(limited())
      .catch(() => null);
    const status = answer?.value[0];
    if (status?.err) throw new Error(`the window claim ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    if (Date.now() > until) throw new Error(`the window claim ${signature} did not confirm in time`);
  }
  return { signature, sentLateMs: sentAt - Number(coin.pool.windowEndsAt) * 1000 };
}

/** The keeper's Workflows, or null where they are not bound (the API's tests). */
const keepers = (env: Bindings) => env.INSTANT_LAUNCHES ?? null;

/**
 * Starts the keeper's Workflow for an Instant launch, keyed by its coin, unless one has started already: the launch
 * landing, the indexer seeing the coin registered and the cron's sweep may each ask for the same coin. One that failed
 * is started again, since every step is safe to repeat.
 */
export async function startKeeper(env: Bindings, mint: string): Promise<void> {
  const workflows = keepers(env);
  if (!workflows) return;
  try {
    await workflows.create({ id: mint, params: { mint } });
  } catch (e) {
    const instance = await workflows.get(mint).catch(() => null);
    if (!instance) throw e;
    const { status } = await instance.status();
    if (status === "errored" || status === "terminated") await instance.restart();
  }
}

/** How long after a coin's launch the sweep looks for its window claim, past the window and a keeper's tries. */
const SWEEP_AFTER = sql`interval '3 minutes'`;
/** `getMultipleAccounts` takes at most 100 addresses a call. */
const ACCOUNTS_PER_CALL = 100;

/**
 * The cron's sweep: every Instant launch whose window claim the indexer has not recorded is settled against the chain.
 * If its record says the claim ran, the claim's transaction is found and indexed again, since the indexer that saw it
 * did not decode it (one still running the code before a deploy, say); otherwise its keeper is started, or started
 * again if it failed. A coin the other paths missed is claimed, and recorded, within minutes.
 */
export async function sweepWindowClaims(db: Db, env: Bindings): Promise<{ due: number; started: number; recorded: number }> {
  const cfg = config(env);
  const due = await db
    .select({ mint: coins.mint })
    .from(coins)
    .leftJoin(windowClaims, eq(windowClaims.mint, coins.mint))
    .where(and(eq(coins.launchMode, "instant"), isNull(windowClaims.mint), lt(coins.createdAt, sql`now() - ${SWEEP_AFTER}`)));
  let started = 0;
  let recorded = 0;
  const rpc = createSolanaRpc(cfg.rpcUrl);
  for (let i = 0; i < due.length; i += ACCOUNTS_PER_CALL) {
    const batch = due.slice(i, i + ACCOUNTS_PER_CALL);
    const addresses = await Promise.all(batch.map(async ({ mint }) => (await findCoinRecordPda({ mint: mint as Address }))[0]));
    const records = await fetchAllMaybeCoinRecord(rpc, addresses, limited());
    for (const [j, record] of records.entries()) {
      const mint = batch[j]!.mint;
      if (record.exists && record.data.windowClaimed) {
        if (await recordWindowClaim(db, cfg, mint, addresses[j]!)) recorded++;
      } else {
        await startKeeper(env, mint);
        started++;
      }
    }
  }
  return { due: due.length, started, recorded };
}

/** Finds a coin's window claim among its record's transactions, newest first, and indexes it again. */
async function recordWindowClaim(db: Db, cfg: Config, mint: string, record: Address): Promise<boolean> {
  const heat = cfg.heat;
  if (!heat?.configs) return false;
  const configs = new Set<string>([heat.configs.instant, heat.configs.fairOpen]);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  // A record's transactions are its registration and its window claim.
  const signatures = await rpc.getSignaturesForAddress(record, { limit: 10, commitment: "confirmed" }).send(limited());
  for (const { signature, err } of signatures) {
    if (err) continue;
    const raw = await fetchRawTransaction(cfg.rpcUrl, signature);
    if (!raw || !decodeTransaction(raw, configs).windowClaims.some((claim) => claim.mint === mint)) continue;
    await reindexTransactions(db, heatHandler({ heat, blockIndexOf: blockPositions(cfg.rpcUrl) }), [raw]);
    return true;
  }
  return false;
}
