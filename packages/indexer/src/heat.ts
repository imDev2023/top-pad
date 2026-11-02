// What the indexer writes for Heat (spec 10.2): the pools on Heat's configs, the coins the fee program registers, every
// trade with its candles, on the curve and after Graduation on the coin's DAMM v2 pool, the fee program's claims, each
// coin's Graduation with its surplus, leftover and LP fee claims, and each Fair Open with its open, its Creator lock, its
// Tax Share and its seats' deposits, withdrawals, deliveries, Tax Shares and refunds.
// Each transaction is written in one database transaction that first claims its signature, so the live source, the
// browser's fast path and reconciliation can all hand it in and it is written once.
import { and, eq, inArray, sql } from "drizzle-orm";
import { FEE_CLAIMER_ADDRESS, priceOfSqrtPrice, type HeatCluster } from "@top-pad/chain";
import {
  coins,
  fairOpens,
  fairOpenSeatEvents,
  feeClaims,
  graduations,
  indexedTransactions,
  launches,
  lpFeeClaims,
  pools,
  trades,
  windowClaims,
  type DbOrTransaction,
} from "@top-pad/db";
import { foldTrade } from "./candles";
import {
  dammPoolsIn,
  decodeTransaction,
  type CoinRegistered,
  type CurveCompleted,
  type Graduated,
  type GraduatedPoolRef,
  type LeftoverBurn,
  type LpFeeClaim,
  type SurplusSplit,
  type CreatorLock,
  type FairOpenCreated,
  type FairOpenEnded,
  type FairOpenOpened,
  type FeesClaimed,
  type PoolCreated,
  type RawTransaction,
  type SeatEvent,
  signersOf,
  type TaxShareCollection,
  type WindowClaimed,
} from "./decode";
import type { IndexResult, TransactionHandler } from "./index";

export type Trade = typeof trades.$inferSelect;

/** What one transaction added, for the live rooms. */
export type Indexed = {
  signature: string;
  slot: number;
  pools: PoolCreated[];
  coins: CoinRegistered[];
  trades: Trade[];
  windowClaims: WindowClaimed[];
  feeClaims: FeesClaimed[];
  fairOpens: FairOpenCreated[];
  fairOpenOpens: FairOpenOpened[];
  seatEvents: SeatEvent[];
  fairOpenEnds: FairOpenEnded[];
  creatorLocks: CreatorLock[];
  taxShares: TaxShareCollection[];
  curveCompletes: CurveCompleted[];
  graduations: Graduated[];
  surplusSplits: SurplusSplit[];
  leftoverBurns: LeftoverBurn[];
  lpFeeClaims: LpFeeClaim[];
};

export type HeatHandlerOptions = {
  /** Heat on the cluster being indexed; it must have its configs. */
  heat: HeatCluster;
  /** A transaction's place in its block (`getBlock`), asked only for a transaction with trades. */
  blockIndexOf(slot: number, signature: string): Promise<number>;
  /** Called once a transaction's rows are committed, with what it added. */
  onIndexed?(indexed: Indexed): void | Promise<void>;
};

const BLOCK_INDEX_LIMIT = 1_000_000;
const EVENT_INDEX_LIMIT = 10_000;

/** The trades' total order as one number: slot, then place in the block, then place in the transaction. */
export function orderKey(slot: number, blockIndex: number, eventIndex: number): string {
  if (blockIndex < 0 || blockIndex >= BLOCK_INDEX_LIMIT) throw new Error(`block index ${blockIndex} is out of range`);
  if (eventIndex < 0 || eventIndex >= EVENT_INDEX_LIMIT) throw new Error(`event index ${eventIndex} is out of range`);
  return (BigInt(slot) * 10n ** 10n + BigInt(blockIndex) * 10n ** 4n + BigInt(eventIndex)).toString();
}

/**
 * A trade's order key before its place in the block is known: the end of its slot. What the browser's fast path shows a
 * trade with the moment it confirms (spec 10.2), until the indexer reports it with its real key.
 */
