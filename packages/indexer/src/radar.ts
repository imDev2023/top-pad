// Bundle Radar (spec 6.4, 6.5): what it labels on a Heat coin, worked out from what the indexer wrote, so the labels
// follow the chain within seconds and never disagree with it. After the open it only labels, each label with its
// evidence: buys in the creation slot; buys in the four positions right after the creation transaction; buys in the
// creation's Jito bundle (mainnet only); and wallets directly linked to the Creator wallet, by the Creator wallet signing
// or paying for their buy or deposit, or by SOL or coins passed between them in the 7 days before the open or after it.
// Only those direct links can put a wallet in a case; buying in the creation slot alone is timing, a label and no more.
import { and, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { COIN_SUPPLY } from "@top-pad/chain";
import { coins, fairOpens, fairOpenSeatEvents, indexedTransactions, jitoBundles, pools, trades, transfers, type Db } from "@top-pad/db";
import { scanFunding, type FundingSource } from "./funding";

const HOUR_MS = 60 * 60 * 1000;
/** The funding graph's reach either side of a coin's open (spec 6.5). */
export const FUNDING_WINDOW_MS = 7 * 24 * HOUR_MS;
/** What the floor counts: the pot and the first hour of trading (spec 6.5). */
export const FIRST_HOUR_MS = HOUR_MS;
/** The positions after the creation transaction a bundle fills: a Jito bundle holds at most five transactions. */
export const POSITIONS_AFTER_CREATION = 4;
/** The floor: linked wallets must have bought 1% of supply between them for a case (spec 6.5). */
export const CASE_FLOOR = COIN_SUPPLY / 100n;

/**
 * Bundle Radar's labels. `same_slot` is timing alone and only ever labels; the others are direct links to the Creator
 * wallet, which can put a wallet in a case.
 */
export type RadarLabel = "same_slot" | "after_creation" | "jito_bundle" | "creator_signed" | "creator_funded";
export const DIRECT_LINKS: ReadonlySet<RadarLabel> = new Set(["after_creation", "jito_bundle", "creator_signed", "creator_funded"]);

export type RadarBuy = {
  signature: string;
  eventIndex: number;
  slot: number;
  at: Date;
  quoteAmount: bigint;
  baseAmount: bigint;
  fee: bigint;
  /** Its transaction's place after the creation transaction, in the creation slot (1 is right after it); else null. */
  position: number | null;
  /** The Jito bundle it landed in, as Jito's record says (mainnet only). */
  jitoBundle: string | null;
  /** Whether it ran in the first hour, so counts toward the floor for a linked wallet. */
  firstHour: boolean;
  labels: RadarLabel[];
};

export type RadarDeposit = { signature: string; at: Date; amount: bigint; creatorSigned: boolean };

export type RadarTransfer = { signature: string; ordinal: number; slot: number; at: Date; source: string; destination: string; asset: string; amount: bigint };

export type RadarWallet = {
  wallet: string;
  /** The Creator wallet itself: its open buys are labelled, never counted toward a case (spec 6.5's floor). */
  creator: boolean;
  /** Directly linked to the Creator wallet. */
  linked: boolean;
  labels: RadarLabel[];
  /** A linked wallet's buys in the 7 days after the open; any other wallet's labelled buys. */
  buys: RadarBuy[];
  /** Its deposits into the coin's Fair Open pot, and the coins its seat bought. */
  deposits: RadarDeposit[];
  potCoins: bigint;
  /** Its direct transfers with the Creator wallet in the funding window. */
  transfers: RadarTransfer[];
  /** What it bought across the pot and the first hour, in raw units: what a linked wallet adds toward the floor. */
  counted: bigint;
};

export type Radar = {
  mint: string;
  pool: string;
  launchMode: "instant" | "fair_open";
  creatorWallet: string;
  creatorId: string | null;
  /** When trading opened: the funding window and the first hour count from here. */
  openedAt: Date;
  creation: { signature: string; slot: number; blockIndex: number | null; jitoBundle: string | null };
  supply: bigint;
  floor: bigint;
  /** The wallets other than the Creator wallet directly linked to it, and what they bought toward the floor. */
  linkedWallets: number;
  linkedCoins: bigint;
  /** Linked wallets first, most counted first; then the labelled ones, earliest buy first. */
  wallets: RadarWallet[];
};

/** A Heat coin as Bundle Radar reads it, or null for a pool our launch key never co-signed (spec 2.4). */
async function coinOf(db: Db, mint: string) {
  const [row] = await db
    .select({
      mint: coins.mint,
      pool: coins.pool,
      launchMode: coins.launchMode,
      creatorWallet: coins.creatorWallet,
      creatorId: coins.creatorId,
      createdSignature: coins.createdSignature,
      createdSlot: coins.createdSlot,
      openedAt: pools.activatedAt,
      creationIndex: indexedTransactions.blockIndex,
      creationIndexed: indexedTransactions.signature,
    })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(indexedTransactions, eq(indexedTransactions.signature, coins.createdSignature))
    .where(eq(coins.mint, mint));
  return row ?? null;
}

/** Everything Bundle Radar labels on a coin, with its evidence and the floor's count; null for a coin not Heat's. */
export async function radarOf(db: Db, mint: string): Promise<Radar | null> {
  const coin = await coinOf(db, mint);
  if (!coin) return null;
  const creator = coin.creatorWallet;
  const opened = coin.openedAt.getTime();
  const from = new Date(opened - FUNDING_WINDOW_MS);
  const to = new Date(opened + FUNDING_WINDOW_MS);
  const firstHourEnds = opened + FIRST_HOUR_MS;

  const [creationJito] = await db.select({ bundleId: jitoBundles.bundleId }).from(jitoBundles).where(eq(jitoBundles.signature, coin.createdSignature));
  const creationBundle = creationJito?.bundleId ?? null;

  // The Creator wallet's direct transfers in the window, by the other wallet.
  const transferRows = await db
    .select()
    .from(transfers)
    .where(and(or(eq(transfers.source, creator), eq(transfers.destination, creator)), gte(transfers.at, from), lte(transfers.at, to)))
    .orderBy(transfers.at, transfers.signature, transfers.ordinal);
  const funded = new Map<string, RadarTransfer[]>();
  for (const t of transferRows) {
    const other = t.source === creator ? t.destination : t.source;
    funded.set(other, [...(funded.get(other) ?? []), { ...t, amount: BigInt(t.amount) }]);
  }
  const fundedWallets = [...funded.keys()];

  // The buys that may carry a label: in the creation slot, by a wallet the Creator wallet passed funds with, signed or
  // paid for by the Creator wallet, or in a Jito bundle. The pot's own buy, in the creation transaction, is the
  // labelled keeper's (spec 9), never a label.
  const buysOf = (match: SQL) =>
    db
      .select({ trade: trades, signers: indexedTransactions.signers, jitoBundle: jitoBundles.bundleId })
      .from(trades)
      .leftJoin(indexedTransactions, eq(indexedTransactions.signature, trades.signature))
      .leftJoin(jitoBundles, eq(jitoBundles.signature, trades.signature))
      .where(and(eq(trades.mint, mint), eq(trades.side, "buy"), sql`${trades.signature} <> ${coin.createdSignature}`, lt(trades.at, to), match))
      .orderBy(trades.orderKey);
  const buyRows = await buysOf(
    or(
      eq(trades.slot, coin.createdSlot),
      fundedWallets.length ? inArray(trades.trader, fundedWallets) : sql`false`,
      sql`${creator} = any(${indexedTransactions.signers})`,
      sql`${jitoBundles.bundleId} is not null`,
    )!,
  );

  const wallets = new Map<string, RadarWallet>();
  const walletOf = (wallet: string): RadarWallet => {
    let w = wallets.get(wallet);
    if (!w) {
      w = { wallet, creator: wallet === creator, linked: false, labels: [], buys: [], deposits: [], potCoins: 0n, transfers: funded.get(wallet) ?? [], counted: 0n };
      wallets.set(wallet, w);
    }
    return w;
  };
  const seen = new Set<string>();
  const addBuy = ({ trade, signers, jitoBundle }: (typeof buyRows)[number]) => {
    const key = `${trade.signature}:${trade.eventIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    const own = trade.trader === creator;
    const sameSlot = trade.slot === coin.createdSlot;
    const position = sameSlot && coin.creationIndex !== null && trade.blockIndex > coin.creationIndex ? trade.blockIndex - coin.creationIndex : null;
    const labels: RadarLabel[] = [];
    if (sameSlot) labels.push("same_slot");
    if (position !== null && position <= POSITIONS_AFTER_CREATION) labels.push("after_creation");
    if (creationBundle && jitoBundle === creationBundle) labels.push("jito_bundle");
    if (!own && signers?.includes(creator)) labels.push("creator_signed");
    walletOf(trade.trader).buys.push({
      signature: trade.signature,
      eventIndex: trade.eventIndex,
      slot: trade.slot,
      at: trade.at,
      quoteAmount: trade.quoteAmount,
      baseAmount: trade.baseAmount,
      fee: trade.fee,
      position,
      jitoBundle,
      firstHour: trade.at.getTime() < firstHourEnds,
      labels,
    });
  };
  buyRows.forEach(addBuy);

  // A Fair Open's pot: deposits the Creator wallet signed or paid for, and what each seat bought at the open.
  const [launch] = coin.launchMode === "fair_open" ? await db.select({ launch: fairOpens.launch }).from(fairOpens).where(eq(fairOpens.mint, mint)) : [];
  const seatRows = launch
    ? await db
        .select({ event: fairOpenSeatEvents, signers: indexedTransactions.signers })
        .from(fairOpenSeatEvents)
        .leftJoin(indexedTransactions, eq(indexedTransactions.signature, fairOpenSeatEvents.signature))
        .where(and(eq(fairOpenSeatEvents.launch, launch.launch), inArray(fairOpenSeatEvents.kind, ["deposit", "delivery"])))
        .orderBy(fairOpenSeatEvents.slot, fairOpenSeatEvents.eventIndex)
    : [];
  const signedFor = new Set(seatRows.filter((r) => r.event.kind === "deposit" && r.event.wallet !== creator && r.signers?.includes(creator)).map((r) => r.event.wallet));

  // The wallets directly linked to the Creator wallet, however each is linked; every buy of theirs in the window is
  // evidence, and their first hour's buys and their seats count toward the floor (spec 6.5). The Creator wallet's own
  // buys and its own seat, the Creator lock, are open and never counted.
  const linkedWallets = new Set([...funded.keys(), ...signedFor, ...buyRows.filter((r) => directlyLinked(r.trade.trader)).map((r) => r.trade.trader)]);
  linkedWallets.delete(creator);
  function directlyLinked(wallet: string) {
    return wallets.get(wallet)?.buys.some((b) => b.labels.some((l) => DIRECT_LINKS.has(l))) ?? false;
  }
  const unseen = [...linkedWallets].filter((w) => !funded.has(w));
  if (unseen.length) (await buysOf(inArray(trades.trader, unseen))).forEach(addBuy);
  for (const { event, signers } of seatRows) {
    if (!linkedWallets.has(event.wallet)) continue;
    const w = walletOf(event.wallet);
    if (event.kind === "deposit") w.deposits.push({ signature: event.signature, at: event.at, amount: event.amount, creatorSigned: !!signers?.includes(creator) });
    else w.potCoins += event.coins ?? 0n;
  }
  for (const w of wallets.values()) w.buys.sort((a, b) => a.slot - b.slot || a.at.getTime() - b.at.getTime());

  for (const w of wallets.values()) {
    const labels = new Set(w.buys.flatMap((b) => b.labels));
    if (!w.creator && w.transfers.length) labels.add("creator_funded");
    if (w.deposits.some((d) => d.creatorSigned)) labels.add("creator_signed");
    w.labels = (["same_slot", "after_creation", "jito_bundle", "creator_signed", "creator_funded"] as const).filter((l) => labels.has(l));
    w.linked = linkedWallets.has(w.wallet);
    // A wallet not linked shows only its labelled buys.
    if (!w.linked) w.buys = w.buys.filter((b) => b.labels.length);
    w.counted = w.buys.filter((b) => b.firstHour).reduce((sum, b) => sum + b.baseAmount, 0n) + w.potCoins;
  }

  const shown = [...wallets.values()].filter((w) => w.labels.length);
  const linked = shown.filter((w) => w.linked).sort((a, b) => (b.counted > a.counted ? 1 : b.counted < a.counted ? -1 : 0));
  const labelled = shown.filter((w) => !w.linked).sort((a, b) => firstAt(a) - firstAt(b));
  return {
    mint,
    pool: coin.pool,
    launchMode: coin.launchMode,
    creatorWallet: creator,
    creatorId: coin.creatorId,
    openedAt: coin.openedAt,
    creation: { signature: coin.createdSignature, slot: coin.createdSlot, blockIndex: coin.creationIndex, jitoBundle: creationBundle },
    supply: COIN_SUPPLY,
    floor: CASE_FLOOR,
    linkedWallets: linked.length,
    linkedCoins: linked.reduce((sum, w) => sum + w.counted, 0n),
    wallets: [...linked, ...labelled],
  };
}

const firstAt = (w: RadarWallet) => Math.min(...w.buys.map((b) => b.at.getTime()), ...w.deposits.map((d) => d.at.getTime()));

/** Jito's public record of which bundle a transaction landed in (mainnet only). */
export type JitoSource = { bundleOf(signature: string): Promise<string | null> };

/**
 * Jito's public bundle API (spec 6.4, 11.5): no key, one call a transaction. It answers 404 with "Bundle not found" for a
 * transaction that landed in no bundle (checked 2026-11-02), and a list holding the bundle's id for one that did.
 */
export function jitoApi(base = "https://bundles.jito.wtf", fetchImpl: typeof fetch = fetch): JitoSource {
  return {
    async bundleOf(signature) {
      const res = await fetchImpl(`${base}/api/v1/bundles/transaction/${signature}`, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Jito's bundle API answered ${res.status}`);
      const body = (await res.json()) as { bundle_id?: string }[];
      return body[0]?.bundle_id ?? null;
    },
  };
}

