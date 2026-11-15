// The Fairness card (spec 9, #58): what is proven on chain about a Heat coin, what is labelled and what was found. Its
// facts come from what the indexer wrote and, for what the creator holds now, from the chain; its rows are worded here
// once, for the coin page and for the image X shows as the coin's link card, which `cardImage.ts` draws and R2 keeps.
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { COIN_DECIMALS, COIN_SUPPLY } from "@top-pad/chain";
import {
  Address,
  type FairnessCard,
  type FairnessFacts,
  type FairnessFlag,
  type FairnessLink,
  type FairnessRow,
  type FairnessRowKey,
  type QuoteInfo,
} from "@top-pad/contract";
import { coinAmount, compactNumber, dayOf, quoteText, scaledFigure, shareOf, shortAddress } from "@top-pad/contract/format";
import { coins, fairOpens, graduations, pools, trades, windowClaims, type Db } from "@top-pad/db";
import { radarOf, radarSummary, walletCoinBalance } from "@top-pad/indexer";
import { creatorLockOf, taxShareOf } from "./afterOpen";
import { coinFinding } from "./bars";
import { cached } from "./board";
import { renderCardImage } from "./cardImage";
import { recordAt, summaryOf } from "./creatorRecord";
import { explorerUrl, webApp, type Config } from "./env";
import type { AppEnv } from "./http";
import { quoteInfoOf } from "./quotes";

/** A card stands this long in KV: spec 10.4 lets public figures be a minute stale, and the card reads the chain once. */
export const FAIRNESS_CACHE_MS = 30_000;
const BALANCE_TIMEOUT_MS = 2_500;

/** What the card names besides its facts. */
type CardCoin = { mint: string; name: string; ticker: string; imageUri: string | null; launchMode: "instant" | "fair_open"; quote: QuoteInfo };

/** An unscaled price of 18 places, as the API writes prices: quote raw units over coin raw units, in whole units. */
function priceOf(spent: bigint, coinsBought: bigint, quoteDecimals: number): string {
  if (coinsBought === 0n) return "0";
  const scaled = (spent * 10n ** BigInt(COIN_DECIMALS + 18)) / (coinsBought * 10n ** BigInt(quoteDecimals));
  const whole = scaled / 10n ** 18n;
  const fraction = (scaled % 10n ** 18n).toString().padStart(18, "0");
  return `${whole}.${fraction}`;
}

