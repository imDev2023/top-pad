// The Creator record (spec 7; spec 9, screen 5): each creator's public record, read from what the indexer and the launch
// service wrote, so every fact on it can be recomputed from the chain and Heat's database, with no composite score.
// History stays with the launcher: a coin stays on the record that launched it, whoever holds its DBC creator role now,
// and is marked "handed over to ..." on both records, while Creator Earnings follow the role (spec 4).
import { WSOL_MINT } from "@top-pad/chain";
import type { CreatorRecord, CreatorRef, CreatorSummary, RecordCoin, RecordWallet, ReceivedCoin } from "@top-pad/contract";
import { Address } from "@top-pad/contract";
import {
  bundleCases,
  coins,
  creators,
  creatorWallets,
  fairOpens,
  feeClaims,
  graduations,
  launches,
  lpFeeClaims,
  poolCreatorTransfers,
  pools,
  trades,
  walletChanges,
  type Db,
} from "@top-pad/db";
import { radarOf } from "@top-pad/indexer";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { creatorLockOf } from "./afterOpen";
import { completeRotations, walletChangeView } from "./creatorWallets";
import { explorerUrl, type Config } from "./env";
import type { AppEnv } from "./http";
import { quoteInfoOf } from "./quotes";
import { storedLabels } from "./vampShield";

/** A coin that never graduated goes quiet after this long without a trade (spec 7). */
export const QUIET_MS = 7 * 24 * 3600 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type WalletRow = typeof creatorWallets.$inferSelect;

