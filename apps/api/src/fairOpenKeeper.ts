// The keeper's work for a Fair Open (spec 10.2, keeper steps 1 to 7): the coin's metadata uploaded 15 s before the open,
// the rung the pot covers broadcast at the open, every seat pushed its coins and refund in parallel batches, the
// creator's coins locked, the Tax Share collected once the Tax window ends and pushed to every seat, closing it, and the
// launch closed; or, if the open cannot run, the launch marked failed and every seat refunded; then the nonce's rent back
// to the creator and the ticker released. The Workflow in ./keeperWorkflow runs each as a step, and every step is safe to
// repeat: each reads the chain first and does only what is still undone, so a step tried again does nothing twice. A
// launch in a quote other than SOL is kept the same way, its quote read from the chain: every refund and Tax Share goes
// from its pot to the wallet's associated account of the quote, which the keeper makes first for a wallet that closed it
// (ADR 0007 decision 1).
import {
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
} from "@solana/kit";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  allocate,
  claimablePool,
  closeLaunchInstructions,
  collectTaxShareInstructions,
  dbcPoolAddress,
  closeNonceInstruction,
  FAIR_OPEN_PROGRAM_ADDRESS,
  fairOpenPhase,
  fetchLookupTable,
  fetchQuoteToken,
  inSol,
  pushSeats as pushSeatsIn,
  quoteTokenAccount,
  quoteTokenAccountInstruction,
  refundSeats,
  taxShareSeats,
  type QuoteToken,
  LATE_OPEN_SECONDS,
  lockCreatorInstructions,
  markFailedInstructions,
  pushInstructions,
  pushTaxShareInstructions,
  refundsInstructions,
  rungAtOrBelow,
  SEAT_LAYOUT,
  type LookupTable,
} from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchMaybeLaunch, getSeatDecoder, getSeatSize, LaunchStatus, type Launch } from "@top-pad/clients/fair-open";
import { fetchMaybeCoinRecord, findCoinRecordPda, TAX_WINDOW_SECONDS } from "@top-pad/clients/fee";
import { fairOpenRungs, fairOpens, launches, metadataItems, pools, type Db } from "@top-pad/db";
import type { BlobStore, Bindings, Config, SecretBinding } from "./env";
import { loadKeeper, type Keeper } from "./keeper";
import { servedAt, uploadItem } from "./metadata";
import { protectHeatCoin } from "./protectedSet";
import { keeperSignatureOn, wireOf } from "./rungs";
import { confirmed, preflightRefusal, sendAndConfirm, sendWire, TransactionFailed } from "./send";

/** What one Workflow needs to keep a Fair Open: its launch account. */
export type FairOpenKeeperParams = { launch: string };

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Rpc = ReturnType<typeof createSolanaRpc>;
type LaunchRow = typeof launches.$inferSelect;

/** Transactions sent at once in a round of pushes (spec 2.1 step 12). */
export const PUSHES_AT_ONCE = 10;
/** How long the open waits for the coin's metadata to be served before it goes out anyway (spec 2.1 step 10). */
const SERVE_WAIT_MS = 10_000;

/** The chain's clock, from the Clock sysvar, which the program's own checks read. */
export async function chainTime(rpc: Rpc): Promise<bigint> {
  const clock = await fetchEncodedAccount(rpc, address("SysvarC1ock11111111111111111111111111111111"), { commitment: "processed", ...limited() });
  if (!clock.exists) throw new Error("no Clock sysvar");
  return new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true);
}

/** The launch service's row for a Fair Open, which holds its ladder; null for one Heat did not schedule. */
export async function launchRow(db: Db, launch: string): Promise<LaunchRow | null> {
  const [row] = await db.select().from(launches).where(eq(launches.fairOpen, launch));
  return row ?? null;
}

/** Heat's shared lookup table is frozen (spec 2.1 step 6), so each Worker reads it once. */
let tableAsked: Promise<LookupTable> | null = null;
function lookupTable(cfg: Config, rpc: Rpc) {
  if (!cfg.heat?.lookupTable) throw new Error(`Heat has no shared lookup table on ${cfg.cluster}`);
  tableAsked ??= fetchLookupTable(rpc, cfg.heat.lookupTable);
  tableAsked.catch(() => (tableAsked = null));
  return tableAsked;
}

/** A transaction of `instructions` from our keeper, through the shared lookup table, sent and confirmed. */
async function keeperSends(cfg: Config, rpc: Rpc, keeper: Keeper, instructions: Instruction[]): Promise<string> {
  const table = await lookupTable(cfg, rpc);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const transaction = await signTransactionMessageWithSigners(
    compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keeper.signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
      { [table.address]: table.addresses },
    ),
  );
  const signature = getSignatureFromTransaction(transaction);
  await sendAndConfirm(rpc, getBase64EncodedWireTransaction(transaction), signature);
  return signature;
}

