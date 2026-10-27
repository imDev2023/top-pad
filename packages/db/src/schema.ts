import { bigint, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
    kind: text("kind", { enum: ["job_failed"] }).notNull(),
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