/** A record's id for `key`: the id itself, or the record whose Creator wallet `key` is, or most recently was. */
export async function resolveRecord(db: Db, key: string): Promise<string | null> {
  if (UUID.test(key)) {
    const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, key));
    return row?.id ?? null;
  }
  if (!Address.safeParse(key).success) return null;
  const [row] = await db
    .select({ id: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(eq(creatorWallets.wallet, key))
    .orderBy(sql`${creatorWallets.endedAt} is null desc`, desc(creatorWallets.startedAt))
    .limit(1);
  return row?.id ?? null;
}

/** The record whose Creator wallet `wallet` was at `at`: how a coin or Fair Open made outside the launch service finds its record. */
export async function recordAt(db: Db, wallet: string, at: Date): Promise<string | null> {
  const [row] = await db
    .select({ id: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(
      and(
        eq(creatorWallets.wallet, wallet),
        sql`${creatorWallets.startedAt} <= ${at.toISOString()}`,
        or(isNull(creatorWallets.endedAt), sql`${creatorWallets.endedAt} > ${at.toISOString()}`),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Other records as a record names them, by id: their X handle, and their current Creator wallet. */
async function refsOf(db: Db, ids: string[]): Promise<Map<string, CreatorRef>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: creators.id, handle: creators.xHandle, wallet: creatorWallets.wallet })
    .from(creators)
    .leftJoin(creatorWallets, and(eq(creatorWallets.creatorId, creators.id), isNull(creatorWallets.endedAt)))
    .where(inArray(creators.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { id: r.id, handle: r.handle, wallet: r.wallet }]));
}

/** The records whose current Creator wallet each of `wallets` is. */
async function currentRecordsOf(db: Db, wallets: string[]): Promise<Map<string, string>> {
  if (!wallets.length) return new Map();
  const rows = await db
    .select({ wallet: creatorWallets.wallet, id: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(and(inArray(creatorWallets.wallet, [...new Set(wallets)]), isNull(creatorWallets.endedAt)));
  return new Map(rows.map((r) => [r.wallet, r.id]));
}

/**
 * Each coin's DBC creator role now: the latest hand-over's new holder, or the wallet that launched it when it never
 * moved, with that hand-over.
 */
async function rolesOf(db: Db, poolAddresses: string[]) {
  if (!poolAddresses.length) return new Map<string, typeof poolCreatorTransfers.$inferSelect>();
  const rows = await db
    .selectDistinctOn([poolCreatorTransfers.pool])
    .from(poolCreatorTransfers)
    .where(inArray(poolCreatorTransfers.pool, poolAddresses))
    .orderBy(poolCreatorTransfers.pool, desc(poolCreatorTransfers.slot), desc(poolCreatorTransfers.eventIndex));
  return new Map(rows.map((r) => [r.pool, r]));
}

/**
 * The coins a record launched: those its launches made, and any Heat coin made outside the launch service by a wallet
 * while it was the record's Creator wallet. With each one's pool, Graduation, latest trade and creator role now.
 */
async function launchedCoins(db: Db, creatorId: string, wallets: WalletRow[]) {
  const tenure = wallets.map(
    (w) => sql`(${coins.creatorWallet} = ${w.wallet} and ${coins.createdAt} >= ${w.startedAt.toISOString()} and ${w.endedAt ? sql`${coins.createdAt} < ${w.endedAt.toISOString()}` : sql`true`})`,
  );
  const rows = await db
    .select({
      coin: coins,
      pool: pools,
      graduation: graduations,
      looksLike: launches.looksLike,
      lastTradeAt: sql<Date | null>`(select max(${trades.at}) from ${trades} where ${trades.mint} = ${coins.mint})`.mapWith((v: string | null) => (v ? new Date(v) : null)),
    })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(graduations, eq(graduations.mint, coins.mint))
    .leftJoin(launches, eq(launches.mint, coins.mint))
    .where(or(eq(coins.creatorId, creatorId), and(isNull(coins.creatorId), tenure.length ? or(...tenure) : sql`false`)))
    .orderBy(desc(coins.createdAt));
  const roles = await rolesOf(db, rows.map((r) => r.pool.pool));
  return rows.map((r) => ({ ...r, role: roles.get(r.pool.pool) ?? null }));
}

type Launched = Awaited<ReturnType<typeof launchedCoins>>[number];

/** Never graduated, its curve not complete, and no trade (or, with none, no launch) for 7 days. */
const isQuiet = (c: Launched, now: Date) =>
  !c.graduation && !c.pool.curveCompletedAt && now.getTime() - (c.lastTradeAt ?? c.coin.createdAt).getTime() >= QUIET_MS;

/** Whether any of the record's coins has an open bundling case (spec 6.5). Bars come with #56. */
async function hasOpenCase(db: Db, creatorId: string, walletAddresses: string[]) {
  const [row] = await db
    .select({ id: bundleCases.id })
    .from(bundleCases)
    .where(
      and(
        eq(bundleCases.status, "open"),
        walletAddresses.length ? or(eq(bundleCases.creatorId, creatorId), inArray(bundleCases.creatorWallet, walletAddresses)) : eq(bundleCases.creatorId, creatorId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function walletsOf(db: Db, creatorId: string) {
  return db.select().from(creatorWallets).where(eq(creatorWallets.creatorId, creatorId)).orderBy(creatorWallets.startedAt);
}

function summarize(
  creator: typeof creators.$inferSelect,
  wallets: WalletRow[],
  launched: Launched[],
  openCase: boolean,
  now: Date,
): CreatorSummary {
  const own = new Set(wallets.map((w) => w.wallet));
  const graduated = launched.filter((c) => c.graduation).length;
  return {
    id: creator.id,
    wallet: wallets.find((w) => !w.endedAt)?.wallet ?? null,
    x: creator.xHandle && creator.xName ? { handle: creator.xHandle, name: creator.xName, avatarUrl: creator.xAvatarUrl } : null,
    coins: launched.length,
    graduations: graduated,
    graduationRate: launched.length ? graduated / launched.length : null,
    handedOver: launched.filter((c) => c.role && !own.has(c.role.toWallet)).length,
    quiet: launched.filter((c) => isQuiet(c, now)).length,
    marks: { verifiedCreator: graduated > 0 && !openCase, verifiedHuman: false },
    since: creator.createdAt.toISOString(),
  };
}

/** A record's summary (spec 7, 9), as the coin page, the calendar and the Fairness card show it; null for no record. */
export async function summaryOf(db: Db, creatorId: string | null, now = new Date()): Promise<CreatorSummary | null> {
  if (!creatorId) return null;
  const [creator] = await db.select().from(creators).where(eq(creators.id, creatorId));
  if (!creator) return null;
  const wallets = await walletsOf(db, creatorId);
  const launched = await launchedCoins(db, creatorId, wallets);
  const openCase = await hasOpenCase(db, creatorId, wallets.map((w) => w.wallet));
  return summarize(creator, wallets, launched, openCase, now);
}

/** A whole record (spec 7, 9 screen 5). */
export async function recordOf(cfg: Config, db: Db, creatorId: string, now = new Date()): Promise<CreatorRecord | null> {
  const [creator] = await db.select().from(creators).where(eq(creators.id, creatorId));
  if (!creator) return null;
  const wallets = await walletsOf(db, creatorId);
  const own = wallets.map((w) => w.wallet);
  const ownSet = new Set(own);
  const launched = await launchedCoins(db, creatorId, wallets);
  const openCase = await hasOpenCase(db, creatorId, own);
  const summary = summarize(creator, wallets, launched, openCase, now);

  const changes = await db.select().from(walletChanges).where(eq(walletChanges.creatorId, creatorId)).orderBy(desc(walletChanges.requestedAt));

  // Fair Opens: the record's launches, and any scheduled outside the launch service by a wallet while it was its Creator wallet.
  const tenure = wallets.map(
    (w) =>
      sql`(${fairOpens.creator} = ${w.wallet} and ${fairOpens.createdAt} >= ${w.startedAt.toISOString()} and ${w.endedAt ? sql`${fairOpens.createdAt} < ${w.endedAt.toISOString()}` : sql`true`})`,
  );
  const scheduled = await db
    .select({ status: fairOpens.status, failure: fairOpens.failure, mint: fairOpens.mint })
    .from(fairOpens)
    .leftJoin(launches, eq(launches.fairOpen, fairOpens.launch))
    .where(or(eq(launches.creatorId, creatorId), and(isNull(launches.creatorId), tenure.length ? or(...tenure) : sql`false`)));

  // Sells of its coins from any of its Creator wallets.
  const mints = launched.map((c) => c.coin.mint);
  const sells =
    mints.length && own.length
      ? await db
          .select({
            mint: trades.mint,
            count: sql<number>`count(*)::int`,
            coins: sql<string>`sum(${trades.baseAmount})::text`,
            quote: sql<string>`sum(${trades.quoteAmount})::text`,
          })
          .from(trades)
          .where(and(inArray(trades.mint, mints), eq(trades.side, "sell"), inArray(trades.trader, own)))
          .groupBy(trades.mint)
      : [];
  const sellsBy = new Map(sells.map((s) => [s.mint, s]));

  const lockRows = mints.length ? await db.select().from(fairOpens).where(inArray(fairOpens.mint, mints)) : [];
  const holders = launched.map((c) => c.role?.toWallet).filter((w): w is string => !!w && !ownSet.has(w));

  // Coins other records launched whose creator role one of this record's wallets holds now.
  const toOwn = own.length
    ? await db.selectDistinct({ pool: poolCreatorTransfers.pool }).from(poolCreatorTransfers).where(inArray(poolCreatorTransfers.toWallet, own))
    : [];
  const ownMints = new Set(mints);
  const receivedRoles = [...(await rolesOf(db, toOwn.map((t) => t.pool))).values()].filter((r) => ownSet.has(r.toWallet));
  const receivedCoins = receivedRoles.length
    ? (
        await db
          .select({ coin: coins, pool: pools.pool })
          .from(coins)
          .innerJoin(pools, eq(pools.mint, coins.mint))
          .where(inArray(pools.pool, receivedRoles.map((r) => r.pool)))
      ).filter((r) => !ownMints.has(r.coin.mint))
    : [];
  // A received coin's launcher: its record, or the record its launching wallet then belonged to.
  const launcherIds = new Map<string, string | null>();
  for (const r of receivedCoins) launcherIds.set(r.coin.mint, r.coin.creatorId ?? (await recordAt(db, r.coin.creatorWallet, r.coin.createdAt)));
  const holderRecords = await currentRecordsOf(db, holders);
  const refs = await refsOf(db, [...holderRecords.values(), ...[...launcherIds.values()].filter((id): id is string => !!id)]);

  // What Creator Earnings claims paid the record's wallets, in SOL coins (#99 brings the others).
  const solPools = sql`(select ${pools.pool} from ${pools} where ${pools.quoteMint} = ${WSOL_MINT})`;
  const [curve] = own.length
    ? await db
        .select({ amount: sql<string>`coalesce(sum(${feeClaims.creatorAmount}), 0)::text` })
        .from(feeClaims)
        .where(and(inArray(feeClaims.creator, own), sql`${feeClaims.pool} in ${solPools}`))
    : [{ amount: "0" }];
  const [lp] = own.length
    ? await db
        .select({ amount: sql<string>`coalesce(sum(${lpFeeClaims.quoteAmount}), 0)::text` })
        .from(lpFeeClaims)
        .where(and(inArray(lpFeeClaims.owner, own), sql`${lpFeeClaims.mint} in (select ${pools.mint} from ${pools} where ${pools.quoteMint} = ${WSOL_MINT})`))
    : [{ amount: "0" }];

  const heat = cfg.heat!;
  const coinViews: RecordCoin[] = [];
  for (const c of launched) {
    const radar = await radarOf(db, c.coin.mint);
    const fairOpen = lockRows.find((f) => f.mint === c.coin.mint);
    const sold = sellsBy.get(c.coin.mint);
    const holder = c.role?.toWallet ?? c.coin.creatorWallet;
    const recordId = holderRecords.get(holder);
    coinViews.push({
      mint: c.coin.mint,
      name: c.coin.name,
      ticker: c.coin.ticker,
      imageUri: c.coin.imageUri,
      launchMode: c.coin.launchMode,
      launchedAt: c.coin.createdAt.toISOString(),
      looksLike: storedLabels(c.looksLike),
      quote: await quoteInfoOf(cfg, heat, c.pool.quoteMint),
      state: c.graduation ? "graduated" : isQuiet(c, now) ? "quiet" : "trading",
      graduatedAt: c.graduation?.graduatedAt.toISOString() ?? null,
      lastTradeAt: c.lastTradeAt?.toISOString() ?? null,
      lock: fairOpen ? await creatorLockOf(cfg, db, fairOpen) : null,
      sells: { count: sold?.count ?? 0, coins: sold?.coins ?? "0", quote: sold?.quote ?? "0" },
      role: {
        holder,
        handedOver: !ownSet.has(holder),
        record: !ownSet.has(holder) && recordId && recordId !== creatorId ? (refs.get(recordId) ?? null) : null,
        at: c.role?.at.toISOString() ?? null,
        explorer: c.role ? explorerUrl(cfg, "tx", c.role.signature) : null,
      },
      radar: {
        linked: radar?.wallets.filter((w) => w.linked && !w.creator).length ?? 0,
        labelled: radar?.wallets.filter((w) => !w.linked && !w.creator && w.labels.length > 0).length ?? 0,
      },
    });
  }

  const received: ReceivedCoin[] = receivedCoins.map((r) => {
    const role = receivedRoles.find((x) => x.pool === r.pool)!;
    const launcher = launcherIds.get(r.coin.mint);
    return {
      mint: r.coin.mint,
      name: r.coin.name,
      ticker: r.coin.ticker,
      imageUri: r.coin.imageUri,
      launcher: launcher ? (refs.get(launcher) ?? null) : null,
      holder: role.toWallet,
      at: role.at.toISOString(),
      explorer: explorerUrl(cfg, "tx", role.signature),
    };
  });

  const walletViews: RecordWallet[] = wallets.map((w) => ({
    wallet: w.wallet,
    explorer: explorerUrl(cfg, "address", w.wallet),
    via: w.via,
    from: w.startedAt.toISOString(),
    until: w.endedAt?.toISOString() ?? null,
    proof: { signature: w.proof, message: w.proofMessage, explorer: w.via === "first_launch" ? explorerUrl(cfg, "tx", w.proof) : null },
    change: w.changeId,
  }));

  const fairOpenCoins = launched.filter((c) => c.coin.launchMode === "fair_open").length;
  return {
    summary,
    wallets: walletViews,
    changes: changes.map(walletChangeView),
    launches: {
      instant: launched.filter((c) => c.coin.launchMode === "instant").length,
      fairOpen: {
        opened: fairOpenCoins,
        failed: scheduled.filter((f) => f.failure !== null).length,
        scheduled: scheduled.filter((f) => f.status === "scheduled" && f.failure === null).length,
      },
    },
    coins: coinViews,
    received,
    earnings: { claimed: (BigInt(curve!.amount) + BigInt(lp!.amount)).toString(), curve: curve!.amount, lp: lp!.amount },
    servedAt: now.toISOString(),
  };
}

/** `GET /creators/:key`: a record by its id or by a wallet that is or was its Creator wallet. */
export async function getCreatorRecord(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  if (!cfg.heat) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const id = await resolveRecord(db, c.req.param("key")!);
  if (!id) return c.json({ error: "Heat has no Creator record for this." }, 404);
  // A rotation whose cooldown has ended takes effect before the record is read, so the page never shows one overdue.
  await completeRotations(db, new Date(), id);
  const record = await recordOf(cfg, db, id);
  if (!record) return c.json({ error: "Heat has no Creator record for this." }, 404);
  c.header("cache-control", "no-store");
  return c.json(record);
}

/**
 * `GET /creators/current/:wallet`: the summary of the record whose Creator wallet `wallet` is now, or null when it is none,
 * which the creator's page asks for every wallet it connects.
 */
export async function getCurrentRecord(c: Context<AppEnv>) {
  const { db } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return c.json({ error: "That is not a Solana wallet address." }, 400);
  const [row] = await db
    .select({ id: creatorWallets.creatorId })
    .from(creatorWallets)
    .where(and(eq(creatorWallets.wallet, wallet), isNull(creatorWallets.endedAt)));
  if (row) await completeRotations(db, new Date(), row.id);
  c.header("cache-control", "no-store");
  return c.json(row ? await summaryOf(db, row.id) : null);
}