/** Associated accounts of a token quote a transaction makes at most, each about 25,000 units and 100 bytes. */
const QUOTE_ACCOUNTS_AT_ONCE = 4;

/**
 * In a quote other than SOL, makes each of `owners`' associated accounts of the quote that does not exist, our keeper
 * paying its rent: the pot pays refunds and Tax Shares only into them, and a depositor may have closed theirs after
 * depositing from it. Nothing in SOL, or when every account exists, which is the usual case.
 */
async function ensureQuoteAccounts(cfg: Config, rpc: Rpc, keeper: Keeper, quote: QuoteToken, owners: Address[]): Promise<number> {
  if (inSol(quote) || owners.length === 0) return 0;
  const unique = [...new Set(owners)];
  const accounts = await Promise.all(unique.map((owner) => quoteTokenAccount(owner, quote)));
  const missing: Address[] = [];
  for (let i = 0; i < accounts.length; i += 100) {
    const { value } = await rpc.getMultipleAccounts(accounts.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }).send(limited());
    value.forEach((account, j) => {
      if (!account) missing.push(unique[i + j]!);
    });
  }
  for (let i = 0; i < missing.length; i += QUOTE_ACCOUNTS_AT_ONCE) {
    const made = await Promise.all(missing.slice(i, i + QUOTE_ACCOUNTS_AT_ONCE).map((owner) => quoteTokenAccountInstruction(keeper.signer, owner, quote)));
    await keeperSends(cfg, rpc, keeper, made);
  }
  return missing.length;
}

/** Where a Fair Open stands on chain, and when it opens and is late, in milliseconds since the epoch. */
export type Schedule = { status: "scheduled" | "opened" | "failed" | "gone"; opensAtMs: number; lateAtMs: number };

export async function readSchedule(db: Db, cfg: Config, launch: Address): Promise<Schedule> {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const account = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!account.exists) {
    // A launch account that was never seen, or one closed after a failure: the row tells which.
    const row = await launchRow(db, launch);
    if (!row?.opensAt) throw new Error(`${launch} has no launch account on chain yet`);
    return { status: "gone", opensAtMs: row.opensAt.getTime(), lateAtMs: row.opensAt.getTime() + Number(LATE_OPEN_SECONDS) * 1000 };
  }
  const { data } = account;
  const status = data.status === LaunchStatus.Opened ? "opened" : data.status === LaunchStatus.Failed ? "failed" : "scheduled";
  return { status, opensAtMs: Number(data.opensAt) * 1000, lateAtMs: Number(data.opensAt + LATE_OPEN_SECONDS) * 1000 };
}

/** How long the gateway is watched for a coin's items after their upload (spec 11.2: served within 10 s of it). */
export const SERVE_WITHIN_MS = 10_000;

/** Whether a pot could open if its window closed now: it covers the lowest rung and its minimum raise (spec 2.1 step 15). */
const couldOpen = (launch: Launch) => {
  const { spend } = allocate(launch.counts, launch.unverifiedCounts, launch.step, launch.potCap);
  return spend >= launch.lowestRung && spend >= launch.minRaise;
};

/** What the upload step did: the items it sent, and how long after its upload the gateway first served each. */
export type UploadOutcome = {
  uploaded: number;
  /**
   * Why nothing went up: the pot could not open as it stood, the launch failed, or a Bar cancelled it (spec 6.5), so its
   * coin stays sealed for good.
   */
  held: "cannot_open" | "failed" | "cancelled" | null;
  servedAfterMs: { image: number | null; metadata: number | null };
};

/**
 * Step 1, 15 s before the open: the coin's image and metadata go up through Turbo, so its URI is served by the time the
 * coin appears (spec 2.1 step 5, 10.2). Only for a launch that can still create its coin: a Fair Open that fails never
 * reveals the coin it sealed, so a pot that cannot open as it stands keeps its items back, and if deposits in the
 * window's last seconds let it open after all, the open's step uploads them before it sends the rung. Then it watches
 * the gateway until `watchUntilMs` at the latest, at most 10 s, and records when it first served each item (spec 11.2).
 */
export async function uploadMetadata(
  db: Db,
  cfg: Config,
  blobs: BlobStore,
  launch: string,
  o: { watchUntilMs?: number } = {},
): Promise<UploadOutcome> {
  const row = await launchRow(db, launch);
  if (!row) throw new Error(`Heat did not schedule ${launch}`);
  const held = await heldBack(db, cfg, launch as Address, row);
  if (held) return { uploaded: 0, held, servedAfterMs: { image: null, metadata: null } };
  const uploaded = await uploadItems(db, cfg, blobs, row);
  const watchMs = Math.min(SERVE_WITHIN_MS, (o.watchUntilMs ?? Infinity) - Date.now());
  return { uploaded, held: null, servedAfterMs: await watchServed(db, row, Math.max(watchMs, 0)) };
}

