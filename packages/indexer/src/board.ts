// The board's reads (spec 8, 10.2, #57): Trending, which counts people rather than volume, Heat's known-bot list, which
// Trending never counts, and each coin's Bundle Radar summary, from which Trending leaves out the wallets Bundle Radar
// ties to the coin's creator and the board shows a coin's flags. Every figure comes from what the indexer wrote, so
// anyone holding the trades can recompute it.
import { sql } from "drizzle-orm";
import { coinRadar, type Db } from "@top-pad/db";
import { radarOf, type Radar } from "./radar";

/** Trending counts the net buyers of the last hour (spec 8). */
export const TRENDING_WINDOW_SECONDS = 60 * 60;
/** A net buyer counts half as much every 20 minutes since their latest buy: Trending is what people buy now. */
export const TRENDING_HALF_LIFE_SECONDS = 20 * 60;
/**
 * The tie-break's cap on each wallet's buys, as a share of its coin's Graduation Target (1%, 0.85 SOL's worth on
 * mainnet): one whale cannot buy a coin up the tie-break, and coins priced in different quotes compare by their targets.
 */
export const TRENDING_WALLET_CAP_BPS = 100n;
/** How many coins Trending ranks. */
export const TRENDING_SIZE = 20;

/** A coin as Trending ranks it. */
export type TrendingCoin = {
  mint: string;
  /** Wallets that bought more of the coin than they sold in the last hour, none of them left out. */
  buyers: number;
  /** The buyers, each counting half as much every `TRENDING_HALF_LIFE_SECONDS` since their latest buy. */
  score: number;
  /** Their buys, each wallet's capped, in Graduation Targets: the tie-break. */
  volume: number;
};

/**
 * Trending (spec 8): the coins with the most unique net buyers in the last hour, each buyer decayed by the age of their
 * latest buy, the capped buy volume breaking ties. One query. Never counted: the Creator wallet and the wallets Bundle
 * Radar ties to it (`coin_radar`, and any trade the Creator wallet signed or paid for), wallets on the known-bot list,
 * any trade in a transaction where its wallet both bought and sold the coin, and the pot's own buy in a Fair Open's
 * creation. A coin with a published confirmed creator bundle (a Bar past its private window, not lifted) is left out
 * whole. Only Heat coins: the query starts from `coins`, the `CoinRecord` mirror.
 */
export async function trendingOf(db: Db, { now = new Date(), limit = TRENDING_SIZE }: { now?: Date; limit?: number } = {}): Promise<TrendingCoin[]> {
  const at = now.toISOString();
  const rows = await db.execute<{ mint: string; buyers: number; score: string; volume: string }>(sql`
    with recent as (
      select t.mint, t.trader, t.side, t.base_amount, t.quote_amount, t.at, p.graduation_target
      from trades t
      join coins c on c.mint = t.mint
      join pools p on p.mint = t.mint
      left join coin_radar r on r.mint = t.mint
      left join indexed_transactions it on it.signature = t.signature
      where t.at > ${at}::timestamptz - make_interval(secs => ${TRENDING_WINDOW_SECONDS}) and t.at <= ${at}::timestamptz
        and t.signature <> c.created_signature
        and t.trader <> c.creator_wallet
        and not (t.trader = any(coalesce(r.linked_wallets, '{}')))
        and not (c.creator_wallet = any(coalesce(it.signers, '{}')))
        and not exists (select 1 from known_bots k where k.wallet = t.trader and k.removed_at is null)
        and not exists (select 1 from trades o where o.signature = t.signature and o.mint = t.mint and o.trader = t.trader and o.side <> t.side)
        and not exists (select 1 from bars b where b.mint = t.mint and b.lifted_at is null and b.publish_at <= ${at}::timestamptz)
    ),
    wallets as (
      select mint, trader,
        sum(case when side = 'buy' then base_amount else -base_amount end) as net,
        max(at) filter (where side = 'buy') as last_buy,
        least(coalesce(sum(quote_amount) filter (where side = 'buy'), 0), max(graduation_target) * ${TRENDING_WALLET_CAP_BPS}::numeric / 10000)::numeric
          / max(graduation_target) as capped
      from recent
      group by mint, trader
    )
    select mint, count(*)::int as buyers,
      sum(power(0.5, extract(epoch from (${at}::timestamptz - last_buy)) / ${TRENDING_HALF_LIFE_SECONDS}))::text as score,
      sum(capped)::text as volume
    from wallets
    where net > 0 and last_buy is not null
    group by mint
    order by sum(power(0.5, extract(epoch from (${at}::timestamptz - last_buy)) / ${TRENDING_HALF_LIFE_SECONDS})) desc, sum(capped) desc, mint
    limit ${limit}
  `);
  return rows.map((r) => ({ mint: r.mint, buyers: Number(r.buyers), score: Number(r.score), volume: Number(r.volume) }));
}

