// Bundle Radar from the API's side (spec 6.4, 6.5, 10.2): a coin's labels with their evidence, for its page, and the case
// job. One hour after each open the job reads the Creator wallet's funding window, builds the evidence pack of every
// wallet directly linked to the Creator wallet (its buys and their positions, the Jito bundle ids on mainnet, its
// transfers with the Creator wallet) and opens a case when they bought 1% or more of supply between them across the pot
// and the first hour. The case and its pack go into Postgres, the pack also into R2, for an operator to confirm (spec
// 6.6); nothing bars anyone on its own. Through the 7 days after the open, the job looks again every hour, since
// proceeds sent back to the Creator wallet link a wallet too. A probabilistic label, such as buying in the creation slot,
// never puts a wallet in a case.
import { and, asc, desc, eq, gt, isNull, lte, ne } from "drizzle-orm";
import type { Context } from "hono";
import { Address, BundleRadar, type RadarWallet as RadarWalletView } from "@top-pad/contract";
import { bundleCases, bundleReviews, coins, creators, pools, type Db } from "@top-pad/db";
import { blockPositions, FIRST_HOUR_MS, FUNDING_WINDOW_MS, jitoApi, radarOf, refreshRadar, rpcFundingSource, type Radar, type RadarSources } from "@top-pad/indexer";
import { config, explorerUrl, type BlobStore, type Bindings, type Config } from "./env";
import type { AppEnv } from "./http";

/** What Bundle Radar reads the chain through: the RPC, and on mainnet Jito's public bundle record. */
export function radarSources(cfg: Config): RadarSources {
  return { funding: rpcFundingSource(cfg.rpcUrl), blockIndexOf: blockPositions(cfg.rpcUrl), jito: cfg.cluster === "mainnet" ? jitoApi() : null };
}

/** A coin's radar as the API shows it, every transaction and wallet linked on the explorer. */
export function radarView(cfg: Config, radar: Radar, now = new Date()): BundleRadar {
  const tx = (signature: string) => explorerUrl(cfg, "tx", signature);
  const wallet = (w: Radar["wallets"][number]): RadarWalletView => ({
    wallet: w.wallet,
    explorer: explorerUrl(cfg, "address", w.wallet),
    creator: w.creator,
    linked: w.linked,
    labels: w.labels,
    counted: w.counted.toString(),
    potCoins: w.potCoins.toString(),
    buys: w.buys.map((b) => ({
      signature: b.signature,
      eventIndex: b.eventIndex,
      explorer: tx(b.signature),
      slot: b.slot,
      at: b.at.toISOString(),
      position: b.position,
      jitoBundle: b.jitoBundle,
      quoteAmount: b.quoteAmount.toString(),
      baseAmount: b.baseAmount.toString(),
      fee: b.fee.toString(),
      firstHour: b.firstHour,
      labels: b.labels,
    })),
    deposits: w.deposits.map((d) => ({ signature: d.signature, explorer: tx(d.signature), at: d.at.toISOString(), amount: d.amount.toString(), creatorSigned: d.creatorSigned })),
    transfers: w.transfers.map((t) => ({
      signature: t.signature,
      explorer: tx(t.signature),
      at: t.at.toISOString(),
      direction: t.source === radar.creatorWallet ? "from_creator" : "to_creator",
      asset: t.asset,
      amount: t.amount.toString(),
    })),
  });
  return {
    mint: radar.mint,
    creatorWallet: radar.creatorWallet,
    creatorExplorer: explorerUrl(cfg, "address", radar.creatorWallet),
    openedAt: radar.openedAt.toISOString(),
    creation: { ...radar.creation, explorer: tx(radar.creation.signature) },
    jito: cfg.cluster === "mainnet",
    supply: radar.supply.toString(),
    floor: radar.floor.toString(),
    linked: { wallets: radar.linkedWallets, coins: radar.linkedCoins.toString() },
    wallets: radar.wallets.map(wallet),
    servedAt: now.toISOString(),
  };
}

