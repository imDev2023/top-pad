import { z } from "zod";
import { Decimal } from "./coin";
import { CreatorSummary } from "./creatorSummary";
import { Address, RawAmount } from "./launch";
import { QuoteInfo } from "./quote";
import { LooksLike } from "./vampShield";

// The Discover board (spec 8, 9 screen 1, #57): Live now, Up next, Trending, New and Graduated, each coin row with its
// flags. Only coins our launch key co-signed are listed: the board, search and the calendar read the `CoinRecord` list's
// mirror, never a pool made around Heat's flow (spec 2.4).

/**
 * A coin row's flags (spec 8, 9): Bundle Radar's red flag (wallets directly linked to the creator, with what they
 * bought across the pot and the first hour) and yellow flag (creation-slot buys by wallets it does not link), Vamp
 * Shield's "looks like X" labels, and a published confirmed creator bundle. Labels only mark; only a confirmed bundle
 * moves a coin, out of Trending and every featured slot.
 */
export const BoardFlags = z.object({
  linked: z.object({ wallets: z.number().int().nonnegative(), coins: RawAmount }),
  earlyBuys: z.number().int().nonnegative(),
  looksLike: z.array(LooksLike),
  confirmedBundle: z.boolean(),
});
export type BoardFlags = z.infer<typeof BoardFlags>;

/** Why a coin trends (spec 8): its unique net buyers of the last hour, decayed by age, and the capped volume tie-break. */
export const TrendingFigures = z.object({
  /** Wallets that bought more than they sold in the last hour, none of them left out by Trending's rules. */
  buyers: z.number().int().positive(),
  /** The buyers, each counting half as much every 20 minutes since their latest buy. */
  score: z.number().nonnegative(),
  /** Their buys, each wallet's capped at 1% of the Graduation Target, in Graduation Targets. */
  volume: z.number().nonnegative(),
});
export type TrendingFigures = z.infer<typeof TrendingFigures>;

/** A Heat coin's row on the board and in search. Amounts are the quote's raw units, prices and caps unscaled. */
export const BoardCoin = z.object({
  mint: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().url().nullable(),
  launchMode: z.enum(["instant", "fair_open"]),
  /** When it joined the board: an Instant launch at its creation, a Fair Open at its open. */
  listedAt: z.iso.datetime(),
  creator: z.object({ wallet: Address, handle: z.string().nullable() }),
  quote: QuoteInfo,
  marketCap: Decimal,
  /** The quote its curve holds, and Graduation's (spec 2.3): the graduation bar. */
  quoteReserve: RawAmount,
  graduationTarget: RawAmount,
  graduatedAt: z.iso.datetime().nullable(),
  holders: z.number().int().nonnegative().nullable(),
  /** The Fair Open it opened from; null for an Instant launch. */
  fairOpen: Address.nullable(),
  supply: RawAmount,
  flags: BoardFlags,
  /** Present on Trending's rows only. */
  trending: TrendingFigures.nullable(),
});
export type BoardCoin = z.infer<typeof BoardCoin>;

/**
 * A sealed calendar entry (spec 8, 9): a Fair Open before its open, shown as a "?" tile with its time, its creator and
 * their record summary, its terms and its teaser. Nothing about the coin itself (its name, ticker, image or mint) exists
 * here before the open: the chain holds only the hash it is sealed behind.
 */
export const CalendarEntry = z.object({
  launch: Address,
  /** `window`: deposits are open now, Live now; `scheduled`: the window has not begun, Up next. */
  phase: z.enum(["scheduled", "window"]),
  depositsOpenAt: z.iso.datetime(),
  opensAt: z.iso.datetime(),
  creator: z.object({ wallet: Address, handle: z.string().nullable() }),
  record: CreatorSummary.nullable(),
  teaser: z.string().nullable(),
  quote: QuoteInfo,
  /** The terms, in the quote's raw units: the least the pot must reach to open, and the most it takes. */
  minRaise: RawAmount,
  potCap: RawAmount,
  /** What the pot holds now, and its seats: zero before the window. */
  pot: z.object({ total: RawAmount, seats: z.number().int().nonnegative() }),
  /** One of its day's three featured slots (spec 8): earned by a good record, never sold. */
  featured: z.boolean(),
});
export type CalendarEntry = z.infer<typeof CalendarEntry>;

