import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Postgres is the only system of record (spec 10.4). The job runner's three tables are Stoker's (commit 43e196b,
// packages/db/src/schema.ts), with only the alert kinds this build raises.

export const jobRuns = pgTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed", "skipped"] }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** What the run did, as the job reports it. */
    summary: jsonb("summary"),
    error: text("error"),
  },
  (t) => [index("job_runs_job_started_idx").on(t.job, t.startedAt)],
);

export const jobLocks = pgTable("job_locks", {
  job: text("job").primaryKey(),
  runId: text("run_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const operatorAlerts = pgTable(
  "operator_alerts",
  {
    kind: text("kind", { enum: ["job_failed", "keeper_low_balance"] }).notNull(),
    /** What the alert is about, such as a job's name. */
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the alert reached the operator; retried every run until it does. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.subject] })],
);

/**
 * Where the indexer's reconciliation got to on each account it watches (spec 10.2): the newest signature it has
 * indexed, from which the next run resumes, and that signature's slot.
 */
export const indexerCursors = pgTable("indexer_cursors", {
  account: text("account").primaryKey(),
  signature: text("signature"),
  slot: bigint("slot", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A Creator (spec 7): the person behind a launch, known by an X account, which every launch needs. */
export const creators = pgTable("creators", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** X's numeric user id: the record's identity, which a handle change does not touch. */
  xUserId: text("x_user_id").notNull().unique(),
  /** The handle, name and picture as X last gave them, at the latest link. */
  xHandle: text("x_handle").notNull(),
  xName: text("x_name").notNull(),
  xAvatarUrl: text("x_avatar_url"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Each record's Creator wallets over time (spec 7): the current one has no `ended_at`. A record has one current wallet
 * and a wallet is current for one record at most. The first is the wallet that signs the record's first launch, its
 * signature on that transaction being the proof it controls the wallet.
 */
export const creatorWallets = pgTable(
  "creator_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    wallet: text("wallet").notNull(),
    via: text("via", { enum: ["first_launch", "handover", "rotation"] }).notNull(),
    /** The signature of the transaction the wallet signed to prove it. */
    proof: text("proof").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("creator_wallets_current_per_creator").on(t.creatorId).where(sql`${t.endedAt} is null`),
    uniqueIndex("creator_wallets_current_per_wallet").on(t.wallet).where(sql`${t.endedAt} is null`),
  ],
);

/** A browser signed in by linking X: its cookie holds a random token, and only the token's SHA-256 is kept here. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_creator_idx").on(t.creatorId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** An X OAuth 2.0 authorization in flight: the state the browser carries back, and the PKCE verifier only we hold. */
export const xAuthorizations = pgTable("x_authorizations", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  /** Where on the web app the browser goes once linked. */
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Coins a launch may not copy (spec 6.2), with their folded ticker and name keys; "Vamp Shield: images and the protected
 * set" fills it. Keys are recomputed whenever `fold_version` changes (UTS #39 skeletons are not stable across Unicode).
 */
export const protectedCoins = pgTable(
  "protected_coins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mint: text("mint").notNull(),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    /** Why it is protected: Jupiter-verified, organic activity, trending now, CoinGecko's top 1,000, or a Heat coin. */
    source: text("source", { enum: ["jupiter_verified", "organic", "trending", "coingecko_top", "heat"] }).notNull(),
    tickerStrict: text("ticker_strict").notNull(),
    tickerLoose: text("ticker_loose").notNull(),
    tickerCore: text("ticker_core").notNull(),
    nameStrict: text("name_strict").notNull(),
    nameLoose: text("name_loose").notNull(),
    nameCore: text("name_core").notNull(),
    foldVersion: text("fold_version").notNull(),
    /** When protection lapses on its own, as a trending coin's 72 hours do; null while the coin keeps qualifying. */
    protectedUntil: timestamp("protected_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("protected_coins_mint_source").on(t.mint, t.source),
    index("protected_coins_ticker_strict").on(t.tickerStrict),
    index("protected_coins_ticker_loose").on(t.tickerLoose),
    index("protected_coins_ticker_core").on(t.tickerCore),
    index("protected_coins_name_strict").on(t.nameStrict),
    index("protected_coins_name_loose").on(t.nameLoose),
    index("protected_coins_name_core").on(t.nameCore),
  ],
);

/**
 * A launch the launch service prepared (spec 10.2): its coin, the message the Creator wallet signs (an Instant launch's
 * creation transaction, signed by the mint key, or a Fair Open's schedule), and how far it got. The mint key itself is
 * never kept (spec 10.3), only its signatures. A Fair Open's ladder is in `fair_open_rungs`.
 */
export const launches = pgTable(
  "launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    /** The wallet that signs: the record's Creator wallet, or the one this first launch makes it. */
    wallet: text("wallet").notNull(),
    mode: text("mode", { enum: ["instant", "fair_open"] }).notNull(),
    name: text("name").notNull(),
    ticker: text("ticker").notNull(),
    mint: text("mint").notNull().unique(),
    pool: text("pool").notNull().unique(),
    config: text("config").notNull(),
    metadataUri: text("metadata_uri").notNull(),
    imageUri: text("image_uri").notNull(),
    /** The message the Creator wallet signs, base64: a submitted transaction must carry exactly these bytes. */
    message: text("message").notNull(),
    /** The mint key's signature on an Instant launch's message, base58; a Fair Open's schedule has none. */
    mintSignature: text("mint_signature"),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }).notNull(),
    status: text("status", { enum: ["prepared", "sending", "landed", "failed", "expired"] })
      .notNull()
      .default("prepared"),
    /** The transaction's signature, which is the Creator wallet's, once submitted. */
    signature: text("signature").unique(),
    slot: bigint("slot", { mode: "number" }),
    error: text("error"),
    createdAt: createdAt(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    landedAt: timestamp("landed_at", { withTimezone: true }),
    /**
     * A Fair Open's ticker's strict key (spec 2.1 step 3), reserved while the launch is being scheduled and through its
     * deposit window, so two Fair Opens of one ticker never hold overlapping windows; null once released, when the launch
     * opens, fails or expires unsent.
     */
    tickerKey: text("ticker_key"),
    // A Fair Open's schedule (spec 2.1 step 4): its launch account, the durable nonce our keeper made for it, its window
    // and minimum raise, and the calendar's teaser.
    fairOpen: text("fair_open").unique(),
    nonce: text("nonce").unique(),
    depositsOpenAt: timestamp("deposits_open_at", { withTimezone: true }),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    minRaise: bigint("min_raise", { mode: "bigint" }),
    teaser: text("teaser"),
    /** How the creator signs the open (ADR 0005): the whole ladder at scheduling, or the one rung at the open. */
    ladder: text("ladder", { enum: ["signed", "at_open"] }),
    // What the keeper's Workflow did at the open (spec 10.2): the rung it sent, when it sent it by the Worker's clock, and
    // when it landed by the chain's, from which how late the open lands is measured; then when every seat had its coins.
    openSignature: text("open_signature"),
    openSentAt: timestamp("open_sent_at", { withTimezone: true }),
    openSlot: bigint("open_slot", { mode: "number" }),
    openLandedAt: timestamp("open_landed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    index("launches_creator_created_idx").on(t.creatorId, t.createdAt),
    index("launches_status_idx").on(t.status),
    uniqueIndex("launches_ticker_reserved").on(t.tickerKey).where(sql`${t.tickerKey} is not null`),
  ],
);

/**
 * A Fair Open's ladder (spec 2.1 step 6, ADR 0005): its creation transaction for each rung, on the launch's durable
 * nonce, with the signatures collected so far, base58. The mint key signs every rung when the launch is prepared, and is
 * then dropped; the Creator wallet signs every rung at scheduling, or only the rung the pot covers at the open; our
 * keeper signs last.
 */
export const fairOpenRungs = pgTable(
  "fair_open_rungs",
  {
    launchId: uuid("launch_id")
      .notNull()
      .references(() => launches.id),
    /** What the pot spends on this rung, in the quote's raw units. */
    rung: bigint("rung", { mode: "bigint" }).notNull(),
    /** The creation transaction's message, base64. */
    message: text("message").notNull(),
    mintSignature: text("mint_signature").notNull(),
    creatorSignature: text("creator_signature"),
    keeperSignature: text("keeper_signature"),
  },
  (t) => [primaryKey({ columns: [t.launchId, t.rung] })],
);

/** A launch's two Arweave data items (spec 2.2): signed when it is prepared, uploaded through Turbo when submitted. */
export const metadataItems = pgTable(
  "metadata_items",
  {
    launchId: uuid("launch_id")
      .notNull()
      .references(() => launches.id),
    item: text("item", { enum: ["image", "metadata"] }).notNull(),
    arweaveId: text("arweave_id").notNull().unique(),
    contentType: text("content_type").notNull(),
    /** The signed data item's size, header included. */
    bytes: integer("bytes").notNull(),
    /** Where the signed bytes wait in R2 until uploaded, and stay as the Arweave cache. */
    storageKey: text("storage_key").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    receipt: jsonb("receipt"),
  },
  (t) => [primaryKey({ columns: [t.launchId, t.item] })],
);

/**
 * Heat coins (spec 8): every coin our launch key co-signed, as the fee program's `CoinRecord` lists it. The launch
 * service adds a coin when its launch lands, and the indexer when it sees the coin registered on chain, whichever comes
 * first; a coin registered without a launch in this database (another deployment's) has no image here.
 */
export const coins = pgTable(
  "coins",
  {
    mint: text("mint").primaryKey(),
    pool: text("pool").notNull().unique(),
    config: text("config").notNull(),
    launchMode: text("launch_mode", { enum: ["instant", "fair_open"] }).notNull(),
    launchId: uuid("launch_id").references(() => launches.id),
    creatorId: uuid("creator_id").references(() => creators.id),
    /** The Creator wallet that signed the launch, the pool's DBC creator when it was created. */
    creatorWallet: text("creator_wallet").notNull(),
    name: text("name").notNull(),
    ticker: text("ticker").notNull(),
    metadataUri: text("metadata_uri").notNull(),
    imageUri: text("image_uri"),
    createdSignature: text("created_signature").notNull().unique(),
    createdSlot: bigint("created_slot", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("coins_creator_idx").on(t.creatorId), index("coins_created_idx").on(t.createdAt)],
);

/**
 * Every DBC pool on Heat's configs (spec 2.4), recorded by the indexer as it is created, whether or not our launch key
 * co-signed it (`coins` lists the ones it did). Its price and quote reserve follow its latest trade, so a coin page
 * reads one row.
 */
export const pools = pgTable(
  "pools",
  {
    pool: text("pool").primaryKey(),
    mint: text("mint").notNull().unique(),
    config: text("config").notNull(),
    /** The pool's DBC creator role when it was created. */
    creator: text("creator").notNull(),
    name: text("name").notNull(),
    ticker: text("ticker").notNull(),
    uri: text("uri").notNull(),
    /** When trading opened, from which the sniper tax counts (spec 3.2): the pool's activation point. */
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    createdSignature: text("created_signature").notNull(),
    createdSlot: bigint("created_slot", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** The square-root price (Q64.64) after the latest trade, or curve A's start before the first. */
    sqrtPrice: numeric("sqrt_price", { precision: 40, scale: 0 }).notNull(),
    /** The quote the curve holds after the latest trade, in raw units: what Graduation is measured against. */
    quoteReserve: bigint("quote_reserve", { mode: "bigint" }).notNull(),
    /** The latest trade's order key (see `trades`), so a trade indexed late never rolls the state back. */
    lastTradeKey: numeric("last_trade_key", { precision: 30, scale: 0 }),
    /** Wallets holding the coin outside the pool, when last counted; null until first counted. */
    holders: integer("holders"),
    holdersCountedAt: timestamp("holders_counted_at", { withTimezone: true }),
  },
  (t) => [index("pools_created_idx").on(t.createdAt)],
);

/**
 * Every swap on a Heat config's pool (spec 10.2), kept forever, keyed by its transaction and its place among the
 * transaction's swaps. Amounts are raw units, and the quote side is before the fee: what a buy paid in, or what a sell's
 * coins fetched before the fee came off.
 */
export const trades = pgTable(
  "trades",
  {
    signature: text("signature").notNull(),
    /** The swap's place among its transaction's swaps, in execution order. */
    eventIndex: integer("event_index").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    /** The transaction's place in its block (`getBlock`), which orders a slot's trades. */
    blockIndex: integer("block_index").notNull(),
    /** The trades' total order in one number: slot * 10^10 + block index * 10^4 + event index. */
    orderKey: numeric("order_key", { precision: 30, scale: 0 }).notNull(),
    /** The chain's clock when the swap ran, which the sniper tax counts by. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    pool: text("pool").notNull(),
    mint: text("mint").notNull(),
    /** The wallet that swapped: the swap's payer. */
    trader: text("trader").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    quoteAmount: bigint("quote_amount", { mode: "bigint" }).notNull(),
    /** The coins the trader received (a buy) or sold (a sell). */
    baseAmount: bigint("base_amount", { mode: "bigint" }).notNull(),
    /** The swap's whole fee, in the quote: trading, protocol and referral, the sniper tax included. */
    fee: bigint("fee", { mode: "bigint" }).notNull(),
    /** The square-root price after the swap, and the price it stands for in whole quote units per coin. */
    sqrtPrice: numeric("sqrt_price", { precision: 40, scale: 0 }).notNull(),
    price: numeric("price", { precision: 38, scale: 18 }).notNull(),
    quoteReserve: bigint("quote_reserve", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.eventIndex] }),
    index("trades_mint_order_idx").on(t.mint, t.orderKey),
    index("trades_trader_idx").on(t.trader),
  ],
);

/**
 * Candles (spec 10.2): each trade is folded into its candle at every length as it is indexed, the way a rebuild from
 * `trades` folds them, so any candle can be rebuilt. 1 s candles are kept 7 days and 15 s ones 30 days, the rest forever.
 */
export const candles = pgTable(
  "candles",
  {
    mint: text("mint").notNull(),
    /** The candle's length in seconds: 1, 15, 60, 300, 900, 3,600, 14,400 or 86,400. */
    seconds: integer("seconds").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    open: numeric("open", { precision: 38, scale: 18 }).notNull(),
    high: numeric("high", { precision: 38, scale: 18 }).notNull(),
    low: numeric("low", { precision: 38, scale: 18 }).notNull(),
    close: numeric("close", { precision: 38, scale: 18 }).notNull(),
    /** The order keys of the trades that set the open and the close, so a trade indexed late still lands in place. */
    openKey: numeric("open_key", { precision: 30, scale: 0 }).notNull(),
    closeKey: numeric("close_key", { precision: 30, scale: 0 }).notNull(),
    /** Quote traded before fees, and coins traded, in raw units. */
    volumeQuote: numeric("volume_quote", { precision: 30, scale: 0 }).notNull(),
    volumeBase: numeric("volume_base", { precision: 30, scale: 0 }).notNull(),
    trades: integer("trades").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mint, t.seconds, t.startsAt] })],
);

/** Every transaction the indexer has processed, with or without trades, so the live source and reconciliation skip it. */
export const indexedTransactions = pgTable("indexed_transactions", {
  signature: text("signature").primaryKey(),
  slot: bigint("slot", { mode: "number" }).notNull(),
  /** The transaction's place in its block, looked up only for a transaction with trades. */
  blockIndex: integer("block_index"),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Each pool's window claim (spec 4, 5.2), from the fee program's `WindowFeesClaimed`: once per pool, the first claim of
 * its partner fees after its Tax window, which paid them to the treasury. A claim that ran late also paid the normal
 * fees of the seconds between `window_ended_at` and `claimed_at`.
 */
export const windowClaims = pgTable("window_claims", {
  pool: text("pool").primaryKey(),
  mint: text("mint").notNull().unique(),
  /** Whether a `CoinRecord` lists the pool: false for a pool made around Heat's flow. */
  heat: boolean("heat").notNull(),
  /** The quote account paid: the treasury's, for an Instant launch and a pool around Heat's flow. */
  destination: text("destination").notNull(),
  /** In the quote's raw units. */
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  windowEndedAt: timestamp("window_ended_at", { withTimezone: true }).notNull(),
  /** When the claim ran, by the chain's clock. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  signature: text("signature").notNull(),
  slot: bigint("slot", { mode: "number" }).notNull(),
});

/**
 * Every claim of Creator Earnings (spec 4), from the fee program's `FeesClaimed`: a pool's partner fees split between
 * whoever held its DBC creator role at the claim and the treasury. Keyed by its transaction and its place among the
 * transaction's claims, since a creator's claim covers several pools in one transaction.
 */
export const feeClaims = pgTable(
  "fee_claims",
  {
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    /** The block's time. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    pool: text("pool").notNull(),
    mint: text("mint").notNull(),
    /** The creator role holder paid. */
    creator: text("creator").notNull(),
    /** In the quote's raw units: the creator's half, rounded down, and the treasury's rest. */
    creatorAmount: bigint("creator_amount", { mode: "bigint" }).notNull(),
    treasuryAmount: bigint("treasury_amount", { mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.signature, t.eventIndex] }), index("fee_claims_creator_idx").on(t.creator), index("fee_claims_mint_idx").on(t.mint)],
);

/**
 * Each Fair Open on chain (spec 2.1, 5.3), from the Fair Open program's events: its terms as scheduled, whether it
 * failed or closed, and after an open, its Creator lock and its Tax Share. What its pot holds is read from its launch
 * account, the one place it is always right, while it lasts; the teaser is the calendar's text, which the scheduling
 * flow sets (spec 2.1 step 4).
 */
export const fairOpens = pgTable(
  "fair_opens",
  {
    launch: text("launch").primaryKey(),
    /** The Creator wallet that signed it. */
    creator: text("creator").notNull(),
    nonce: text("nonce").notNull().unique(),
    dbcConfig: text("dbc_config").notNull(),
    quoteMint: text("quote_mint").notNull(),
    /** The SHA-256 its coin's identity is sealed behind, hex. */
    identityHash: text("identity_hash").notNull(),
    depositsOpenAt: timestamp("deposits_open_at", { withTimezone: true }).notNull(),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    /** In the quote's raw units. */
    minRaise: bigint("min_raise", { mode: "bigint" }).notNull(),
    potCap: bigint("pot_cap", { mode: "bigint" }).notNull(),
    lowestRung: bigint("lowest_rung", { mode: "bigint" }).notNull(),
    step: bigint("step", { mode: "bigint" }).notNull(),
    status: text("status", { enum: ["scheduled", "opened", "failed", "closed"] })
      .notNull()
      .default("scheduled"),
    failure: text("failure", { enum: ["below_lowest_rung", "min_raise_missed", "late"] }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** From the open (spec 2.1 step 10): the coin and its pool, the rung the pot spent and the coins it bought. */
    mint: text("mint"),
    pool: text("pool"),
    spent: bigint("spent", { mode: "bigint" }),
    coins: bigint("coins", { mode: "bigint" }),
    /** How many seats the open filled, each owed its coins and refund. */
    seats: integer("seats"),
    openedSignature: text("opened_signature"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /**
     * The Creator lock (spec 2.1 step 13), once it has run: the Jupiter Lock escrow, none when the creator's seat bought
     * no coins; the coins in it; when its release starts and when all of it is free; and when it ran.
     */
    lockEscrow: text("lock_escrow"),
    lockCoins: bigint("lock_coins", { mode: "bigint" }),
    lockCliffAt: timestamp("lock_cliff_at", { withTimezone: true }),
    lockEndsAt: timestamp("lock_ends_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockSignature: text("lock_signature"),
    /**
     * The Tax Share (spec 2.1 step 14), once collected, in the quote's raw units: the window's fees less the pot's own
     * fee, the lamport dust of the open's rounding, and their total; the fills it is shared by; and whether, with no seat
     * but the creator's, it went to the treasury.
     */
    taxShare: bigint("tax_share", { mode: "bigint" }),
    taxShareFees: bigint("tax_share_fees", { mode: "bigint" }),
    taxShareDust: bigint("tax_share_dust", { mode: "bigint" }),
    taxShareBasis: bigint("tax_share_basis", { mode: "bigint" }),
    taxShareToTreasury: boolean("tax_share_to_treasury"),
    taxShareCollectedAt: timestamp("tax_share_collected_at", { withTimezone: true }),
    taxShareSignature: text("tax_share_signature"),
    /** When its launch account closed, its rent back to the creator: a failed launch's status says closed too. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    teaser: text("teaser"),
    createdSignature: text("created_signature").notNull(),
    createdSlot: bigint("created_slot", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("fair_opens_opens_at_idx").on(t.opensAt), index("fair_opens_creator_idx").on(t.creator)],
);

/**
 * Every change to a Fair Open seat (spec 2.1 steps 9, 12 to 15), from the Fair Open program's events: a deposit, a
 * withdrawal in the window, its coins and refund delivered after the open, the creator's seat's coins locked, its Tax
 * Share paid as it closed, or a failed launch's refund. Keyed by its transaction and its place among the transaction's
 * seat events.
 */
export const fairOpenSeatEvents = pgTable(
  "fair_open_seat_events",
  {
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    /** The block's time. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    launch: text("launch").notNull(),
    wallet: text("wallet").notNull(),
    /** The person's pseudonym in this launch, hex. */
    person: text("person").notNull(),
    kind: text("kind", { enum: ["deposit", "withdraw", "delivery", "lock", "tax_share", "refund"] }).notNull(),
    /** The tier a deposit was admitted at; none on a withdrawal, delivery or refund. */
    tier: text("tier", { enum: ["unverified", "scored", "verified"] }),
    /**
     * What moved, in the quote's raw units: a refund's is the deposit alone, its rents apart; a delivery's, its refund; a
     * lock's, what the Creator wallet got back of its refund and its coin account's rent; a Tax Share's, the share.
     */
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    /** What the seat held after it: a delivery's or a lock's is the deposit it bought with; a Tax Share's, its fill. */
    deposit: bigint("deposit", { mode: "bigint" }).notNull(),
    /**
     * A refund's rents returned, the coin account's and the seat's; a delivery's, the coin account's when it existed; a
     * lock's or a Tax Share's, the seat's as it closed.
     */
    rent: bigint("rent", { mode: "bigint" }),
    /** A delivery's or a lock's spend of the rung and the coins it bought; a Tax Share's spend. */
    spent: bigint("spent", { mode: "bigint" }),
    coins: bigint("coins", { mode: "bigint" }),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.eventIndex] }),
    index("fair_open_seat_events_launch_idx").on(t.launch, t.slot),
    index("fair_open_seat_events_wallet_idx").on(t.wallet),
  ],
);

/**
 * The admission server's record of who it admitted to each Fair Open (spec 6.3, 10.2): one row per launch and wallet,
 * whose person is fixed at its first admission, so a wallet keeps one seat and a person one wallet in a launch. The
 * person is a cluster id: an X account (`x:<user id>`), or until one is linked the wallet itself (`wallet:<address>`);
 * the linkage pipeline merges clusters later. The pseudonym is what the chain sees.
 */
export const admissions = pgTable(
  "admissions",
  {
    launch: text("launch").notNull(),
    wallet: text("wallet").notNull(),
    cluster: text("cluster").notNull(),
    /** The person's pseudonym in this launch, hex: the seat's address derives from it. */
    pseudonym: text("pseudonym").notNull(),
    /** The highest tier the wallet has been admitted at in this launch: a tier never falls inside a window. */
    tier: text("tier", { enum: ["unverified", "scored", "verified"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.launch, t.wallet] }), uniqueIndex("admissions_launch_cluster").on(t.launch, t.cluster)],
);