/** Why a launch's items must stay back, if they must: it failed, or its pot could not open as it stands. */
async function heldBack(db: Db, cfg: Config, launch: Address, row: LaunchRow): Promise<UploadOutcome["held"]> {
  if (await cancelled(db, row.id)) return "cancelled";
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const account = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!account.exists) {
    // A closed launch: one that opened has its coin's pool, and one that failed has none.
    const [pool] = await db.select({ mint: pools.mint }).from(pools).where(eq(pools.mint, row.mint));
    return pool ? null : "failed";
  }
  const { data } = account;
  if (data.status === LaunchStatus.Opened) return null;
  if (data.status === LaunchStatus.Failed || data.failure.__option === "Some") return "failed";
  return couldOpen(data) ? null : "cannot_open";
}

/**
 * Whether a Bar cancelled the launch before its window (spec 6.5): our keeper then sends none of its rungs and uploads
 * nothing, and it fails at its open through the failure path. Read afresh each time, since an operator may confirm the
 * case while the Workflow sleeps.
 */
export async function cancelled(db: Db, launchId: string): Promise<boolean> {
  const [row] = await db.select({ at: launches.cancelledAt }).from(launches).where(eq(launches.id, launchId));
  return !!row?.at;
}

/** Uploads every item of the launch not yet uploaded; says how many went up. */
async function uploadItems(db: Db, cfg: Config, blobs: BlobStore, row: LaunchRow): Promise<number> {
  const items = await db
    .select()
    .from(metadataItems)
    .where(and(eq(metadataItems.launchId, row.id), isNull(metadataItems.uploadedAt)))
    .orderBy(asc(metadataItems.item));
  for (const item of items) {
    const receipt = await uploadItem(blobs, cfg.turbo, item);
    await db.update(metadataItems).set({ uploadedAt: sql`now()`, receipt }).where(and(eq(metadataItems.launchId, row.id), eq(metadataItems.item, item.item)));
  }
  return items.length;
}

/**
 * Watches the gateway, up to `watchMs`, for each uploaded item it has not yet been seen to serve, and records when it
 * first did; says how long after its upload each item was served, null for one not seen within the watch.
 */
async function watchServed(db: Db, row: LaunchRow, watchMs: number): Promise<UploadOutcome["servedAfterMs"]> {
  const items = await db.select().from(metadataItems).where(eq(metadataItems.launchId, row.id));
  const uri = { image: row.imageUri, metadata: row.metadataUri };
  const after = { image: null as number | null, metadata: null as number | null };
  await Promise.all(
    items
      .filter((item) => item.uploadedAt !== null)
      .map(async (item) => {
        let served = item.servedAt;
        if (!served) {
          served = await servedAt(uri[item.item], watchMs);
          if (!served) return;
          await db
            .update(metadataItems)
            .set({ servedAt: served })
            .where(and(eq(metadataItems.launchId, row.id), eq(metadataItems.item, item.item), isNull(metadataItems.servedAt)));
        }
        after[item.item] = served.getTime() - item.uploadedAt!.getTime();
      }),
  );
  return after;
}

/**
 * The open's hold (spec 2.1 step 10): uploads whatever is not up yet, now that the pot can open, and waits for the
 * metadata to be served, 10 s at most in all, so a Turbo that hangs never holds the open longer. The open goes out
 * after it either way; the Workflow uploads anything still missing once the coin exists.
 */
async function holdForMetadata(db: Db, cfg: Config, blobs: BlobStore, row: LaunchRow, launch: Address) {
  const until = Date.now() + SERVE_WAIT_MS;
  const up = await Promise.race([
    uploadItems(db, cfg, blobs, row).then(
      () => true,
      (e: Error) => (console.error(`the metadata of ${launch} did not go up at the open`, e.message), false),
    ),
    sleep(SERVE_WAIT_MS).then(() => false),
  ]);
  const { metadata } = up ? await watchServed(db, row, Math.max(until - Date.now(), 0)) : { metadata: null };
  if (metadata === null) console.warn(`the metadata of ${launch} is not served yet; opening anyway`);
}