/** `GET /board`: the board in spec 8's order, up to a minute stale except Trending, which is at most 15 s old. */
export const Board = z.object({
  liveNow: z.array(CalendarEntry),
  /** The sealed calendar for the next 7 days, by open time, featured entries marked. */
  upNext: z.array(CalendarEntry),
  trending: z.array(BoardCoin),
  /** When Trending was worked out: the board's Durable Object works it out again every 15 s. */
  trendingAt: z.iso.datetime(),
  /** Newest first. */
  new: z.array(BoardCoin),
  /** Newest Graduation first. */
  graduated: z.array(BoardCoin),
  /** The API's clock when the board was read, which the countdowns count by. */
  serverTime: z.iso.datetime(),
});
export type Board = z.infer<typeof Board>;

/** `GET /search?q=`: Heat coins whose name, ticker or mint matches, best match first; never a sealed coin. */
export const SearchResults = z.object({ query: z.string(), coins: z.array(BoardCoin) });
export type SearchResults = z.infer<typeof SearchResults>;

/** One `CoinRecord` as the public mirror lists it: what the fee program's account says of the coin. */
export const CoinRecordEntry = z.object({
  mint: Address,
  pool: Address,
  /** The DBC config its pool is on: one of Heat's (spec 3.2), the pool account's to say. */
  config: Address,
  launchMode: z.enum(["instant", "fair_open"]),
  /** The Fair Open launch account it opened from; null for an Instant launch. */
  fairOpenLaunch: Address.nullable(),
  /** The slot and block time of the transaction that registered it. */
  slot: z.number().int().nonnegative(),
  registeredAt: z.iso.datetime(),
});
export type CoinRecordEntry = z.infer<typeof CoinRecordEntry>;

/** `GET /coin-records?after=&limit=`: the public mirror of the `CoinRecord` list, oldest first. */
export const CoinRecordList = z.object({
  cluster: z.string(),
  /** The fee program whose `CoinRecord` accounts these are, and the launch key that co-signed every coin. */
  program: Address,
  launchKey: Address,
  coins: z.array(CoinRecordEntry),
  /** Pass as `after` for the next page; null on the last. */
  next: z.string().nullable(),
});
export type CoinRecordList = z.infer<typeof CoinRecordList>;

/** The signed daily snapshot's body: the `CoinRecord` list's mirror as it stood when the day ended. */
export const CoinRecordSnapshotBody = z.object({
  version: z.literal(1),
  cluster: z.string(),
  /** The UTC day, and the moment it ended: every coin registered before it. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  through: z.iso.datetime(),
  program: Address,
  launchKey: Address,
  /**
   * The DBC configs Heat lists coins on: each quote's pairs, the retired ones too. A `CoinRecord` whose pool is on another
   * config (devnet's rehearsal configs, whose coins are never Heat's) is not listed.
   */
  configs: z.array(Address),
  coins: z.array(CoinRecordEntry),
});
export type CoinRecordSnapshotBody = z.infer<typeof CoinRecordSnapshotBody>;

/** What the launch key signs: this prefix and the body's SHA-256 in hex, as UTF-8. */
export const COIN_RECORD_SNAPSHOT_PREFIX = "heat:coin-records:v1:";

/**
 * `GET /coin-records/snapshots/:day` (or `latest`): a day's snapshot, its body exactly as signed. To verify it, hash
 * `body`'s UTF-8 bytes with SHA-256, check `message` is the prefix and that hash, and check `signature` is `signer`'s
 * Ed25519 signature on `message`; `signer` must be the launch key the coin records name.
 */
export const CoinRecordSnapshot = z.object({
  day: z.string(),
  coins: z.number().int().nonnegative(),
  body: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  message: z.string(),
  signer: Address,
  signature: z.string(),
  createdAt: z.iso.datetime(),
});
export type CoinRecordSnapshot = z.infer<typeof CoinRecordSnapshot>;