export type RadarSources = {
  funding: FundingSource;
  /** A transaction's place in its block, for a creation transaction indexed before positions were recorded. */
  blockIndexOf?: (slot: number, signature: string) => Promise<number>;
  /** Jito's record, on mainnet only. */
  jito?: JitoSource | null;
};

/**
 * Brings what Bundle Radar reads about a coin up to date with the chain: the Creator wallet's transfers over the funding
 * window, the creation transaction's place in its block when it was indexed without it, and on mainnet the Jito bundles
 * of the creation and its slot's buys, reading at most `maxReads` transactions. Null for a coin not Heat's, for a buy
 * at `boughtAt` past the coin's first hour, or for a launch or buy longer than `recentMs` ago; else how many transfers it found, and whether the funding window is read
 * through (a busy Creator wallet takes several scans), and how many transactions that took.
 */
export async function refreshRadar(
  db: Db,
  sources: RadarSources,
  mint: string,
  { boughtAt, maxReads, recentMs }: { boughtAt?: Date; maxReads?: number; recentMs?: number } = {},
): Promise<{ recorded: number; read: number; complete: boolean } | null> {
  const coin = await coinOf(db, mint);
  if (!coin) return null;
  // Live, the indexer reads on for a launch and its first hour's buys, what a case counts, as they happen; a later buy,
  // or a past one indexed late by reconciliation, is left to the case job, so catching up never floods the RPC.
  if (boughtAt && boughtAt.getTime() >= coin.openedAt.getTime() + FIRST_HOUR_MS) return null;
  if (recentMs !== undefined && Date.now() - (boughtAt ?? coin.openedAt).getTime() > recentMs) return null;
  if (coin.creationIndexed && coin.creationIndex === null && sources.blockIndexOf) {
    const blockIndex = await sources.blockIndexOf(coin.createdSlot, coin.createdSignature);
    await db.update(indexedTransactions).set({ blockIndex }).where(eq(indexedTransactions.signature, coin.createdSignature));
  }
  const { recorded, read, complete } = await scanFunding(db, sources.funding, coin.creatorWallet, new Date(coin.openedAt.getTime() - FUNDING_WINDOW_MS), { maxReads });
  if (sources.jito) {
    const slotBuys = await db
      .selectDistinct({ signature: trades.signature })
      .from(trades)
      .leftJoin(jitoBundles, eq(jitoBundles.signature, trades.signature))
      .where(and(eq(trades.mint, mint), eq(trades.slot, coin.createdSlot), sql`${jitoBundles.signature} is null`));
    const [creation] = await db.select().from(jitoBundles).where(eq(jitoBundles.signature, coin.createdSignature));
    const unchecked = [...(creation ? [] : [coin.createdSignature]), ...slotBuys.map((b) => b.signature).filter((s) => s !== coin.createdSignature)];
    for (const signature of unchecked) {
      const bundleId = await sources.jito.bundleOf(signature);
      await db.insert(jitoBundles).values({ signature, bundleId }).onConflictDoNothing();
    }
  }
  return { recorded, read, complete };
}