/** What the open's step did. */
export type OpenOutcome =
  | {
      outcome: "opened";
      /** The creation transaction, ours or another sender's. */
      signature: string | null;
      /** How late our keeper sent it after the scheduled open, by the Worker's clock. */
      sentLateMs: number | null;
      /** How late it landed after the scheduled open, by the chain's clock (its block's time, whole seconds). */
      landedLateS: number | null;
    }
  | { outcome: "cannot_open"; failure: "below_lowest_rung" | "min_raise_missed" | "late" }
  | { outcome: "gone" };

/**
 * Step 2: at the open, the largest rung the pot covers goes out (spec 2.1 step 10). It waits for the chain's clock to
 * reach the open, since the program refuses a rung a moment early, and sends only a rung that passes its preflight:
 * a durable-nonce transaction that fails on chain still advances its nonce, which would void the whole ladder. A creator
 * who signs at the open is waited for until the open is late. Returns once the launch has opened, by this rung or any
 * other sender, or once it cannot.
 */
export async function sendOpen(db: Db, cfg: Config, blobs: BlobStore, keeperKey: SecretBinding, launch: Address): Promise<OpenOutcome> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const row = await launchRow(db, launch);
  if (!row) throw new Error(`Heat did not schedule ${launch}`);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  let held = false;
  for (;;) {
    const account = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
    if (!account.exists) return { outcome: "gone" };
    if (account.data.status === LaunchStatus.Opened) return openedOutcome(db, rpc, row.id);
    const now = await chainTime(rpc);
    const phase = fairOpenPhase(account.data, now);
    if (phase.phase === "failing" || phase.phase === "failed") return { outcome: "cannot_open", failure: phase.failure };
    if (phase.phase !== "due") {
      // Close to the open the chain's clock is read every quarter second; it moves one slot, about 0.4 s, at a time.
      await sleep(Math.min(Math.max(Number(account.data.opensAt - now) * 1000 - 1_500, 250), 5_000));
      continue;
    }
    if (await cancelled(db, row.id)) {
      // A Bar cancelled it (spec 6.5): no rung goes out, and it fails once the open is late, if its pot had not already
      // failed it. Its window took no deposits, so nobody waits on it.
      await sleep(Math.min(Math.max(Number(phase.lateAt - now) * 1000, 250), 5_000));
      continue;
    }

    const { spend } = allocate(account.data.counts, account.data.unverifiedCounts, account.data.step, account.data.potCap);
    const amount = rungAtOrBelow(account.data.potCap, spend)!;
    let [rung] = await db.select().from(fairOpenRungs).where(and(eq(fairOpenRungs.launchId, row.id), eq(fairOpenRungs.rung, amount)));
    if (!rung) throw new Error(`${launch} has no rung of ${amount}`);
    if (!rung.creatorSignature) {
      // The creator signs this rung from the Fair Open page at the open (ADR 0005's fallback).
      await sleep(1_000);
      continue;
    }
    if (!rung.keeperSignature) {
      const keeperSignature = await keeperSignatureOn(keeper, rung.message);
      await db.update(fairOpenRungs).set({ keeperSignature }).where(and(eq(fairOpenRungs.launchId, row.id), eq(fairOpenRungs.rung, amount)));
      rung = { ...rung, keeperSignature };
    }
    // The open holds up to 10 s for the coin's metadata to be served, once.
    if (!held) {
      held = true;
      await holdForMetadata(db, cfg, blobs, row, launch);
    }
    const wire = wireOf(rung, { keeper: keeper.signer.address, creator: row.wallet, mint: row.mint });
    const signature = rung.keeperSignature!;
    const sentAt = Date.now();
    try {
      await sendWire(rpc, wire, { preflightCommitment: "processed" });
    } catch (e) {
      // Most often "TooEarly" by the preflight's bank, a slot behind the clock read above; tried again at once.
      console.warn(`the open of ${launch} was refused in preflight: ${preflightRefusal(e)}`);
      await sleep(400);
      continue;
    }
    await db
      .update(launches)
      .set({ openSignature: signature, openSentAt: new Date(sentAt) })
      .where(and(eq(launches.id, row.id), isNull(launches.openSignature)));
    try {
      await confirmed(rpc, signature, 60_000);
    } catch (e) {
      // A rung that failed on chain advanced the nonce: no rung can open the launch now, and it fails when late.
      if (e instanceof TransactionFailed) console.error(`the open of ${launch} failed on chain, voiding its ladder`, e.message);
      continue;
    }
    return openedOutcome(db, rpc, row.id);
  }
}