/** `GET /coins/:mint/radar`. */
export async function getCoinRadar(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const mint = c.req.param("mint")!;
  const radar = Address.safeParse(mint).success ? await radarOf(db, mint) : null;
  if (!radar) return c.json({ error: "Heat has no coin at this address." }, 404);
  c.header("cache-control", "no-store");
  return c.json(radarView(cfg, radar));
}

/** The evidence pack's format, for whoever reads a stored pack later. */
export const EVIDENCE_PACK_VERSION = 1;

/**
 * A case's evidence pack (spec 6.5): the coin, its creation transaction, the floor and what counted toward it, and each
 * wallet directly linked to the Creator wallet with the transactions, Jito bundle ids and transfers behind its links.
 * Only linked wallets: a wallet that is only labelled is never in a case.
 */
export function evidencePack(cfg: Config, radar: Radar, creator: { id: string; xHandle: string | null } | null, reviewedAt: Date) {
  const view = radarView(cfg, radar, reviewedAt);
  return {
    version: EVIDENCE_PACK_VERSION,
    cluster: cfg.cluster,
    reviewedAt: reviewedAt.toISOString(),
    rule: "Wallets directly linked to the Creator wallet bought 1% or more of the coin's supply between them, across the pot and the first hour of trading (spec 6.5).",
    coin: { mint: radar.mint, pool: radar.pool, launchMode: radar.launchMode, explorer: explorerUrl(cfg, "address", radar.mint) },
    creator: { wallet: radar.creatorWallet, explorer: explorerUrl(cfg, "address", radar.creatorWallet), recordId: creator?.id ?? null, xHandle: creator?.xHandle ?? null },
    openedAt: view.openedAt,
    creation: view.creation,
    jito: view.jito,
    floor: { supply: view.supply, floor: view.floor, linkedCoins: view.linked.coins, share: percentOf(radar.linkedCoins, radar.supply) },
    wallets: view.wallets.filter((w) => w.linked),
  };
}

/** A share of supply as a percentage, to two places, rounded down. */
const percentOf = (part: bigint, whole: bigint) => {
  const hundredths = (part * 10_000n) / whole;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
};

/** Where a coin's case keeps its evidence pack in R2 (spec 10.4): one case per coin. */
export const evidenceKey = (mint: string) => `bundle-radar/cases/${mint}.json`;

export type ReviewOutcome = "case" | "below_floor" | "no_links";

/**
 * Reviews one coin: brings its funding window up to date, then records what its linked wallets bought, opening a case
 * with its evidence pack when they bought 1% or more. A coin whose Creator wallet's window is not read through yet (a
 * busy wallet takes several scans) is left for the next run; a coin with a case keeps the one it has.
 */
export async function reviewCoin(db: Db, cfg: Config, blobs: BlobStore, sources: RadarSources, mint: string, now = new Date(), maxReads?: number) {
  const refreshed = await refreshRadar(db, sources, mint, { maxReads });
  if (!refreshed) return null;
  if (!refreshed.complete) return { outcome: "pending" as const, read: refreshed.read };
  const radar = (await radarOf(db, mint))!;
  const outcome: ReviewOutcome = radar.linkedWallets === 0 ? "no_links" : radar.linkedCoins >= radar.floor ? "case" : "below_floor";
  let opened: string | null = null;
  if (outcome === "case") {
    const [existing] = await db.select({ id: bundleCases.id }).from(bundleCases).where(eq(bundleCases.mint, mint));
    if (!existing) {
      const [creator] = radar.creatorId ? await db.select({ id: creators.id, xHandle: creators.xHandle }).from(creators).where(eq(creators.id, radar.creatorId)) : [];
      const pack = evidencePack(cfg, radar, creator ?? null, now);
      const key = evidenceKey(mint);
      // R2 first: the case row is what the operator's queue reads, and it only appears once its pack is stored.
      await blobs.put(key, new TextEncoder().encode(JSON.stringify(pack, null, 2)), { httpMetadata: { contentType: "application/json" } });
      const [row] = await db
        .insert(bundleCases)
        .values({
          mint,
          creatorWallet: radar.creatorWallet,
          creatorId: radar.creatorId,
          linkedWallets: radar.linkedWallets,
          linkedCoins: radar.linkedCoins,
          supply: radar.supply,
          evidence: pack,
          evidenceKey: key,
          openedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: bundleCases.id });
      opened = row?.id ?? null;
    }
  }
  const review = { outcome, linkedWallets: radar.linkedWallets, linkedCoins: radar.linkedCoins, reviewedAt: now };
  await db
    .insert(bundleReviews)
    .values({ mint, ...review, firstReviewedAt: now })
    .onConflictDoUpdate({ target: bundleReviews.mint, set: review });
  return { outcome, opened, linkedWallets: radar.linkedWallets, linkedCoins: radar.linkedCoins, read: refreshed.read };
}