/** Every fact the card's rows are worded from, read from Postgres and, for the creator's holdings, the chain. */
export async function fairnessFacts(cfg: Config, db: Db, mint: string): Promise<{ coin: CardCoin; facts: FairnessFacts } | null> {
  const heat = cfg.heat;
  if (!heat || !Address.safeParse(mint).success) return null;
  const [row] = await db
    .select({ coin: coins, pool: pools, graduation: graduations, fairOpen: fairOpens, windowClaim: windowClaims })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(graduations, eq(graduations.mint, coins.mint))
    .leftJoin(fairOpens, eq(fairOpens.mint, coins.mint))
    .leftJoin(windowClaims, eq(windowClaims.pool, pools.pool))
    .where(eq(coins.mint, mint));
  if (!row) return null;
  const { coin, pool, graduation, fairOpen, windowClaim } = row;
  const quote = await quoteInfoOf(cfg, heat, pool.quoteMint);
  const wallet = coin.creatorWallet;

  const sumOf = async (where: ReturnType<typeof and>) => {
    const [found] = await db.select({ coins: sql<string>`coalesce(sum(${trades.baseAmount}), 0)::text` }).from(trades).where(where);
    return found?.coins ?? "0";
  };

  let launch: FairnessFacts["launch"];
  let creatorLock: FairnessFacts["creatorLock"] = null;
  let keeper: FairnessFacts["keeper"] = null;
  let tax: FairnessFacts["tax"];
  if (fairOpen && fairOpen.openedSignature) {
    const spent = fairOpen.spent ?? 0n;
    const bought = fairOpen.coins ?? 0n;
    launch = {
      mode: "fair_open",
      launch: fairOpen.launch,
      people: fairOpen.seats ?? 0,
      spent: `${spent}`,
      coins: `${bought}`,
      price: priceOf(spent, bought, quote.decimals),
      identityHash: fairOpen.identityHash,
      opened: fairOpen.openedSignature,
    };
    const lock = await creatorLockOf(cfg, db, fairOpen);
    creatorLock = { status: lock.status, deposit: lock.deposit, coins: lock.coins, escrow: lock.escrow, cliffAt: lock.cliffAt, endsAt: lock.endsAt };
    // The keeper pays for the open, as the rungs' fee payer (spec 2.1 step 10).
    keeper = { address: heat.keys!.keeper, signature: fairOpen.openedSignature };
    const share = await taxShareOf(cfg, db, fairOpen);
    tax = {
      to: "depositors",
      collected: share
        ? { total: share.total, paidSeats: share.paidSeats, toTreasury: share.toTreasury, at: share.collectedAt, signature: fairOpen.taxShareSignature! }
        : null,
    };
  } else {
    launch = {
      mode: "instant",
      creation: coin.createdSignature,
      creationBuy: await sumOf(and(eq(trades.mint, mint), eq(trades.signature, coin.createdSignature), eq(trades.side, "buy"))),
    };
    tax = {
      to: "heat",
      claimed: windowClaim ? { amount: `${windowClaim.amount}`, at: windowClaim.claimedAt.toISOString(), signature: windowClaim.signature } : null,
    };
  }

  let held: string | null = null;
  try {
    held = `${await walletCoinBalance(cfg.rpcUrl, wallet, mint, AbortSignal.timeout(BALANCE_TIMEOUT_MS))}`;
  } catch (e) {
    // The row says it could not be read rather than failing the card.
    console.warn("reading the Creator wallet's holdings failed", mint, e);
  }
  const radar = await radarOf(db, mint);
  const summary = radar ? radarSummary(radar) : { linkedWallets: [], linkedCoins: 0n, earlyBuys: 0 };

  const facts: FairnessFacts = {
    launch,
    creatorLock,
    holdings: { wallet, coins: held, bought: await sumOf(and(eq(trades.mint, mint), eq(trades.trader, wallet), eq(trades.side, "buy"))) },
    liquidity: {
      curve: pool.pool,
      graduated: graduation
        ? { at: graduation.graduatedAt.toISOString(), pool: graduation.pool, creatorPosition: graduation.creatorPosition, heatPosition: graduation.heatPosition }
        : null,
    },
    radar: { linkedWallets: summary.linkedWallets.length, linkedCoins: `${summary.linkedCoins}`, earlyBuys: summary.earlyBuys },
    finding: await coinFinding(db, mint),
    record: await summaryOf(db, coin.creatorId ?? (await recordAt(db, wallet, coin.createdAt))),
    keeper,
    tax,
  };
  return {
    coin: { mint, name: coin.name, ticker: coin.ticker, imageUri: coin.imageUri, launchMode: coin.launchMode as CardCoin["launchMode"], quote },
    facts,
  };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The card's rows, worded from its facts: red rows first, then the spec's order (spec 9). */
export function fairnessRows(cfg: Config, coin: CardCoin, facts: FairnessFacts, now = new Date()): FairnessRow[] {
  const tx = (signature: string) => explorerUrl(cfg, "tx", signature);
  const account = (address: string) => explorerUrl(cfg, "address", address);
  const $ = `$${coin.ticker}`;
  const amount = (raw: string | bigint) => `${coinAmount(raw, COIN_DECIMALS)} ${$}`;
  const supplyShare = (raw: string | bigint) => shareOf(raw, COIN_SUPPLY);
  const row = (key: FairnessRowKey, flag: FairnessFlag, title: string, short: string, value: string, detail: string, links: FairnessLink[] = []): FairnessRow => ({
    key,
    flag,
    title,
    short,
    value,
    detail,
    links,
  });
  const rows: FairnessRow[] = [];
  const { launch } = facts;

  if (facts.finding) {
    const appeal =
      facts.finding.appeal === "open" ? "The creator's appeal is waiting on an operator." : facts.finding.appeal === "denied" ? "The creator's appeal was denied." : "No appeal is filed.";
    rows.push(
      row(
        "finding",
        "red",
        "Confirmed creator bundle",
        "Confirmed creator bundle",
        "An operator confirmed that wallets directly linked to the creator bundled this launch",
        `Published ${dayOf(facts.finding.publishedAt)}; Heat's launch key co-signs none of the creator's launches. ${appeal}`,
        facts.record ? [{ label: "Evidence on the creator's record", href: `/creator/${facts.record.id}` }] : [],
      ),
    );
  }

  if (launch.mode === "fair_open") {
    // A coin's price runs to many leading zeros: a million coins' reads plainly, with no subscript for the zeros.
    const perMillion = compactNumber(scaledFigure(launch.price, coin.quote) * 1_000_000);
    rows.push(
      row(
        "launch",
        "green",
        "Launch",
        `Fair Open · ${plural(launch.people, "person", "people")} · one price`,
        `Fair Open: ${plural(launch.people, "person", "people")} bought at one price, ${perMillion} ${coin.quote.symbol} a million coins`,
        `The pot spent ${quoteText(launch.spent, coin.quote)} on ${amount(launch.coins)} in the open, every seat at the same price, and the coin's name, ticker and metadata matched the hash sealed when it was scheduled.`,
        [
          { label: "The open", href: tx(launch.opened) },
          { label: "The Fair Open", href: `/fair-open/${launch.launch}` },
        ],
      ),
    );
  } else {
    const bought = BigInt(launch.creationBuy) > 0n;
    rows.push(
      row(
        "launch",
        bought ? "yellow" : "green",
        "Launch",
        bought ? "Instant launch · a buy at creation" : "Instant launch · no creator buy",
        bought ? `Instant launch whose creation bought ${amount(launch.creationBuy)}` : "Instant launch with no creator buy",
        bought
          ? "The coin's creation transaction bought coins, which Heat's launch service never builds."
          : "The coin's creation, co-signed by Heat's launch key, bought nothing for the creator; the first buyers paid the sniper tax, falling from 99% over the first minute.",
        [{ label: "The creation", href: tx(launch.creation) }],
      ),
    );
  }

  const lock = facts.creatorLock;
  if (lock) {
    if (lock.status === "locked" && lock.coins && lock.cliffAt && lock.endsAt) {
      const bought = lock.deposit ? `The creator's ${quoteText(lock.deposit, coin.quote)} deposit bought ${amount(lock.coins)}` : `The creator's ${amount(lock.coins)}`;
      // Its cliff passed, the escrow releases steadily to its end; past the end, all of it is free.
      const stage = now < new Date(lock.cliffAt) ? "locked" : now < new Date(lock.endsAt) ? "releasing" : "free";
      rows.push(
        row(
          "creator_lock",
          "green",
          "Creator lock",
          stage === "locked" ? `Creator locked until ${dayOf(lock.cliffAt)}` : stage === "releasing" ? `Creator lock releasing until ${dayOf(lock.endsAt)}` : `Creator lock ran to ${dayOf(lock.endsAt)}`,
          stage === "locked"
            ? `${bought}, locked until ${dayOf(lock.cliffAt)}`
            : stage === "releasing"
              ? `${bought}, releasing steadily until ${dayOf(lock.endsAt)}`
              : `${bought}, all free since ${dayOf(lock.endsAt)}`,
          stage === "locked"
            ? `Released steadily from then, all free ${dayOf(lock.endsAt)}, from a Jupiter Lock escrow nobody can cancel, Heat included.`
            : `Locked until ${dayOf(lock.cliffAt)} in a Jupiter Lock escrow nobody could cancel, Heat included; what it has released shows in the creator's holdings once claimed.`,
          lock.escrow ? [{ label: "The escrow", href: account(lock.escrow) }] : [],
        ),
      );
    } else if (lock.status === "locked" || lock.status === "none") {
      rows.push(
        row(
          "creator_lock",
          "green",
          "Creator lock",
          "No creator coins to lock",
          "The creator bought nothing in the Fair Open, so nothing is locked",
          "The creator buys only through the pot, at the price everyone paid; their seat bought no coins.",
        ),
      );
    } else {
      rows.push(
        row(
          "creator_lock",
          "neutral",
          "Creator lock",
          "Creator lock on its way",
          `The creator's ${lock.deposit ? `${quoteText(lock.deposit, coin.quote)} ` : ""}deposit goes into a Jupiter Lock escrow right after the open`,
          "Heat's keeper locks the creator's coins once every seat has its coins: nothing for 7 days, all free by day 30.",
        ),
      );
    }
  }

  const outside = launch.mode === "fair_open" ? " outside the lock" : "";
  const { holdings } = facts;
  const boughtLine = BigInt(holdings.bought) > 0n ? `It bought ${amount(holdings.bought)} on the pool since the open.` : "It has bought none on the pool since the open.";
  const walletLink = [{ label: "The Creator wallet", href: account(holdings.wallet) }];
  if (holdings.coins === null) {
    rows.push(
      row("holdings", "neutral", "Creator's unlocked holdings", "Creator's holdings unread", "The Creator wallet's holdings could not be read from the chain just now", boughtLine, walletLink),
    );
  } else if (BigInt(holdings.coins) === 0n) {
    rows.push(row("holdings", "green", "Creator's unlocked holdings", `Creator holds none${outside}`, `The Creator wallet holds none of ${$}${outside}`, boughtLine, walletLink));
  } else {
    rows.push(
      row(
        "holdings",
        "yellow",
        "Creator's unlocked holdings",
        `Creator holds ${supplyShare(holdings.coins)}${outside}`,
        `The Creator wallet holds ${amount(holdings.coins)}, ${supplyShare(holdings.coins)} of supply${outside}`,
        `${boughtLine} Coins it holds it may sell at any time.`,
        walletLink,
      ),
    );
  }

  const { graduated } = facts.liquidity;
  rows.push(
    graduated
      ? row(
          "liquidity",
          "checkered",
          "Liquidity",
          "Graduated · liquidity locked forever",
          "100% of liquidity locked forever",
          `Graduated ${dayOf(graduated.at)} into a Meteora pool; both halves of its liquidity, the creator's and Heat's, are permanently locked positions that still earn fees.`,
          [
            { label: "The creator's position", href: account(graduated.creatorPosition) },
            { label: "Heat's position", href: account(graduated.heatPosition) },
            { label: "The pool", href: account(graduated.pool) },
          ],
        )
      : row(
          "liquidity",
          "green",
          "Liquidity",
          "Liquidity can't be withdrawn",
          "Liquidity sits in Meteora's bonding curve; nobody can withdraw it",
          "At Graduation it moves into a Meteora pool, where all of it is locked forever.",
          [{ label: "The bonding curve", href: account(facts.liquidity.curve) }],
        ),
  );

  const { radar } = facts;
  const evidence = [{ label: "The evidence", href: "#radar" }];
  const early = radar.earlyBuys ? ` ${plural(radar.earlyBuys, "buy", "buys")} by wallets it does not link also landed in the creation slot.` : "";
  rows.push(
    radar.linkedWallets > 0
      ? row(
          "radar",
          "red",
          "Bundle Radar",
          `${plural(radar.linkedWallets, "wallet", "wallets")} linked to the creator · ${supplyShare(radar.linkedCoins)} of supply`,
          `${plural(radar.linkedWallets, "wallet", "wallets")} directly linked to the Creator wallet bought ${supplyShare(radar.linkedCoins)} of supply`,
          `Funds passed between each and the Creator wallet, the Creator wallet signed or paid for its buy, or its buy came right after the creation.${early} Labels are Heat's judgement, with every transaction linked.`,
          evidence,
        )
      : radar.earlyBuys > 0
        ? row(
            "radar",
            "yellow",
            "Bundle Radar",
            plural(radar.earlyBuys, "same-slot buy", "same-slot buys"),
            `${plural(radar.earlyBuys, "buy", "buys")} landed in the creation slot, paying the 99% sniper tax`,
            "Buying early is no link to the creator on its own, so this is a label only; no wallet is linked to the Creator wallet.",
            evidence,
          )
        : row(
            "radar",
            "neutral",
            "Bundle Radar",
            "Nothing labelled",
            "Bundle Radar labels no wallet: none linked to the Creator wallet, no buy in the creation slot",
            "It reads every buy of the pot and the first hour, and the Creator wallet's funding in the 7 days before the open.",
          ),
  );

  const record = facts.record;
  const who = record?.x ? `@${record.x.handle}` : shortAddress(record?.wallet ?? holdings.wallet);
  // A handle reads as the creator's on its own; a bare address needs saying whose it is.
  const named = record?.x ? who : `Creator ${who}`;
  if (record) {
    const marks = [record.marks.verifiedCreator ? "Verified creator" : null, record.marks.verifiedHuman ? "verified human" : null].filter(Boolean);
    const figures = [
      plural(record.coins, "coin", "coins"),
      `${record.graduations.toLocaleString("en-US")} graduated`,
      record.handedOver ? `${record.handedOver.toLocaleString("en-US")} handed over` : null,
      record.quiet ? `${record.quiet.toLocaleString("en-US")} quiet` : null,
    ].filter(Boolean);
    rows.push(
      row(
        "creator",
        record.barred ? "red" : "neutral",
        "Creator",
        record.barred ? `${named} · barred` : `${named} · ${plural(record.coins, "coin", "coins")}`,
        record.barred ? `${who} is barred from launching on Heat: ${figures.join(", ")}` : `${who}: ${figures.join(", ")}`,
        record.barred
          ? `Barred: confirmed creator bundle in $${record.barred.ticker}, published ${dayOf(record.barred.publishedAt)}.`
          : `${marks.length ? `${marks.join(", ")}. ` : ""}On Heat since ${dayOf(record.since)}.`,
        [{ label: "The Creator record", href: `/creator/${record.id}` }],
      ),
    );
  } else {
    rows.push(row("creator", "neutral", "Creator", named, `Launched by the Creator wallet ${who}`, "No Creator record holds this coin.", walletLink));
  }

  if (facts.keeper) {
    rows.push(
      row(
        "keeper",
        "green",
        "Keeper",
        "Pot buy sent by Heat's keeper",
        `The pot's buy was sent by Heat's labelled keeper, ${shortAddress(facts.keeper.address)}, never the creator's wallet`,
        "The creator signed the coin's creation in advance; at the open the keeper sent the version the pot covered, and paid for it.",
        [
          { label: "The keeper", href: account(facts.keeper.address) },
          { label: "The open", href: tx(facts.keeper.signature) },
        ],
      ),
    );
  }

  const { tax } = facts;
  if (tax.to === "depositors") {
    const c = tax.collected;
    rows.push(
      !c
        ? row(
            "tax",
            "neutral",
            "Tax Share",
            "Tax Share to depositors",
            "The first minute's sniper tax goes to the pot's depositors as their Tax Share",
            "Heat's keeper collects it once the minute ends and pays each seat in proportion to what it bought; never to the creator.",
          )
        : c.toTreasury
          ? row(
              "tax",
              "neutral",
              "Tax Share",
              `Tax ${quoteText(c.total, coin.quote)} to Heat`,
              `The first minute's tax, ${quoteText(c.total, coin.quote)}, went to Heat's treasury`,
              "No one but the creator held a seat to share it with, and it never goes to the creator.",
              [{ label: "The collection", href: tx(c.signature) }],
            )
          : row(
              "tax",
              "green",
              "Tax Share",
              `Tax Share ${quoteText(c.total, coin.quote)} to depositors`,
              `The first minute's tax, ${quoteText(c.total, coin.quote)}, went to ${plural(c.paidSeats, "depositor", "depositors")} as their Tax Share`,
              `Collected ${dayOf(c.at)} and paid to each seat in proportion to what it bought; never to the creator.`,
              [{ label: "The collection", href: tx(c.signature) }],
            ),
    );
  } else {
    const c = tax.claimed;
    rows.push(
      row(
        "tax",
        "neutral",
        "Sniper tax",
        c ? `Tax ${quoteText(c.amount, coin.quote)} to Heat` : "First minute's tax to Heat",
        c ? `The first minute's sniper tax, ${quoteText(c.amount, coin.quote)}, went to Heat` : "The first minute's sniper tax goes to Heat",
        c
          ? `An Instant launch has no depositors to share it with; claimed to Heat's treasury ${dayOf(c.at)}, never to the creator.`
          : "An Instant launch has no depositors to share it with; Heat's keeper claims it a minute after the open, never to the creator.",
        c ? [{ label: "The claim", href: tx(c.signature) }] : [],
      ),
    );
  }

  return [...rows.filter((r) => r.flag === "red"), ...rows.filter((r) => r.flag !== "red")];
}

/** The card's counts: checkered rows count green, being proven on chain. */
export function countsOf(rows: FairnessRow[]): FairnessCard["counts"] {
  return {
    green: rows.filter((r) => r.flag === "green" || r.flag === "checkered").length,
    yellow: rows.filter((r) => r.flag === "yellow").length,
    red: rows.filter((r) => r.flag === "red").length,
  };
}

/** The first 16 hex digits of the SHA-256 of what the card shows, which names its image. */
async function versionOf(shown: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(shown)));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A coin's whole card; null for a mint that is not a Heat coin. */
export async function fairnessCardOf(cfg: Config, db: Db, mint: string, now = new Date()): Promise<FairnessCard | null> {
  const found = await fairnessFacts(cfg, db, mint);
  if (!found) return null;
  const { coin, facts } = found;
  const rows = fairnessRows(cfg, coin, facts, now);
  const counts = countsOf(rows);
  const version = await versionOf({ name: coin.name, ticker: coin.ticker, imageUri: coin.imageUri, multiplier: coin.quote.multiplier, rows, counts });
  return {
    ...coin,
    counts,
    rows,
    facts,
    version,
    image: `${cfg.apiOrigin}/coins/${mint}/card.png?v=${version}`,
    servedAt: now.toISOString(),
  };
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "Heat has no coin at this address." }, 404);