/** The open as it landed, its lateness measured once and recorded with the launch. */
async function openedOutcome(db: Db, rpc: Rpc, launchId: string): Promise<OpenOutcome> {
  const [row] = await db.select().from(launches).where(eq(launches.id, launchId));
  if (!row?.openSignature || !row.openSentAt || !row.opensAt) return { outcome: "opened", signature: null, sentLateMs: null, landedLateS: null };
  let landedAt = row.openLandedAt;
  if (!landedAt) {
    const { value: [status] } = await rpc.getSignatureStatuses([row.openSignature as never], { searchTransactionHistory: true }).send(limited());
    if (status && !status.err) {
      const blockTime = await rpc.getBlockTime(status.slot).send(limited()).catch(() => null);
      landedAt = blockTime === null ? null : new Date(Number(blockTime) * 1000);
      await db.update(launches).set({ openSlot: Number(status.slot), openLandedAt: landedAt }).where(eq(launches.id, launchId));
    }
  }
  const opensAt = row.opensAt.getTime();
  return {
    outcome: "opened",
    signature: row.openSignature,
    sentLateMs: row.openSentAt.getTime() - opensAt,
    landedLateS: landedAt ? (landedAt.getTime() - opensAt) / 1000 : null,
  };
}

type SeatAccount = { seat: Address; wallet: Address; delivered: boolean };

/** Every seat of a launch, from the chain. */
async function seatsOf(rpc: Rpc, launch: Address): Promise<SeatAccount[]> {
  const found = await rpc
    .getProgramAccounts(FAIR_OPEN_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getSeatSize()) },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.launchOffset), bytes: launch as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send(limited());
  return found.map((s) => {
    const seat = getSeatDecoder().decode(getBase64Encoder().encode(s.account.data[0]));
    return { seat: s.pubkey, wallet: seat.wallet, delivered: seat.delivered };
  });
}

/** What a round of transactions did. */
export type Delivered = { transactions: number; seats: number; remaining: number };

/**
 * Step 4: every seat gets its coins and refund (spec 2.1 step 12), 7 seats a push (5 in a token quote) and 10 pushes at a time, round after
 * round until none is left; the creator's seat waits for the Creator lock (#49). A push names only seats still owed, and
 * the program passes over a seat already delivered, so a step tried again sends nothing for those.
 */
export async function pushSeats(db: Db, cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<Delivered> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!found.exists || found.data.status !== LaunchStatus.Opened) throw new Error(`${launch} has not opened`);
  const account = found.data;
  const quote = await fetchQuoteToken(rpc, account.quoteMint);
  const perPush = pushSeatsIn(quote);
  let transactions = 0;
  let seats = 0;
  for (let round = 0; round < 10; round++) {
    const waiting = (await seatsOf(rpc, launch)).filter((s) => !s.delivered && s.wallet !== account.creator);
    if (waiting.length === 0) {
      await db.update(launches).set({ deliveredAt: sql`now()` }).where(and(eq(launches.fairOpen, launch), isNull(launches.deliveredAt)));
      return { transactions, seats, remaining: 0 };
    }
    await ensureQuoteAccounts(cfg, rpc, keeper, quote, waiting.map((s) => s.wallet));
    const batches: SeatAccount[][] = [];
    for (let i = 0; i < waiting.length; i += perPush) batches.push(waiting.slice(i, i + perPush));
    for (let i = 0; i < batches.length; i += PUSHES_AT_ONCE) {
      const sent = await Promise.allSettled(
        batches.slice(i, i + PUSHES_AT_ONCE).map(async (batch) =>
          keeperSends(
            cfg,
            rpc,
            keeper,
            await pushInstructions({ launch, mint: account.mint, payer: keeper.signer, seats: batch, computeUnitPrice: cfg.computeUnitPrice, quote }),
          ),
        ),
      );
      for (const [j, result] of sent.entries()) {
        if (result.status === "fulfilled") {
          transactions++;
          seats += batches[i + j]!.length;
        } else {
          console.warn(`a push of ${launch} failed; the next round sends it again`, (result.reason as Error).message);
        }
      }
    }
  }
  const remaining = (await seatsOf(rpc, launch)).filter((s) => !s.delivered && s.wallet !== account.creator).length;
  if (remaining > 0) throw new Error(`${remaining} seats of ${launch} are still owed their coins after 10 rounds`);
  return { transactions, seats, remaining };
}

/** What a step after the open sent: its transactions' signatures, for the indexer, and what it did. */
export type AfterOpenSent = { signatures: string[] };

/**
 * Step 3: the Creator lock (spec 2.1 step 13), once every other seat has its coins: the creator's seat's coins go into
 * their Jupiter Lock escrow and the seat closes. Nothing to do when the Creator wallet holds no seat, or it is locked.
 */
