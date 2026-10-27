// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: apps/api/src/jobs.ts, with this repo's package names.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { JobName, JobRun } from "@top-pad/contract";
import { jobLocks, jobRuns, operatorAlerts, type Db } from "@top-pad/db";

/** A Cron Trigger runs for at most 15 minutes, so a lease that long outlives any run whose Worker is still alive. */
const LEASE_SECONDS = 15 * 60;

/**
 * Runs one scheduled job and keeps a record of the run for the operator: when it started and ended, what it reports
 * doing, and why it failed. With `exclusive`, the run first takes the job's lease and is skipped if another run holds it,
 * so a Cron Trigger and a manual run never act at the same time. A failure is recorded and then thrown again.
 */
export async function runJob<T>(db: Db, job: JobName, work: () => Promise<T>, opts: { exclusive?: boolean } = {}): Promise<JobRun> {
  const id = crypto.randomUUID();
  if (opts.exclusive) {
    const [lease] = await db
      .insert(jobLocks)
      .values({ job, runId: id, expiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
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
  await db.insert(jobRuns).values({ id, job, status: "running" });
  try {
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
    const message = (e as Error).message;
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
    if (opts.exclusive) await db.delete(jobLocks).where(and(eq(jobLocks.job, job), eq(jobLocks.runId, id)));
  }
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
