// What a Fair Open's page and its coin's page show after the open (spec 2.1 steps 13 and 14; spec 9): the Creator lock
// and the Tax Share, and a depositor's seat once it has closed. All of it comes from the indexer, which keeps it after
// the seats and the launch account close.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { seatAddress, tierCap, Tier } from "@top-pad/chain";
import type { CreatorLock, FairOpenSeat, TaxShare } from "@top-pad/contract";
import { fairOpens, fairOpenSeatEvents, type Db } from "@top-pad/db";
import { explorerUrl, type Config } from "./env";

type FairOpenRow = typeof fairOpens.$inferSelect;
type SeatEventRow = typeof fairOpenSeatEvents.$inferSelect;

/** The Creator lock: its escrow once it has run, or whether the Creator wallet holds a seat it waits for. */
export async function creatorLockOf(cfg: Config, db: Db, row: FairOpenRow): Promise<CreatorLock> {
  if (row.lockedAt) {
    const [lock] = await db
      .select({ deposit: fairOpenSeatEvents.deposit })
      .from(fairOpenSeatEvents)
      .where(and(eq(fairOpenSeatEvents.launch, row.launch), eq(fairOpenSeatEvents.kind, "lock")));
    return {
      status: "locked",
      deposit: lock ? `${lock.deposit}` : null,
      coins: `${row.lockCoins ?? 0n}`,
      escrow: row.lockEscrow,
      cliffAt: row.lockCliffAt?.toISOString() ?? null,
      endsAt: row.lockEndsAt?.toISOString() ?? null,
      explorer: row.lockEscrow ? explorerUrl(cfg, "address", row.lockEscrow) : null,
    };
  }
  // What the Creator wallet's seat holds after its latest deposit or withdrawal.
  const [latest] = await db
    .select({ deposit: fairOpenSeatEvents.deposit })
    .from(fairOpenSeatEvents)
    .where(
      and(eq(fairOpenSeatEvents.launch, row.launch), eq(fairOpenSeatEvents.wallet, row.creator), inArray(fairOpenSeatEvents.kind, ["deposit", "withdraw"])),
    )
    .orderBy(desc(fairOpenSeatEvents.slot), desc(fairOpenSeatEvents.eventIndex))
    .limit(1);
  const deposit = latest?.deposit ?? 0n;
  return { status: deposit > 0n ? "pending" : "none", deposit: deposit > 0n ? `${deposit}` : null, coins: null, escrow: null, cliffAt: null, endsAt: null, explorer: null };
}

/** The Tax Share once collected, with how many seats have been paid theirs; null until then. */
export async function taxShareOf(cfg: Config, db: Db, row: FairOpenRow): Promise<TaxShare | null> {
  if (!row.taxShareCollectedAt || row.taxShare === null) return null;
  const [paid] = await db
    .select({ seats: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${fairOpenSeatEvents.amount}), 0)::text` })
    .from(fairOpenSeatEvents)
    .where(and(eq(fairOpenSeatEvents.launch, row.launch), eq(fairOpenSeatEvents.kind, "tax_share")));
  return {
    total: `${row.taxShare}`,
    fees: `${row.taxShareFees ?? 0n}`,
    dust: `${row.taxShareDust ?? 0n}`,
    toTreasury: row.taxShareToTreasury ?? false,
    paidSeats: paid?.seats ?? 0,
    paid: paid?.amount ?? "0",
    collectedAt: row.taxShareCollectedAt.toISOString(),
    explorer: explorerUrl(cfg, "tx", row.taxShareSignature!),
  };
}

/**
 * How many seats have their coins and refund, by the indexer, and what they deposited: each delivery, and the creator's
 * lock, carry the deposit the seat bought with.
 */
export async function deliveredSeats(db: Db, launch: string): Promise<{ seats: number; deposited: bigint }> {
  const [found] = await db
    .select({ seats: sql<number>`count(*)::int`, deposited: sql<string>`coalesce(sum(${fairOpenSeatEvents.deposit}), 0)::text` })
    .from(fairOpenSeatEvents)
    .where(and(eq(fairOpenSeatEvents.launch, launch), inArray(fairOpenSeatEvents.kind, ["delivery", "lock"])));
  return { seats: found?.seats ?? 0, deposited: BigInt(found?.deposited ?? "0") };
}

/**
 * A wallet's seat after it has closed, by the Tax Share or the Creator lock, told from its events: what it deposited
 * and at what tier, what it spent, bought and got back, and its Tax Share. Null if the wallet held no seat that closed
 * after an open.
 */
export async function closedSeatOf(db: Db, launch: string, wallet: string): Promise<FairOpenSeat | null> {
  const events: SeatEventRow[] = await db
    .select()
    .from(fairOpenSeatEvents)
    .where(and(eq(fairOpenSeatEvents.launch, launch), eq(fairOpenSeatEvents.wallet, wallet)))
    .orderBy(fairOpenSeatEvents.slot, fairOpenSeatEvents.eventIndex);
  const closing = events.findLast((e) => e.kind === "tax_share" || e.kind === "lock");
  if (!closing) return null;
  const bought = events.findLast((e) => e.kind === "delivery" || e.kind === "lock");
  const tierName = events.findLast((e) => e.kind === "deposit")?.tier ?? "unverified";
  const tier = tierName === "verified" ? Tier.Verified : tierName === "scored" ? Tier.Scored : Tier.Unverified;
  const deposit = bought?.deposit ?? 0n;
  const spent = bought?.spent ?? 0n;
  return {
    address: await seatAddress(launch as never, Uint8Array.from(closing.person.match(/../g)!.map((b) => parseInt(b, 16)))),
    tier: tierName,
    cap: `${tierCap(tier)}`,
    deposit: `${deposit}`,
    seatRent: "0",
    coinRent: "0",
    fill: `${spent}`,
    refund: `${deposit - spent}`,
    coins: `${bought?.coins ?? 0n}`,
    delivered: true,
    taxShare: closing.kind === "tax_share" ? `${closing.amount}` : null,
    closed: true,
  };
}
