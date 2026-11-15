// A trader's position in a Heat coin and its P&L share card (spec 9): what the wallet's indexed trades and Fair Open
// fills add up to, priced at the coin's last trade, stated as of one snapshot so the card it shares never changes. The
// card's image is drawn by `pnlImage.ts` and kept in R2 per snapshot.
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { COIN_DECIMALS, priceOfSqrtPrice } from "@top-pad/chain";
import { Address, OrderKey, type Position } from "@top-pad/contract";
import { coins, fairOpens, fairOpenSeatEvents, pools, trades, type Db } from "@top-pad/db";
import { webApp, type Config } from "./env";
import type { AppEnv } from "./http";
import { renderPnlImage } from "./pnlImage";
import { positionFigures, type PositionEvent } from "./positionFigures";
import { quoteInfoOf } from "./quotes";

/** A trade's order key is its slot times this, plus its place in the slot (`trades.order_key`). */
const SLOT_KEY = 10_000_000_000n;

/** A Fair Open seat event's place among trades: the start of its slot, since the indexer keeps no place within it. */
const seatKey = (slot: number) => BigInt(slot) * SLOT_KEY;

/**
 * A wallet's position in a Heat coin as of `at` (the newest snapshot when none is asked for); null when the wallet has
 * neither swapped it nor been filled in its Fair Open by then, and "no coin" when the mint is not a Heat coin.
 */
export async function positionOf(cfg: Config, db: Db, mint: string, wallet: string, asked: bigint | null): Promise<Position | null | "no coin"> {
  const heat = cfg.heat;
  if (!heat) return "no coin";
  const [row] = await db.select({ pool: pools, coin: coins }).from(pools).innerJoin(coins, eq(coins.mint, pools.mint)).where(eq(pools.mint, mint));
  if (!row) return "no coin";
  const { pool, coin } = row;
  const [fairOpen] = await db.select({ launch: fairOpens.launch, spent: fairOpens.spent, coins: fairOpens.coins }).from(fairOpens).where(eq(fairOpens.mint, mint));

  // The newest snapshot: the coin's latest trade, or the wallet's latest fill or Tax Share when that came later.
  const seatKinds = ["delivery", "lock", "tax_share"] as const;
  let newestSeat: bigint | null = null;
  if (fairOpen) {
    const [s] = await db
      .select({ slot: sql<number | null>`max(${fairOpenSeatEvents.slot})` })
      .from(fairOpenSeatEvents)
      .where(and(eq(fairOpenSeatEvents.launch, fairOpen.launch), eq(fairOpenSeatEvents.wallet, wallet), inArray(fairOpenSeatEvents.kind, [...seatKinds])));
    if (s?.slot != null) newestSeat = seatKey(Number(s.slot));
  }
  const lastTrade = pool.lastTradeKey === null ? null : BigInt(pool.lastTradeKey);
  const newest = [lastTrade, newestSeat].reduce<bigint | null>((a, b) => (b === null ? a : a === null || b > a ? b : a), null);
  if (newest === null) return null;
  const at = asked === null || asked > newest ? newest : asked;

  const [swapRows, seatRows, [priced]] = await Promise.all([
    db
      .select()
      .from(trades)
      .where(and(eq(trades.mint, mint), eq(trades.trader, wallet), lte(trades.orderKey, at.toString())))
      .orderBy(asc(trades.orderKey)),
    fairOpen
      ? db
          .select()
          .from(fairOpenSeatEvents)
          .where(
            and(
              eq(fairOpenSeatEvents.launch, fairOpen.launch),
              eq(fairOpenSeatEvents.wallet, wallet),
              inArray(fairOpenSeatEvents.kind, [...seatKinds]),
              lte(sql`${fairOpenSeatEvents.slot}::numeric * ${SLOT_KEY.toString()}::numeric`, at.toString()),
            ),
          )
          .orderBy(asc(fairOpenSeatEvents.slot), asc(fairOpenSeatEvents.eventIndex))
      : Promise.resolve([]),
    db
      .select({ price: trades.price, at: trades.at })
      .from(trades)
      .where(and(eq(trades.mint, mint), lte(trades.orderKey, at.toString())))
      .orderBy(desc(trades.orderKey))
      .limit(1),
  ]);

  const events: PositionEvent[] = [
    ...swapRows.map((t): PositionEvent => ({ kind: t.side, key: BigInt(t.orderKey), at: t.at, coins: t.baseAmount, quote: t.quoteAmount, fee: t.fee })),
    ...seatRows.flatMap((e): PositionEvent[] => {
      const key = seatKey(e.slot);
      if (e.kind === "tax_share") return e.amount > 0n ? [{ kind: "tax_share", key, at: e.at, quote: e.amount }] : [];
      // A delivery's or a lock's seat bought its coins with the rung's one price: what it spent is its cost.
      return e.coins && e.coins > 0n ? [{ kind: "fill", key, at: e.at, coins: e.coins, quote: e.spent ?? 0n }] : [];
    }),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!events.some((e) => e.kind !== "tax_share")) return null;

  const quote = await quoteInfoOf(cfg, heat, pool.quoteMint);
  // The coin's price at the snapshot: its last trade by then, or before any trade the open's one price.
  const price =
    priced?.price ??
    (fairOpen?.spent && fairOpen.coins ? divide(fairOpen.spent, fairOpen.coins, quote.decimals) : priceOfSqrtPrice(BigInt(pool.sqrtPrice), quote.decimals));
  const figures = positionFigures(events, price, COIN_DECIMALS, quote.decimals);
  const last = events[events.length - 1]!;
  const asOf = priced && priced.at > last.at ? priced.at : last.at;
  return {
    mint,
    wallet,
    name: coin.name,
    ticker: coin.ticker,
    imageUri: coin.imageUri,
    launchMode: coin.launchMode,
    decimals: COIN_DECIMALS,
    quote,
    at: at.toString(),
    latest: at === newest,
    asOf: asOf.toISOString(),
    price: trimmed(price),
    ...figures,
    firstAt: events[0]!.at.toISOString(),
    card: `${cfg.apiOrigin}/coins/${mint}/positions/${wallet}/card.png?at=${at}`,
  };
}