export const provisionalOrderKey = (slot: number, eventIndex: number) => orderKey(slot, BLOCK_INDEX_LIMIT - 1, eventIndex);

/** The handler the ingestion entry point runs on Heat's transactions. */
export function heatHandler({ heat, blockIndexOf, onIndexed }: HeatHandlerOptions): TransactionHandler {
  if (!heat.configs) throw new Error("the indexer needs Heat's configs on its cluster");
  const configs = new Set<string>([heat.configs.fairOpen, heat.configs.instant]);

  return async (db, tx: RawTransaction): Promise<IndexResult> => {
    const signature = tx.transaction.signatures[0]!;
    // The graduated pools the transaction trades on or claims from, as Heat knows them.
    const named = dammPoolsIn(tx);
    const known = named.length
      ? await db.select({ pool: graduations.pool, mint: graduations.mint, config: graduations.config }).from(graduations).where(inArray(graduations.pool, named))
      : [];
    const graduated = new Map<string, GraduatedPoolRef>(known.map((g) => [g.pool, { mint: g.mint, config: g.config }]));
    const decoded = decodeTransaction(tx, configs, graduated);
    // A trade's place orders it among its slot's; a pool's creation is where Bundle Radar counts positions from (spec 6.4).
    const blockIndex = decoded.swaps.length || decoded.pools.length ? await blockIndexOf(tx.slot, signature) : null;
    const blockTime = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000);

    const added = await db.transaction(async (t) => {
      const [claimed] = await t
        .insert(indexedTransactions)
        .values({ signature, slot: tx.slot, blockIndex, signers: signersOf(tx) })
        .onConflictDoNothing()
        .returning();
      if (!claimed) return null;

      for (const p of decoded.pools) {
        await t
          .insert(pools)
          .values({
            pool: p.pool,
            mint: p.mint,
            config: p.config,
            creator: p.creator,
            name: p.name,
            ticker: p.ticker,
            uri: p.uri,
            activatedAt: new Date(Number(p.activationPoint) * 1000),
            createdSignature: signature,
            createdSlot: tx.slot,
            createdAt: blockTime,
            sqrtPrice: heat.sqrtStartPrice.toString(),
            quoteReserve: 0n,
          })
          .onConflictDoNothing();
      }
      for (const c of decoded.coins) await recordCoin(t, c, signature, tx.slot, blockTime);

      const added: Trade[] = [];
      for (const s of decoded.swaps) {
        const key = orderKey(tx.slot, blockIndex!, s.eventIndex);
        const price = priceOfSqrtPrice(s.sqrtPrice, heat.quote.decimals);
        const at = Number(s.timestamp);
        const [row] = await t
          .insert(trades)
          .values({
            signature,
            eventIndex: s.eventIndex,
            slot: tx.slot,
            blockIndex: blockIndex!,
            orderKey: key,
            at: new Date(at * 1000),
            pool: s.pool,
            mint: s.mint,
            trader: s.trader,
            side: s.side,
            quoteAmount: s.quoteAmount,
            baseAmount: s.baseAmount,
            fee: s.fee,
            sqrtPrice: s.sqrtPrice.toString(),
            price,
            quoteReserve: s.quoteReserve,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) continue;
        added.push(row);
        await foldTrade(t, { mint: s.mint, at, orderKey: key, price, quoteAmount: s.quoteAmount, baseAmount: s.baseAmount });
      }
      for (const mint of new Set(added.map((a) => a.mint))) await followLatestTrade(t, mint);

      // Graduation (spec 2.3): the curve completing, the migration, the surplus, the leftover and the LP fee claims.
      for (const c of decoded.curveCompletes) {
        await t
          .update(pools)
          .set({ curveCompletedAt: blockTime })
          .where(and(eq(pools.pool, c.pool), sql`${pools.curveCompletedAt} is null`));
      }
      for (const g of decoded.graduations) await recordGraduation(t, g, signature, tx.slot, blockTime);
      for (const x of decoded.surplusSplits) {
        const [found] = await t
          .update(pools)
          .set({ surplusCreatorAmount: x.creatorAmount, surplusTreasuryAmount: x.treasuryAmount, surplusSignature: signature })
          .where(eq(pools.pool, x.pool))
          .returning({ pool: pools.pool });
        if (!found) throw new Error(`the surplus of pool ${x.pool} was split, and the indexer has not seen it created`);
      }
      for (const x of decoded.leftoverBurns) {
        const [found] = await t
          .update(graduations)
          .set({ leftoverBurnt: x.burnt, leftoverSignature: signature })
          .where(eq(graduations.mint, x.mint))
          .returning({ mint: graduations.mint });
        if (!found) throw new Error(`the leftover of ${x.mint} was burnt, and the indexer has not seen it graduate`);
      }
      for (const x of decoded.lpFeeClaims) {
        await t
          .insert(lpFeeClaims)
          .values({
            signature,
            eventIndex: x.eventIndex,
            slot: tx.slot,
            at: blockTime,
            pool: x.pool,
            mint: x.mint,
            position: x.position,
            owner: x.owner,
            quoteAmount: x.quoteAmount,
            coinAmount: x.coinAmount,
          })
          .onConflictDoNothing();
      }

      for (const w of decoded.windowClaims) {
        await t
          .insert(windowClaims)
          .values({
            pool: w.pool,
            mint: w.mint,
            heat: w.heat,
            destination: w.destination,
            amount: w.amount,
            windowEndedAt: new Date(Number(w.windowEndedAt) * 1000),
            claimedAt: new Date(Number(w.claimedAt) * 1000),
            signature,
            slot: tx.slot,
          })
          .onConflictDoNothing();
      }
      for (const f of decoded.feeClaims) {
        await t
          .insert(feeClaims)
          .values({
            signature,
            eventIndex: f.eventIndex,
            slot: tx.slot,
            at: blockTime,
            pool: f.pool,
            mint: f.mint,
            creator: f.creator,
            creatorAmount: f.creatorAmount,
            treasuryAmount: f.treasuryAmount,
          })
          .onConflictDoNothing();
      }
      for (const f of decoded.fairOpens) {
        await t
          .insert(fairOpens)
          .values({
            launch: f.launch,
            creator: f.creator,
            nonce: f.nonce,
            dbcConfig: f.dbcConfig,
            quoteMint: f.quoteMint,
            identityHash: f.identityHash,
            depositsOpenAt: new Date(Number(f.depositsOpenAt) * 1000),
            opensAt: new Date(Number(f.opensAt) * 1000),
            minRaise: f.minRaise,
            potCap: f.potCap,
            lowestRung: f.lowestRung,
            step: f.step,
            // The calendar's teaser, from the launch service's schedule (spec 2.1 step 4), if Heat scheduled it here.
            teaser: sql`(select ${launches.teaser} from ${launches} where ${launches.fairOpen} = ${f.launch})`,
            createdSignature: signature,
            createdSlot: tx.slot,
            createdAt: blockTime,
          })
          .onConflictDoNothing();
      }
      // The open, in the creation transaction that made the coin and its pool, which were written above.
      for (const o of decoded.fairOpenOpens) {
        const [found] = await t
          .update(fairOpens)
          .set({ status: "opened", mint: o.mint, pool: o.pool, spent: o.spent, coins: o.coins, seats: o.seats, openedSignature: signature, openedAt: blockTime })
          .where(eq(fairOpens.launch, o.launch))
          .returning({ launch: fairOpens.launch });
        if (!found) throw new Error(`Fair Open ${o.launch} opened, and the indexer has not seen it created`);
      }
      for (const e of decoded.seatEvents) {
        await t
          .insert(fairOpenSeatEvents)
          .values({
            signature,
            eventIndex: e.eventIndex,
            slot: tx.slot,
            at: blockTime,
            launch: e.launch,
            wallet: e.wallet,
            person: e.person,
            kind: e.kind,
            tier: e.tier,
            amount: e.amount,
            deposit: e.deposit,
            rent: e.rent,
            spent: e.spent,
            coins: e.coins,
          })
          .onConflictDoNothing();
      }
      // After the open, the Creator lock and the Tax Share (spec 2.1 steps 13 and 14).
      for (const l of decoded.creatorLocks) {
        const [found] = await t
          .update(fairOpens)
          .set({
            lockEscrow: l.escrow,
            lockCoins: l.coins,
            lockCliffAt: new Date(Number(l.cliffTime) * 1000),
            lockEndsAt: new Date(Number(l.endTime) * 1000),
            lockedAt: blockTime,
            lockSignature: signature,
          })
          .where(eq(fairOpens.launch, l.launch))
          .returning({ launch: fairOpens.launch });
        if (!found) throw new Error(`Fair Open ${l.launch} locked its creator's coins, and the indexer has not seen it created`);
      }
      for (const x of decoded.taxShares) {
        const [found] = await t
          .update(fairOpens)
          .set({
            taxShare: x.taxShare,
            taxShareFees: x.fees,
            taxShareDust: x.dust,
            taxShareBasis: x.basis,
            taxShareToTreasury: x.toTreasury,
            taxShareCollectedAt: blockTime,
            taxShareSignature: signature,
          })
          .where(eq(fairOpens.launch, x.launch))
          .returning({ launch: fairOpens.launch });
        if (!found) throw new Error(`Fair Open ${x.launch} collected its Tax Share, and the indexer has not seen it created`);
      }
      // A launch fails once, then may close, and a closed launch stays closed; an opened one stays opened when its
      // account closes. One whose creation the indexer has not seen (the live source reporting a failure first) is left
      // to reconciliation, which goes oldest first.
      for (const end of decoded.fairOpenEnds) {
        const set =
          end.kind === "failed"
            ? { status: sql`case when ${fairOpens.status} = 'closed' then 'closed' else 'failed' end`, failure: end.failure, failedAt: blockTime }
            : { status: sql`case when ${fairOpens.status} = 'opened' then 'opened' else 'closed' end`, closedAt: blockTime };
        const [found] = await t.update(fairOpens).set(set).where(eq(fairOpens.launch, end.launch)).returning({ launch: fairOpens.launch });
        if (!found) throw new Error(`Fair Open ${end.launch} ${end.kind}, and the indexer has not seen it created`);
      }
      return added;
    });
    if (!added) return {};

    if (onIndexed) {
      await onIndexed({
        signature,
        slot: tx.slot,
        pools: decoded.pools,
        coins: decoded.coins,
        trades: added,
        windowClaims: decoded.windowClaims,
        feeClaims: decoded.feeClaims,
        fairOpens: decoded.fairOpens,
        fairOpenOpens: decoded.fairOpenOpens,
        seatEvents: decoded.seatEvents,
        fairOpenEnds: decoded.fairOpenEnds,
        creatorLocks: decoded.creatorLocks,
        taxShares: decoded.taxShares,
        curveCompletes: decoded.curveCompletes,
        graduations: decoded.graduations,
        surplusSplits: decoded.surplusSplits,
        leftoverBurns: decoded.leftoverBurns,
        lpFeeClaims: decoded.lpFeeClaims,
      });
    }
    const result: IndexResult = { transactions: 1 };
    if (decoded.pools.length) result.pools = decoded.pools.length;
    if (decoded.coins.length) result.coins = decoded.coins.length;
    if (added.length) result.trades = added.length;
    const claims = decoded.windowClaims.length + decoded.feeClaims.length;
    if (claims) result.claims = claims;
    const fairOpen =
      decoded.fairOpens.length +
      decoded.fairOpenOpens.length +
      decoded.seatEvents.length +
      decoded.fairOpenEnds.length +
      decoded.creatorLocks.length +
      decoded.taxShares.length;
    if (fairOpen) result.fairOpen = fairOpen;
    const graduation =
      decoded.curveCompletes.length + decoded.graduations.length + decoded.surplusSplits.length + decoded.leftoverBurns.length + decoded.lpFeeClaims.length;
    if (graduation) result.graduation = graduation;
    return result;
  };
}