export async function lockCreator(cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<AfterOpenSent & { locked: boolean }> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!found.exists) return { signatures: [], locked: false };
  if (found.data.status !== LaunchStatus.Opened) throw new Error(`${launch} has not opened`);
  const creator = found.data.creator;
  const seat = (await seatsOf(rpc, launch)).find((s) => s.wallet === creator && !s.delivered);
  if (!seat) return { signatures: [], locked: false };
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const pool = await dbcPoolAddress(found.data.dbcConfig, found.data.mint, found.data.quoteMint);
  const quote = await fetchQuoteToken(rpc, found.data.quoteMint);
  await ensureQuoteAccounts(cfg, rpc, keeper, quote, [creator]);
  const instructions = await lockCreatorInstructions({ launch, creator, seat: seat.seat, mint: found.data.mint, pool, computeUnitPrice: cfg.computeUnitPrice, quote });
  return { signatures: [await keeperSends(cfg, rpc, keeper, instructions)], locked: true };
}

/** When a Fair Open's coin's Tax window ends, in milliseconds since the epoch, from its pool's activation point. */
export async function taxWindowEnd(cfg: Config, launch: Address): Promise<number> {
  const heat = cfg.heat;
  if (!heat) throw new Error(`Heat has no configs on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!found.exists || found.data.status !== LaunchStatus.Opened) throw new Error(`${launch} has not opened`);
  const pool = await dbcPoolAddress(found.data.dbcConfig, found.data.mint, found.data.quoteMint);
  const state = await fetchVirtualPool(rpc, pool, limited());
  return Number(state.data.poolState.activationPoint + TAX_WINDOW_SECONDS) * 1000;
}

/**
 * Step 5: the Tax Share's collection (spec 2.1 step 14), the first window claim of the coin's pool, at 60 s. Throws while
 * the chain's clock is still inside the window, so the Workflow's step tries again a second later. Nothing to do once it
 * is collected, by this keeper or anyone.
 */
export async function collectTaxShare(cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<AfterOpenSent & { sentLateMs: number | null }> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!found.exists || found.data.taxCollected) return { signatures: [], sentLateMs: null };
  if (found.data.status !== LaunchStatus.Opened) throw new Error(`${launch} has not opened`);
  const record = await fetchMaybeCoinRecord(rpc, (await findCoinRecordPda({ mint: found.data.mint }))[0], limited());
  if (!record.exists) throw new Error(`${found.data.mint} has no CoinRecord on chain yet`);
  const state = await fetchVirtualPool(rpc, record.data.pool, limited());
  const quote = await fetchQuoteToken(rpc, found.data.quoteMint);
  const pool = claimablePool(record.data.pool, state.data.poolState, quote);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const sentAt = Date.now();
  try {
    const instructions = await collectTaxShareInstructions({
      launch,
      pool,
      treasury: heat.keys.treasury,
      computeUnitPrice: cfg.computeUnitPrice,
      quote,
      payer: keeper.signer,
    });
    const signature = await keeperSends(cfg, rpc, keeper, instructions);
    return { signatures: [signature], sentLateMs: sentAt - Number(pool.windowEndsAt) * 1000 };
  } catch (e) {
    // Most often "The pool's Tax window has not ended": the chain's clock trails this Worker's by a second or so.
    throw new Error(`the Tax Share's collection of ${launch} was refused: ${preflightRefusal(e)}`, { cause: e });
  }
}

/**
 * Step 6: every seat but the creator's is paid its Tax Share and closes, its rent back to its wallet (spec 2.1 step 14),
 * 13 seats a push (8 in a token quote) and 10 pushes at a time, round after round; then the launch closes, its rent and what is left of the
 * creator's prepaid rent going back to the creator. A push names only seats still open, so a step tried again sends
 * nothing for those paid.
 */
export async function pushTaxShare(cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<AfterOpenSent & { seats: number; closed: boolean }> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const signatures: string[] = [];
  let seats = 0;
  let quote: QuoteToken | null = null;
  for (let round = 0; round < 10; round++) {
    const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
    if (!found.exists) return { signatures, seats, closed: true };
    if (!found.data.taxCollected) throw new Error(`${launch} has not collected its Tax Share`);
    quote ??= await fetchQuoteToken(rpc, found.data.quoteMint);
    const waiting = (await seatsOf(rpc, launch)).filter((s) => s.delivered && s.wallet !== found.data.creator);
    if (waiting.length === 0) {
      // Every seat has closed, the creator's with the Creator lock: the launch is done.
      if (found.data.seats > 0) throw new Error(`${found.data.seats} seats of ${launch} are still open, owed their coins or the Creator lock`);
      const close = await closeLaunchInstructions({ launch, creator: found.data.creator, computeUnitPrice: cfg.computeUnitPrice, quote });
      signatures.push(await keeperSends(cfg, rpc, keeper, close));
      return { signatures, seats, closed: true };
    }
    await ensureQuoteAccounts(cfg, rpc, keeper, quote, waiting.map((s) => s.wallet));
    const perPush = taxShareSeats(quote);
    const batches: SeatAccount[][] = [];
    for (let i = 0; i < waiting.length; i += perPush) batches.push(waiting.slice(i, i + perPush));
    for (let i = 0; i < batches.length; i += PUSHES_AT_ONCE) {
      const sent = await Promise.allSettled(
        batches.slice(i, i + PUSHES_AT_ONCE).map(async (batch) =>
          keeperSends(cfg, rpc, keeper, await pushTaxShareInstructions({ launch, seats: batch, computeUnitPrice: cfg.computeUnitPrice, quote })),
        ),
      );
      for (const [j, result] of sent.entries()) {
        if (result.status === "fulfilled") {
          signatures.push(result.value);
          seats += batches[i + j]!.length;
        } else {
          console.warn(`a Tax Share push of ${launch} failed; the next round sends it again`, (result.reason as Error).message);
        }
      }
    }
  }
  throw new Error(`the Tax Share of ${launch} is still owed after 10 rounds`);
}

