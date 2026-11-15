// The devnet cohort (spec 11.3, #63) and its tap (spec 10.2). A signed-in record joins the cohort from the cohort page;
// a member whose record linked X gets 1 devnet SOL once, sent from the tap key to the record's Creator wallet. The tap
// key holds a float of its own, apart from the keeper's, and raises an operator alert as soon as it holds less than its
// floor, which is several members' worth, so it is topped up before it runs dry.
//
// Who qualifies (ADR 0008 made X optional): anyone signed in may join, and the tap asks for a linked X account, as the
// ticket's acceptance criteria say. X is what makes the tap once a person rather than once a wallet, which costs nothing
// to make: one X account belongs to one record, and a tap is once a record, once an X account and once a wallet.
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type GetBalanceApi,
  type KeyPairSigner,
  type Rpc,
  type Signature,
} from "@solana/kit";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { TAP_LAMPORTS, TAP_RESERVE_LAMPORTS, tapTransferMessage } from "@top-pad/chain";
import { CohortRefusal, CohortStatus, type CohortTap } from "@top-pad/contract";
import { cohortMembers, cohortTaps, type Db } from "@top-pad/db";
import { failureMessage, raiseAlert, resolveAlert, runJob } from "@top-pad/jobs";
import { currentCreatorWallet, sessionCreator, type SessionCreator } from "./auth";
import type { Bindings, Config, SecretBinding } from "./env";
import type { AppEnv } from "./http";
import { confirmed, preflightRefusal, sendWire, TransactionFailed } from "./send";

type TapRow = typeof cohortTaps.$inferSelect;

/** How long a tap request waits for its transfer to confirm before answering `sending`, which the cron settles. */
const CONFIRM_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(3);

/** The tap on this cluster, or null where there is none: no tap address, or no key bound to this deployment. */
export function tapOf(cfg: Config, env: Bindings): { address: Address; key: SecretBinding } | null {
  const address = cfg.heat?.keys?.tap;
  const key = env.TAP_KEY;
  if (!address || !key) return null;
  return { address, key: typeof key === "string" ? { get: async () => key } : key };
}

/** Reads the tap key from its binding, and refuses one that is not the tap the cluster records. */
export async function loadTap(binding: SecretBinding, expected: Address): Promise<KeyPairSigner> {
  let secret: Uint8Array;
  try {
    secret = Uint8Array.from(JSON.parse(await binding.get()) as number[]);
  } catch {
    throw new Error("the tap key binding does not hold a keypair array");
  }
  if (secret.length !== 64) throw new Error("the tap key binding does not hold a 64-byte keypair");
  const signer = await createKeyPairSignerFromBytes(secret);
  if (signer.address !== expected) throw new Error(`the bound tap key is ${signer.address}, not ${expected}`);
  return signer;
}