/**
 * A coin registered on chain joins the Heat coins, with what its launch here knew; a launch still marked sending (its
 * browser went away) or expired (its signature was not found in time) has landed.
 */
async function recordCoin(t: DbOrTransaction, c: CoinRegistered, signature: string, slot: number, at: Date) {
  const [launch] = await t.select().from(launches).where(eq(launches.mint, c.mint));
  const [pool] = await t.select().from(pools).where(eq(pools.pool, c.pool));
  if (!pool) throw new Error(`coin ${c.mint} was registered for pool ${c.pool}, which the indexer has not seen created`);
  await t
    .insert(coins)
    .values({
      mint: c.mint,
      pool: c.pool,
      config: c.config,
      launchMode: c.launchMode,
      launchId: launch?.id ?? null,
      creatorId: launch?.creatorId ?? null,
      creatorWallet: c.creator,
      name: launch?.name ?? pool.name,
      ticker: launch?.ticker ?? pool.ticker,
      metadataUri: launch?.metadataUri ?? pool.uri,
      imageUri: launch?.imageUri ?? null,
      createdSignature: signature,
      createdSlot: slot,
      createdAt: at,
    })
    .onConflictDoNothing();
  if (launch) {
    await t
      .update(launches)
      .set({ status: "landed", slot, landedAt: sql`now()` })
      .where(and(eq(launches.id, launch.id), inArray(launches.status, ["sending", "expired"])));
  }
}