/** A decimal without the zeros its fraction ends in: Postgres answers `numeric(38, 18)` with all 18 places. */
const trimmed = (decimal: string) => (decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal);

/** What a pot spent over the coins it bought, as a whole-quote-per-coin decimal with 18 places. */
function divide(spentRaw: bigint, coinsRaw: bigint, quoteDecimals: number): string {
  const places = 18;
  const units = (spentRaw * 10n ** BigInt(COIN_DECIMALS + places)) / (coinsRaw * 10n ** BigInt(quoteDecimals));
  const text = units.toString().padStart(places + 1, "0");
  return trimmed(`${text.slice(0, -places)}.${text.slice(-places)}`);
}

const noCoin = (c: Context<AppEnv>) => c.json({ error: "Heat has no coin at this address." }, 404);
const noPosition = (c: Context<AppEnv>) => c.json({ error: "This wallet holds no position in this coin that Heat has indexed." }, 404);

/** The wallet, the mint and the snapshot asked for, checked; null when any of them cannot be one. */
function asked(c: Context<AppEnv>): { mint: string; wallet: string; at: bigint | null } | null {
  const mint = c.req.param("mint")!;
  const wallet = c.req.param("wallet")!;
  const at = c.req.query("at");
  if (!Address.safeParse(mint).success || !Address.safeParse(wallet).success) return null;
  if (at !== undefined && !(OrderKey.safeParse(at).success && at.length <= 30)) return null;
  return { mint, wallet, at: at === undefined ? null : BigInt(at) };
}

/**
 * `GET /coins/:mint/positions/:wallet?at=`: the position as of a snapshot, or the newest; `null` for a wallet with none,
 * an answer rather than an error, so a coin page asking for a connected wallet's position logs nothing in the console.
 */
export async function getPosition(c: Context<AppEnv>) {
  const q = asked(c);
  if (!q) return noCoin(c);
  const position = await positionOf(c.var.cfg, c.var.db, q.mint, q.wallet, q.at);
  if (position === "no coin") return noCoin(c);
  if (!position) {
    c.header("cache-control", "no-store");
    return c.json(null);
  }
  // A past snapshot never changes; the newest does with the next trade.
  c.header("cache-control", position.latest ? "no-store" : "public, max-age=3600");
  return c.json(position);
}

/** Where a P&L card is kept in R2: one object per snapshot and quote multiplier, which never changes. */
export const pnlImageKey = (cluster: string, p: Pick<Position, "mint" | "wallet" | "at" | "quote">) =>
  `pnl-cards/${cluster}/${p.mint}/${p.wallet}/${p.at}-${p.quote.multiplier}.png`;

/**
 * `GET /coins/:mint/positions/:wallet/card.png?at=`: the P&L card as an image to share and as the share page's link
 * card. A past snapshot's is drawn once and kept in R2; the newest snapshot's is drawn each time, briefly cached.
 */
export async function getPositionImage(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const q = asked(c);
  if (!q) return noPosition(c);
  const position = await positionOf(cfg, c.var.db, q.mint, q.wallet, q.at);
  if (!position || position === "no coin") return noPosition(c);
  const forGood = q.at !== null && BigInt(position.at) === q.at;
  const png = (bytes: Uint8Array | ArrayBuffer) =>
    new Response(bytes, {
      headers: {
        "content-type": "image/png",
        // A day, not a year: an issuer's new multiplier would draw the same snapshot's amounts anew (ADR 0007).
        "cache-control": forGood ? "public, max-age=86400" : "public, max-age=30",
        "access-control-allow-origin": "*",
      },
    });
  const blobs = c.env.BLOBS;
  const key = pnlImageKey(cfg.cluster, position);
  if (forGood && blobs) {
    const kept = await blobs.get(key);
    if (kept) return png(await kept.arrayBuffer());
  }
  const image = await renderPnlImage(position, { cluster: cfg.cluster, web: webApp(cfg) });
  if (forGood && blobs) c.executionCtx.waitUntil(Promise.resolve(blobs.put(key, image, { httpMetadata: { contentType: "image/png" } })).catch((e) => console.warn("keeping a P&L card failed", key, e)));
  return png(image);
}
