import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
 * A launch the launch service prepared (spec 10.2): its coin, the creation transaction's message as the mint key signed
 * it, and how far it got. The mint key itself is never kept (spec 10.3), only its signature.
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
    /** The creation transaction's message, base64: a submitted transaction must carry exactly these bytes. */
    message: text("message").notNull(),
    /** The mint key's signature on the message, base58. */
    mintSignature: text("mint_signature").notNull(),
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
  },
  (t) => [index("launches_creator_created_idx").on(t.creatorId, t.createdAt), index("launches_status_idx").on(t.status)],
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

/** Heat coins (spec 8): every coin our launch key co-signed, as the fee program's `CoinRecord` lists it. */
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
    imageUri: text("image_uri").notNull(),
    createdSignature: text("created_signature").notNull().unique(),
    createdSlot: bigint("created_slot", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("coins_creator_idx").on(t.creatorId), index("coins_created_idx").on(t.createdAt)],
);
