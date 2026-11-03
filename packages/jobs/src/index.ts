// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: apps/api/src/jobs.ts, with this repo's package names.
import { and, DrizzleQueryError, eq, isNull, sql } from "drizzle-orm";
import type { JobName, JobRun } from "@top-pad/contract";
import { jobLocks, jobRuns, operatorAlerts, type Db } from "@top-pad/db";

/** A Cron Trigger runs for at most 15 minutes, so a lease that long outlives any run whose Worker is still alive. */
const LEASE_SECONDS = 15 * 60;
/** How long a run waits before asking the database a second time to release its lease. */
const RELEASE_RETRY_MS = 1_000;

/**
 * Runs one scheduled job and keeps a record of the run for the operator: when it started and ended, what it reports
 * doing, and why it failed. With `exclusive`, the run first takes the job's lease and is skipped if another run holds it,
 * so a Cron Trigger and a manual run never act at the same time. A failure is recorded and then thrown again.
 *
 * A lease the database failed to release, twice, holds until it expires, skipping every run until then: `leaseSeconds`
 * shortens it for a job that runs often and briefly, so a lost release skips none of its runs, not 15 minutes' worth.
 */
export async function runJob<T>(
  db: Db,
  job: JobName,
  work: () => Promise<T>,
  opts: { exclusive?: boolean; leaseSeconds?: number } = {},
): Promise<JobRun> {
  const id = crypto.randomUUID();
  if (opts.exclusive) {
    const [lease] = await db
      .insert(jobLocks)
      .values({ job, runId: id, expiresAt: sql`now() + make_interval(secs => ${opts.leaseSeconds ?? LEASE_SECONDS})` })
      .onConflictDoUpdate({
        target: jobLocks.job,
        set: { runId: sql`excluded.run_id`, expiresAt: sql`excluded.expires_at` },
        setWhere: sql`${jobLocks.expiresAt} < now()`,
      })
      .returning({ runId: jobLocks.runId });
    if (!lease) {
      const [skipped] = await db.insert(jobRuns).values({ id, job, status: "skipped", finishedAt: sql`now()` }).returning();
      return toJobRun(skipped!);
    }
  }
  try {
    await db.insert(jobRuns).values({ id, job, status: "running" });
    const summary = await work();
    const [done] = await db
      .update(jobRuns)
      .set({ status: "succeeded", finishedAt: sql`now()`, summary: summary ?? null })
      .where(eq(jobRuns.id, id))
      .returning();
    // A job that runs again is no longer failing: its alert, if any, is over.
    await db
      .update(operatorAlerts)
      .set({ resolvedAt: sql`now()` })
      .where(and(eq(operatorAlerts.kind, "job_failed"), eq(operatorAlerts.subject, job), isNull(operatorAlerts.resolvedAt)));
    return toJobRun(done!);
  } catch (e) {
    const failure = e instanceof JobFailure ? e : null;
    const message = failureMessage(e);
    await db
      .update(jobRuns)
      .set({ status: "failed", finishedAt: sql`now()`, error: message, summary: failure?.summary ?? null })
      .where(eq(jobRuns.id, id));
    // One open alert per job, raised on the first failure and kept current with the latest one; resolved by a success.
    await db
      .insert(operatorAlerts)
      .values({ kind: "job_failed", subject: job, message: `The ${job} job failed: ${message}` })
      .onConflictDoUpdate({
        target: [operatorAlerts.kind, operatorAlerts.subject],
        set: {
          message: sql`excluded.message`,
          raisedAt: sql`case when ${operatorAlerts.resolvedAt} is null then ${operatorAlerts.raisedAt} else now() end`,
          notifiedAt: sql`case when ${operatorAlerts.resolvedAt} is null then ${operatorAlerts.notifiedAt} else null end`,
          resolvedAt: sql`null`,
        },
      });
    throw e;
  } finally {
    if (opts.exclusive) await releaseLease(db, job, id);
  }
}

/** Gives up the run's lease, asking twice: a lease left behind skips every run of the job until it expires. */
async function releaseLease(db: Db, job: JobName, runId: string) {
  const release = () => db.delete(jobLocks).where(and(eq(jobLocks.job, job), eq(jobLocks.runId, runId)));
  try {
    await release();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS));
    await release();
  }
}

/**
 * Why a run failed, for its record and the operator's alert. A failed query says which statement and the database's own
 * reason (Drizzle keeps that as the error's cause), never the statement's parameters, which can be long, an image's
 * 512 numbers, and can carry what an alert's log line must not, such as a sealed Fair Open's coin.
 */
export function failureMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : null;
  if (e instanceof DrizzleQueryError) return `Failed query: ${e.query}${cause ? `: ${cause}` : ""}`;
  return cause && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
}

/** A job that did part of its work before failing, so the run's record keeps what it did alongside why it failed. */
export class JobFailure extends Error {
  constructor(message: string, readonly summary: unknown) {
    super(message);
  }
}

export function toJobRun(r: typeof jobRuns.$inferSelect): JobRun {
  return {
    id: r.id,
    job: r.job as JobName,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    summary: r.summary ?? null,
    error: r.error,
  };
}

export * from "./alerts";