/** How many coins one run reviews for the first time, and looks at again; the next run goes on. */
const FIRST_REVIEWS = 20;
const REREVIEWS = 50;
/**
 * The most transactions one run reads of Creator wallets' histories, so the job never crowds the RPC that launches and
 * trades share (Helius's free tier, spec 10.5); a coin left pending is reviewed when a later run reaches it.
 */
const RUN_READS = 300;
/** How long a reviewed coin without a case waits before it is looked at again. */
const REREVIEW_MS = 55 * 60 * 1000;

/**
 * The case job (spec 10.2), run by the 5-minute cron: every Heat coin whose first hour has ended is reviewed once, and
 * every reviewed coin without a case again each hour until its 7 days after the open are over.
 */
export async function reviewBundles(db: Db, env: Bindings, now = new Date()) {
  const cfg = config(env);
  const blobs = env.BLOBS;
  if (!cfg.heat || !blobs) return { reviewed: 0, cases: 0, pending: 0 };
  const sources = radarSources(cfg);
  const firstHourEnded = new Date(now.getTime() - FIRST_HOUR_MS);
  const windowStarted = new Date(now.getTime() - FUNDING_WINDOW_MS);
  const due = await db
    .select({ mint: coins.mint })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(bundleReviews, eq(bundleReviews.mint, coins.mint))
    .where(and(isNull(bundleReviews.mint), lte(pools.activatedAt, firstHourEnded), gt(pools.activatedAt, new Date(windowStarted.getTime() - FIRST_HOUR_MS))))
    // Newest first: a coin whose hour has just ended is reviewed in the next run, never held behind older coins whose
    // busy Creator wallets (devnet's test bank) take many runs to read.
    .orderBy(desc(pools.activatedAt))
    .limit(FIRST_REVIEWS);
  const again = await db
    .select({ mint: bundleReviews.mint })
    .from(bundleReviews)
    .innerJoin(pools, eq(pools.mint, bundleReviews.mint))
    .where(and(ne(bundleReviews.outcome, "case"), gt(pools.activatedAt, windowStarted), lte(bundleReviews.reviewedAt, new Date(now.getTime() - REREVIEW_MS))))
    .orderBy(asc(bundleReviews.reviewedAt))
    .limit(REREVIEWS);
  const result = { reviewed: 0, cases: 0, pending: 0 };
  let reads = RUN_READS;
  for (const { mint } of [...due, ...again]) {
    if (reads <= 0) {
      result.pending++;
      continue;
    }
    try {
      const r = await reviewCoin(db, cfg, blobs, sources, mint, now, reads);
      reads -= r?.read ?? 0;
      if (r?.outcome === "pending") result.pending++;
      else if (r) result.reviewed++;
      if (r && "opened" in r && r.opened) result.cases++;
    } catch (e) {
      // One coin's RPC trouble never keeps the others from their review; it is tried again next run.
      console.error(`reviewing ${mint} for bundling failed`, e);
    }
  }
  return result;
}