/** The tap's float against its floor: an alert while it is below, resolved once it is topped up. */
export async function checkTapFloat(db: Db, rpc: Rpc<GetBalanceApi>, tap: Address, floor: bigint) {
  const { value: lamports } = await rpc.getBalance(tap, { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const claims = lamports < TAP_RESERVE_LAMPORTS ? 0n : (lamports - TAP_RESERVE_LAMPORTS) / TAP_LAMPORTS;
  if (lamports < floor) {
    await raiseAlert(
      db,
      "tap_low_balance",
      tap,
      `The cohort tap ${tap} holds ${sol(lamports)} SOL, below its ${sol(floor)} SOL floor: ${claims} more member${claims === 1n ? "" : "s"} can be paid. Top it up from the bank.`,
    );
  } else {
    await resolveAlert(db, "tap_low_balance", tap);
  }
  return { tap, lamports: lamports.toString(), floor: floor.toString(), low: lamports < floor, claimsLeft: Number(claims) };
}

const tapView = (row: TapRow): CohortTap => ({
  wallet: row.wallet,
  lamports: row.lamports.toString(),
  signature: row.signature,
  status: row.status === "sent" ? "sent" : "sending",
  at: row.createdAt.toISOString(),
});

/** The tap that holds this record, its X account or its wallet, if any did not fail. */
async function standingTap(db: Db, o: { creatorId: string; xUserId: string | null; wallet: string | null }) {
  const holders = [eq(cohortTaps.creatorId, o.creatorId)];
  if (o.xUserId) holders.push(eq(cohortTaps.xUserId, o.xUserId));
  if (o.wallet) holders.push(eq(cohortTaps.wallet, o.wallet));
  const rows = await db
    .select()
    .from(cohortTaps)
    .where(and(ne(cohortTaps.status, "failed"), or(...holders)));
  // The record's own tap first, then one its X account or wallet had under another record.
  return rows.find((r) => r.creatorId === o.creatorId) ?? rows[0] ?? null;
}

async function tapBalance(cfg: Config, env: Bindings) {
  const tap = tapOf(cfg, env);
  if (!tap) return null;
  const { value } = await createSolanaRpc(cfg.rpcUrl).getBalance(tap.address, { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  return value;
}

async function statusOf(c: Context<AppEnv>, creator: SessionCreator, balance?: bigint | null): Promise<CohortStatus> {
  const db = c.var.db;
  const [member] = await db.select().from(cohortMembers).where(eq(cohortMembers.creatorId, creator.id));
  const wallet = await currentCreatorWallet(db, creator.id);
  const tap = await standingTap(db, { creatorId: creator.id, xUserId: null, wallet: null });
  const lamports = balance === undefined ? await tapBalance(c.var.cfg, c.env) : balance;
  return CohortStatus.parse({
    member: !!member,
    joinedAt: member?.joinedAt.toISOString() ?? null,
    xHandle: creator.xHandle,
    creatorWallet: wallet,
    tap: tap ? tapView(tap) : null,
    tapLamports: TAP_LAMPORTS.toString(),
    tapOpen: lamports !== null && lamports >= TAP_LAMPORTS + TAP_RESERVE_LAMPORTS,
  });
}

const refuse = (c: Context<AppEnv>, status: 401 | 403 | 409 | 502 | 503, body: CohortRefusal) => c.json(CohortRefusal.parse(body), status);

/** `GET /cohort`: the cohort as this browser's record stands in it, or null when the browser is signed out. */
export async function getCohort(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return c.json(null);
  return c.json(await statusOf(c, creator));
}

/** `POST /cohort/join`: the signed-in record joins the cohort, X linked or not; joining again changes nothing. */
export async function joinCohort(c: Context<AppEnv>) {
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { code: "signed_out", error: "Sign in with your wallet to join the cohort." });
  await c.var.db.insert(cohortMembers).values({ creatorId: creator.id }).onConflictDoNothing();
  return c.json(await statusOf(c, creator));
}

const uniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.cause?.code ?? err.code) === "23505";
};

/**
 * `POST /cohort/tap`: 1 devnet SOL, once, to the signed-in record's Creator wallet, when the record linked X. Tapping
 * joins the cohort too. The transfer is signed and written before it is sent, so a second request, or the same one sent
 * twice, finds the first and is refused; if it confirms within 30 s the answer says `sent`, otherwise `sending`, and the
 * cron settles it from its signature.
 */
export async function tapCohort(c: Context<AppEnv>) {
  const { db, cfg } = c.var;
  const tap = tapOf(cfg, c.env);
  if (!tap) return refuse(c, 503, { code: "tap_closed", error: `There is no cohort tap on ${cfg.cluster}.` });
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { code: "signed_out", error: "Sign in with your wallet to get your devnet SOL." });
  if (!creator.xUserId || !creator.xHandle) {
    return refuse(c, 403, { code: "x_required", error: "The tap gives devnet SOL to members who linked X. Link your X account, then tap again." });
  }
  const wallet = await currentCreatorWallet(db, creator.id);
  if (!wallet) return refuse(c, 409, { code: "no_wallet", error: "Sign in with your wallet first: the tap pays your Creator wallet." });
  await db.insert(cohortMembers).values({ creatorId: creator.id }).onConflictDoNothing();

  const claimed = (row: TapRow) =>
    refuse(c, 409, {
      code: "claimed",
      error:
        row.creatorId === creator.id
          ? "You had your devnet SOL from the tap already: it gives once."
          : row.xUserId === creator.xUserId
            ? `@${creator.xHandle} had its devnet SOL from the tap already: it gives once an X account.`
            : "This wallet had its devnet SOL from the tap already: it gives once a wallet.",
      tap: row.creatorId === creator.id ? tapView(row) : null,
    });
  const before = await standingTap(db, { creatorId: creator.id, xUserId: creator.xUserId, wallet });
  if (before) return claimed(before);

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const floor = cfg.tapFloatMinLamports;
  const { value: balance } = await rpc.getBalance(tap.address, { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (balance < TAP_LAMPORTS + TAP_RESERVE_LAMPORTS) {
    await checkTapFloat(db, rpc, tap.address, floor);
    return refuse(c, 503, { code: "tap_empty", error: "The tap has run dry for now. Heat has been told; try again later." });
  }

  const signer = await loadTap(tap.key, tap.address);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const signed = await signTransactionMessageWithSigners(tapTransferMessage({ tap: signer, to: wallet as Address, lamports: TAP_LAMPORTS, blockhash }));
  const signature = getSignatureFromTransaction(signed);
  let row: TapRow;
  try {
    [row] = (await db
      .insert(cohortTaps)
      .values({
        creatorId: creator.id,
        xUserId: creator.xUserId,
        xHandle: creator.xHandle,
        wallet,
        lamports: TAP_LAMPORTS,
        signature,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      })
      .returning()) as [TapRow];
  } catch (e) {
    if (!uniqueViolation(e)) throw e;
    const raced = await standingTap(db, { creatorId: creator.id, xUserId: creator.xUserId, wallet });
    if (raced) return claimed(raced);
    throw e;
  }

  const fail = async (error: string) => {
    await db.update(cohortTaps).set({ status: "failed", error, settledAt: new Date() }).where(eq(cohortTaps.id, row.id));
  };
  try {
    await sendWire(rpc, getBase64EncodedWireTransaction(signed));
  } catch (e) {
    // The preflight refused it, so it never went out: the claim is freed for another try.
    const reason = preflightRefusal(e);
    await fail(reason);
    console.error(`the cohort tap's transfer ${signature} was refused`, e);
    return refuse(c, 502, { code: "tap_failed", error: `The tap's transfer was refused, and nothing was sent: ${reason}. Try again in a moment.` });
  }
  try {
    await confirmed(rpc, signature, CONFIRM_MS);
    [row] = (await db.update(cohortTaps).set({ status: "sent", settledAt: new Date() }).where(eq(cohortTaps.id, row.id)).returning()) as [TapRow];
  } catch (e) {
    if (e instanceof TransactionFailed) {
      await fail(failureMessage(e));
      return refuse(c, 502, { code: "tap_failed", error: "The tap's transfer failed on chain, and nothing was sent. Try again in a moment." });
    }
    // Not confirmed yet: it may still land, and the cron settles it from its signature.
  }
  // The float as this tap left it, recorded as a run of its own, so the operator's page reads the newest reading.
  const run = await runJob(db, "cohort-tap-float", async () => ({ float: await checkTapFloat(db, rpc, tap.address, floor) })).catch((e) => {
    console.error("checking the tap's float failed", e);
    return null;
  });
  const after = (run?.summary as { float?: { lamports: string } } | null)?.float;
  return c.json(await statusOf(c, creator, after ? BigInt(after.lamports) : null));
}

/**
 * The cron's `cohort-tap` job: settles every tap still `sending` from its signature (landed, failed, or expired unlanded,
 * which frees the claim for another try), then checks the tap's float against its floor.
 */
export async function settleTaps(db: Db, cfg: Config, env: Bindings) {
  const tap = tapOf(cfg, env);
  if (!tap) return { skipped: "no tap on this cluster" };
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const sending = await db.select().from(cohortTaps).where(eq(cohortTaps.status, "sending"));
  const settled = { sent: 0, failed: 0, waiting: 0 };
  if (sending.length > 0) {
    const limit = { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) };
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send(limit);
    const { value } = await rpc.getSignatureStatuses(sending.map((r) => r.signature as Signature), { searchTransactionHistory: true }).send(limit);
    const sent: string[] = [];
    for (const [i, row] of sending.entries()) {
      const status = value[i];
      if (status?.err) {
        await db
          .update(cohortTaps)
          .set({ status: "failed", error: JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v)), settledAt: new Date() })
          .where(eq(cohortTaps.id, row.id));
        settled.failed++;
      } else if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        sent.push(row.id);
      } else if (!status && height > row.lastValidBlockHeight) {
        await db.update(cohortTaps).set({ status: "failed", error: "expired unlanded", settledAt: new Date() }).where(eq(cohortTaps.id, row.id));
        settled.failed++;
      } else {
        settled.waiting++;
      }
    }
    if (sent.length > 0) await db.update(cohortTaps).set({ status: "sent", settledAt: new Date() }).where(inArray(cohortTaps.id, sent));
    settled.sent = sent.length;
  }
  const float = await checkTapFloat(db, rpc, tap.address, cfg.tapFloatMinLamports);
  return { ...settled, float };
}
