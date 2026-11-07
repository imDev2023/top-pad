// The linkage pipeline (spec 6.3, research in #5): it ties a person's wallets together before they deposit, so they
// become one admission with one cap. A wallet's first funding, the first SOL anyone sent it, is a fact that never
// changes; following it up from wallet to funder, through the single-use hop wallets a farm passes its SOL through, and
// on through any funder that is not a hub, reaches the wallet the money came from: its root. Wallets with one root are
// one person. Exchanges, faucets, Heat's own keys and any wallet too busy to read back (a full page of history) are hubs:
// funding from one ties nobody together, so the chain stops below it, the method Bubblemaps and Arbitrum's airdrop use.
// Only first funding is followed here; the sweep graph, exchange time windows and co-activity (#5) only ever label.
import { eq } from "drizzle-orm";
import { walletFundings, type Db } from "@top-pad/db";
import { SOL, transfersIn, type DatedSignature, type FundingSource } from "./funding";

/** A full page of signatures: a wallet with this much history is a hub, never read back to its first funding. */
export const BUSY_HISTORY = 1_000;
/** A wallet with this little history, its funding in and its forwarding out, is a pass-through (hop) wallet. */
export const PASS_THROUGH_HISTORY = 3;
/** How far up the funding chain a trace goes. */
export const MAX_DEPTH = 8;
/** The oldest transactions read for a wallet's first funding: past them, it was not funded by a plain transfer. */
const FIRST_READS = 4;
/** A found first funding never changes, but how busy its wallet is does: read again after a day. */
const FUNDED_FRESH_MS = 24 * 3600_000;
/** A wallet found unfunded with less history than the reads may be funded any moment: read again after a minute. */
const UNFUNDED_FRESH_MS = 60_000;

/** The first SOL sent to a wallet, and how busy its history is. */
export type FirstFunding = {
  wallet: string;
  funder: string | null;
  signature: string | null;
  /** Lamports. */
  amount: bigint | null;
  at: Date | null;
  /** Signatures its history listed, at most `BUSY_HISTORY`. */
  history: number;
};

/** A transaction the node does not serve yet stops a trace: what it would find is unknown, so nothing is concluded. */
export class FundingUnreadable extends Error {}

const busy = (f: Pick<FirstFunding, "history">) => f.history >= BUSY_HISTORY;

/**
 * A wallet's first funding, from the database while it is fresh, else read from the chain: its history newest first,
 * one page, and if that is not full, its oldest transactions until one sends it SOL.
 */
export async function firstFunding(db: Db, source: FundingSource, wallet: string, now = Date.now()): Promise<FirstFunding> {
  const [row] = await db.select().from(walletFundings).where(eq(walletFundings.wallet, wallet));
  const known = row && {
    wallet,
    funder: row.funder,
    signature: row.signature,
    amount: row.amount === null ? null : BigInt(row.amount),
    at: row.fundedAt,
    history: row.history,
  };
  // Once its oldest transactions are read, newer ones cannot change a wallet's first funding, only how busy it is.
  const settled = known && (known.funder || known.history >= FIRST_READS);
  if (known && now - row.checkedAt.getTime() < (settled ? FUNDED_FRESH_MS : UNFUNDED_FRESH_MS)) return known;

  const page: DatedSignature[] = await source.listSignatures(wallet, { limit: BUSY_HISTORY });
  let found: FirstFunding = { wallet, funder: null, signature: null, amount: null, at: null, history: page.length };
  if (known?.funder) {
    found = { ...known, history: Math.max(known.history, page.length) };
  } else if (page.length < BUSY_HISTORY) {
    const oldestFirst = page.filter((s) => !s.failed).reverse().slice(0, FIRST_READS);
    for (const listed of oldestFirst) {
      const tx = await source.fetchParsed(listed.signature);
      if (!tx) throw new FundingUnreadable(`the node does not serve ${listed.signature} yet`);
      const into = transfersIn(tx, wallet).find((t) => t.asset === SOL && t.destination === wallet);
      if (!into) continue;
      const blockTime = tx.blockTime ?? listed.blockTime;
      found = { ...found, funder: into.source, signature: listed.signature, amount: into.amount, at: blockTime === null ? null : new Date(blockTime * 1000) };
      break;
    }
  }
  const values = {
    funder: found.funder,
    signature: found.signature,
    amount: found.amount === null ? null : found.amount.toString(),
    fundedAt: found.at,
    history: found.history,
    checkedAt: new Date(now),
  };
  await db.insert(walletFundings).values({ wallet, ...values }).onConflictDoUpdate({ target: walletFundings.wallet, set: values });
  return found;
}

/** One step up a funding chain: `funder` sent `wallet` its first SOL. */
export type FundingStep = {
  wallet: string;
  funder: string;
  signature: string;
  /** Lamports. */
  amount: string;
  at: string | null;
  /** Whether the funder only passed SOL through: a wallet with almost no history of its own. */
  passThrough: boolean;
};

/** Where a wallet's money came from. */
export type FundingTrace = {
  wallet: string;
  /** The wallet whose person this one joins: the top of its funding chain, below any hub; the wallet itself if none. */
  root: string;
  /** Each step from the wallet up to its root. */
  chain: FundingStep[];
  /** Every wallet its money passed through on the way, the root and the hub the chain stopped at included. */
  funders: string[];
};

/**
 * Follows a wallet's first funding up to its root. The chain stops below a hub, at a wallet nobody funded with a plain
 * transfer, at a loop, or after `MAX_DEPTH` steps. Throws `FundingUnreadable` when the node cannot serve a transaction
 * yet, so a caller never mistakes a wallet it could not read for one with nobody behind it.
 */
export async function traceFunding(db: Db, source: FundingSource, wallet: string, hubs: ReadonlySet<string>, now = Date.now()): Promise<FundingTrace> {
  const chain: FundingStep[] = [];
  const funders: string[] = [];
  const seen = new Set([wallet]);
  let current = await firstFunding(db, source, wallet, now);
  while (chain.length < MAX_DEPTH && current.funder && !seen.has(current.funder)) {
    const funder = current.funder;
    funders.push(funder);
    if (hubs.has(funder)) break;
    const above = await firstFunding(db, source, funder, now);
    if (busy(above)) break;
    chain.push({
      wallet: current.wallet,
      funder,
      signature: current.signature!,
      amount: `${current.amount ?? 0n}`,
      at: current.at?.toISOString() ?? null,
      passThrough: above.history <= PASS_THROUGH_HISTORY,
    });
    seen.add(funder);
    current = above;
  }
  return { wallet, root: chain.at(-1)?.funder ?? wallet, chain, funders };
}