/**
 * Step 7: a launch that cannot open is marked failed, every seat gets its deposit and both rents back, and the launch is
 * closed, its rent and its vault's back to the creator (spec 2.1 step 15). Anyone may send each of these, so the keeper
 * does what the chain shows is still undone.
 */
export async function failAndRefund(cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<{ marked: boolean; refunded: number; closed: boolean }> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  let found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (!found.exists) return { marked: false, refunded: 0, closed: false };
  let marked = false;
  if (found.data.status === LaunchStatus.Scheduled) {
    const phase = fairOpenPhase(found.data, await chainTime(rpc));
    if (phase.phase !== "failing") throw new Error(`${launch} cannot be marked failed yet: it is ${phase.phase}`);
    await keeperSends(cfg, rpc, keeper, await markFailedInstructions({ launch, computeUnitPrice: cfg.computeUnitPrice }));
    marked = true;
    found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
    if (!found.exists) return { marked, refunded: 0, closed: false };
  }
  if (found.data.status !== LaunchStatus.Failed) throw new Error(`${launch} opened: it has nothing to refund`);
  const quote = await fetchQuoteToken(rpc, found.data.quoteMint);
  const seats = await seatsOf(rpc, launch);
  await ensureQuoteAccounts(cfg, rpc, keeper, quote, seats.map((s) => s.wallet));
  const perRefund = refundSeats(quote);
  for (let i = 0; i < seats.length; i += perRefund) {
    const batch = seats.slice(i, i + perRefund).map(({ seat, wallet }) => ({ seat, wallet }));
    await keeperSends(cfg, rpc, keeper, await refundsInstructions({ launch, seats: batch, computeUnitPrice: cfg.computeUnitPrice, quote }));
  }
  await keeperSends(cfg, rpc, keeper, await closeLaunchInstructions({ launch, creator: found.data.creator, computeUnitPrice: cfg.computeUnitPrice, quote }));
  return { marked, refunded: seats.length, closed: true };
}

/**
 * Once the launch has opened or failed, our keeper closes its durable nonce, every lamport going back to the creator,
 * who paid its rent with the schedule (spec 2.1 step 7).
 */