/** A coin's card through KV. */
const cardOf = (c: Context<AppEnv>, mint: string) => cached(c, `fairness:v1:${mint}`, FAIRNESS_CACHE_MS, () => fairnessCardOf(c.var.cfg, c.var.db, mint));

/** `GET /coins/:mint/fairness`. */
export async function getFairness(c: Context<AppEnv>) {
  const mint = c.req.param("mint")!;
  if (!Address.safeParse(mint).success) return notFound(c);
  const card = await cardOf(c, mint);
  if (!card) return notFound(c);
  c.header("cache-control", "no-store");
  return c.json(card);
}

/** Where a card's image is kept in R2: one object per version, which never changes. */
export const cardImageKey = (cluster: string, mint: string, version: string) => `fairness-cards/${cluster}/${mint}/${version}.png`;

/**
 * `GET /coins/:mint/card.png?v=`: the card as X's link card image. A version R2 holds is served as it was, for good; the
 * current card's image is drawn the first time it is asked for and kept in R2. A version that never existed, or none,
 * gets the current card's, cached briefly, since it changes as the coin does.
 */
export async function getCardImage(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const mint = c.req.param("mint")!;
  if (!Address.safeParse(mint).success) return notFound(c);
  const asked = c.req.query("v");
  const blobs = c.env.BLOBS;
  const png = (bytes: Uint8Array | ArrayBuffer, forGood: boolean) =>
    new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": forGood ? "public, max-age=31536000, immutable" : "public, max-age=60",
        "access-control-allow-origin": "*",
      },
    });
  if (asked && /^[0-9a-f]{16}$/.test(asked) && blobs) {
    const kept = await blobs.get(cardImageKey(cfg.cluster, mint, asked));
    if (kept) return png(await kept.arrayBuffer(), true);
  }
  const card = await cardOf(c, mint);
  if (!card) return notFound(c);
  const key = cardImageKey(cfg.cluster, mint, card.version);
  const kept = blobs ? await blobs.get(key) : null;
  if (kept) return png(await kept.arrayBuffer(), asked === card.version);
  const image = await renderCardImage(card, { cluster: cfg.cluster, web: webApp(cfg) });
  if (blobs) c.executionCtx.waitUntil(Promise.resolve(blobs.put(key, image, { httpMetadata: { contentType: "image/png" } })).catch((e) => console.warn("keeping a card image failed", key, e)));
  return png(image, asked === card.version);
}