/**
 * A coin's price and quote reserve, from its latest trade by the trades' order, whenever that trade was indexed: on its
 * curve, then after Graduation on its DAMM v2 pool, whose prices are in the same units.
 */
async function followLatestTrade(t: DbOrTransaction, mint: string) {
  await t.execute(sql`
    update pools
    set sqrt_price = latest.sqrt_price, quote_reserve = latest.quote_reserve, last_trade_key = latest.order_key
    from (select sqrt_price, quote_reserve, order_key from trades where mint = ${mint} order by order_key desc limit 1) as latest
    where pools.mint = ${mint} and (pools.last_trade_key is null or pools.last_trade_key < latest.order_key)`);
}

/**
 * A coin's Graduation: its DAMM v2 pool and both locked positions, told apart by their owners, the creator's going to
 * whoever held the creator role and Heat's to the fee program's fee claimer. The coin's price and quote reserve start
 * from the graduated pool's, until its first trade there.
 */
async function recordGraduation(t: DbOrTransaction, g: Graduated, signature: string, slot: number, at: Date) {
  const heat = g.positions.find((p) => p.owner === FEE_CLAIMER_ADDRESS);
  const creator = g.positions.find((p) => p.owner !== FEE_CLAIMER_ADDRESS);
  if (!heat || !creator) throw new Error(`the migration of ${g.mint} did not hand one position to Heat's fee claimer and one to the creator`);
  const [pool] = await t.select().from(pools).where(eq(pools.pool, g.curvePool));
  if (!pool) throw new Error(`${g.mint} graduated from pool ${g.curvePool}, which the indexer has not seen created`);
  await t
    .insert(graduations)
    .values({
      mint: g.mint,
      curvePool: g.curvePool,
      pool: g.pool,
      config: g.config,
      signature,
      slot,
      graduatedAt: at,
      sqrtPrice: g.sqrtPrice.toString(),
      creatorPosition: creator.position,
      creatorPositionNftMint: creator.nftMint,
      creatorPositionOwner: creator.owner,
      creatorLiquidity: creator.liquidity.toString(),
      heatPosition: heat.position,
      heatPositionNftMint: heat.nftMint,
      heatLiquidity: heat.liquidity.toString(),
    })
    .onConflictDoNothing();
}