export async function closeLaunchNonce(db: Db, cfg: Config, keeperKey: SecretBinding, launch: Address): Promise<{ closed: string | null }> {
  const heat = cfg.heat;
  if (!heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const row = await launchRow(db, launch);
  if (!row?.nonce) throw new Error(`Heat did not schedule ${launch}`);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed", ...limited() });
  if (found.exists && found.data.status === LaunchStatus.Scheduled) throw new Error(`${launch} has neither opened nor failed`);
  const { value: lamports } = await rpc.getBalance(row.nonce as Address, { commitment: "confirmed" }).send(limited());
  if (lamports === 0n) return { closed: null };
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  const signature = await keeperSends(cfg, rpc, keeper, [closeNonceInstruction({ nonce: row.nonce as Address, keeper: keeper.signer, creator: row.wallet as Address, lamports })]);
  return { closed: signature };
}

/**
 * The keeper's last step (spec 2.1 step 3, 6.2): a launch that opened completed its Fair Open, so its coin is protected
 * and keeps its ticker's strict key in the unique index; one that failed gives the key back. Either way the launch's work
 * is marked done, which the cron's sweep reads.
 */
export async function finishTicker(db: Db, launch: string): Promise<{ protected: boolean; released: boolean }> {
  const [row] = await db.select().from(launches).where(eq(launches.fairOpen, launch));
  if (!row) throw new Error(`Heat did not schedule ${launch}`);
  const [indexed] = await db.select({ openedAt: fairOpens.openedAt }).from(fairOpens).where(eq(fairOpens.launch, launch));
  const opened = row.openLandedAt !== null || indexed?.openedAt != null;
  if (opened) {
    await protectHeatCoin(db, { mint: row.mint, ticker: row.ticker, name: row.name, imageUri: row.imageUri, launchId: row.id }, { reason: "fair_open" });
    await db.update(launches).set({ keeperDoneAt: sql`now()` }).where(and(eq(launches.id, row.id), isNull(launches.keeperDoneAt)));
    return { protected: true, released: false };
  }
  const held = await db
    .update(launches)
    .set({ tickerKey: null, keeperDoneAt: sql`coalesce(${launches.keeperDoneAt}, now())` })
    .where(and(eq(launches.id, row.id), isNotNull(launches.tickerKey)))
    .returning({ id: launches.id });
  await db.update(launches).set({ keeperDoneAt: sql`now()` }).where(and(eq(launches.id, row.id), isNull(launches.keeperDoneAt)));
  return { protected: false, released: held.length > 0 };
}

/**
 * Starts the keeper's Workflow for a Fair Open, keyed by its launch account, unless one has started already: the
 * schedule landing and the cron's sweep may both ask. One that failed is started again, since every step is safe to repeat.
 */
export async function startFairOpenKeeper(env: Bindings, launch: string): Promise<void> {
  const workflows = env.FAIR_OPENS;
  if (!workflows) return;
  try {
    await workflows.create({ id: launch, params: { launch } });
  } catch (e) {
    const instance = await workflows.get(launch).catch(() => null);
    if (!instance) throw e;
    const { status } = await instance.status();
    if (status === "errored" || status === "terminated") await instance.restart();
  }
}

/**
 * The cron's sweep: every scheduled Fair Open whose work is not done (`keeper_done_at` unset) and whose open is at
 * most 5 minutes away has its keeper started, or started again if it failed, so a launch whose Workflow never started
 * still opens, or fails and is refunded, within minutes.
 */
export async function sweepFairOpens(db: Db, env: Bindings): Promise<{ due: number }> {
  const due = await db
    .select({ launch: launches.fairOpen })
    .from(launches)
    .where(and(eq(launches.mode, "fair_open"), eq(launches.status, "landed"), isNull(launches.keeperDoneAt), lt(launches.opensAt, sql`now() + interval '5 minutes'`)));
  for (const { launch } of due) await startFairOpenKeeper(env, launch!);
  return { due: due.length };
}

/**
 * Housekeeping for Fair Opens never scheduled: each one prepared and never signed, or whose schedule failed or expired,
 * has its ticker released and the durable nonce our keeper made for it closed, its rent back to our keeper, which paid
 * it, since the creator's schedule never landed to pay it back.
 */
export async function reclaimUnscheduled(db: Db, cfg: Config, keeperKey: SecretBinding | null): Promise<{ expired: number; nonces: number }> {
  const expired = await db
    .update(launches)
    .set({ status: "expired", tickerKey: null })
    .where(and(eq(launches.mode, "fair_open"), eq(launches.status, "prepared"), lt(launches.createdAt, sql`now() - interval '15 minutes'`)))
    .returning({ id: launches.id });
  const heat = cfg.heat;
  if (!heat?.keys || !keeperKey) return { expired: expired.length, nonces: 0 };
  const ended = await db
    .select({ nonce: launches.nonce })
    .from(launches)
    .where(and(eq(launches.mode, "fair_open"), inArray(launches.status, ["failed", "expired"]), isNotNull(launches.nonce), gt(launches.createdAt, sql`now() - interval '2 days'`)))
    .orderBy(desc(launches.createdAt))
    .limit(100);
  if (ended.length === 0) return { expired: expired.length, nonces: 0 };
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const { value: accounts } = await rpc.getMultipleAccounts(ended.map((e) => e.nonce as Address), { commitment: "confirmed", encoding: "base64" }).send(limited());
  const open = ended.map((e, i) => ({ nonce: e.nonce as Address, lamports: accounts[i]?.lamports ?? 0n })).filter((n) => n.lamports > 0n);
  if (open.length === 0) return { expired: expired.length, nonces: 0 };
  const keeper = await loadKeeper(keeperKey, heat.keys.keeper);
  for (let i = 0; i < open.length; i += 10) {
    const batch = open.slice(i, i + 10);
    await keeperSends(cfg, rpc, keeper, batch.map((n) => closeNonceInstruction({ nonce: n.nonce, keeper: keeper.signer, creator: keeper.signer.address, lamports: n.lamports })));
  }
  return { expired: expired.length, nonces: open.length };
}

export type { Launch };