/** A wallet on the known-bot list once it bought in the first 2 seconds of this many Heat launches (spec 8). */
export const EARLY_LAUNCHES = 3;
/** "The first 2 seconds" of a launch: trades the chain's clock stamps less than this after trading opened. */
export const EARLY_SECONDS = 2;
/**
 * How far back the job looks for a buy and sell inside one transaction: listed wallets stay listed, so each run reads
 * only the recent trades, and a day covers trades indexed late after a long outage.
 */
export const ROUND_TRIP_LOOKBACK_SECONDS = 24 * 60 * 60;
const EVIDENCE_MAX = 10;

/**
 * The known-bot job (spec 8): lists every wallet that bought in the first 2 seconds of 3 or more Heat launches, or bought
 * and sold the same coin inside one transaction, with up to ten pieces of evidence of each. A listed wallet's counts only
 * rise; a wallet an operator removed stays removed, however often it is found again. Returns the wallets newly listed
 * and those whose counts grew.
 */
export async function refreshKnownBots(db: Db, now = new Date()): Promise<{ listed: string[]; updated: number }> {
  const at = now.toISOString();
  const rows = await db.execute<{ wallet: string; inserted: boolean }>(sql`
    with early_buys as (
      select t.trader as wallet, t.mint, t.signature, t.at, extract(epoch from (t.at - p.activated_at)) as seconds
      from coins c
      join pools p on p.mint = c.mint
      join trades t on t.mint = c.mint and t.at < p.activated_at + make_interval(secs => ${EARLY_SECONDS})
      where t.side = 'buy' and t.signature <> c.created_signature
    ),
    early as (
      select wallet, count(distinct mint)::int as launches,
        (jsonb_agg(jsonb_build_object('mint', mint, 'signature', signature, 'seconds', seconds) order by at desc)) as evidence
      from early_buys
      group by wallet
      having count(distinct mint) >= ${EARLY_LAUNCHES}
    ),
    trips as (
      select signature, trader, min(at) as at
      from trades
      where at > ${at}::timestamptz - make_interval(secs => ${ROUND_TRIP_LOOKBACK_SECONDS})
      group by signature, mint, trader
      having bool_or(side = 'buy') and bool_or(side = 'sell')
    ),
    rounds as (
      select trader as wallet, count(distinct signature)::int as trips, jsonb_agg(signature order by at desc) as evidence
      from trips
      group by trader
    ),
    found as (
      select coalesce(e.wallet, r.wallet) as wallet, coalesce(e.launches, 0) as early_launches, coalesce(r.trips, 0) as round_trips,
        coalesce(e.evidence, '[]'::jsonb) as early, coalesce(r.evidence, '[]'::jsonb) as round
      from early e
      full join rounds r on r.wallet = e.wallet
    )
    insert into known_bots as k (wallet, early_launches, round_trips, evidence)
    select wallet, early_launches, round_trips,
      jsonb_build_object(
        'early', coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(early) x limit ${EVIDENCE_MAX}) s), '[]'::jsonb),
        'roundTrips', coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(round) x limit ${EVIDENCE_MAX}) s), '[]'::jsonb)
      )
    from found
    on conflict (wallet) do update set
      early_launches = greatest(k.early_launches, excluded.early_launches),
      round_trips = greatest(k.round_trips, excluded.round_trips),
      evidence = jsonb_build_object(
        'early', case when excluded.early_launches >= k.early_launches then excluded.evidence -> 'early' else k.evidence -> 'early' end,
        'roundTrips', case when jsonb_array_length(excluded.evidence -> 'roundTrips') > 0 then excluded.evidence -> 'roundTrips' else k.evidence -> 'roundTrips' end
      ),
      updated_at = now()
    where excluded.early_launches > k.early_launches or excluded.round_trips > k.round_trips
    returning k.wallet, (xmax = 0) as inserted
  `);
  return { listed: rows.filter((r) => r.inserted).map((r) => r.wallet), updated: rows.filter((r) => !r.inserted).length };
}

/** What the board keeps of a coin's radar: the wallets tied to its creator, what they bought, and the timing-only buys. */
export function radarSummary(radar: Radar) {
  const linked = radar.wallets.filter((w) => w.linked);
  const earlyBuys = radar.wallets.filter((w) => !w.linked).reduce((n, w) => n + w.buys.filter((b) => b.labels.includes("same_slot")).length, 0);
  return { mint: radar.mint, linkedWallets: linked.map((w) => w.wallet), linkedCoins: radar.linkedCoins, earlyBuys };
}

/** Keeps a coin's radar summary up to date with a radar just worked out. */
export async function saveRadarSummary(db: Db, radar: Radar): Promise<void> {
  const summary = radarSummary(radar);
  await db
    .insert(coinRadar)
    .values(summary)
    .onConflictDoUpdate({ target: coinRadar.mint, set: { linkedWallets: summary.linkedWallets, linkedCoins: summary.linkedCoins, earlyBuys: summary.earlyBuys, updatedAt: sql`now()` } });
}

/** Works out a coin's radar from what the indexer wrote and keeps its summary; null for a coin not Heat's. */
export async function summarizeRadar(db: Db, mint: string): Promise<Radar | null> {
  const radar = await radarOf(db, mint);
  if (radar) await saveRadarSummary(db, radar);
  return radar;
}
