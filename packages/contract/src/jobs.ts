import { z } from "zod";

/** The scheduled jobs the runner records; each ticket that builds a job adds its name here. */
export const JobName = z.enum(["indexer-reconcile", "keeper-balance", "housekeeping"]);
export type JobName = z.infer<typeof JobName>;

export const JobRun = z.object({
  id: z.string(),
  job: JobName,
  /** `skipped` when another run of the same job held its lease. */
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** What the run did, in the job's own terms. */
  summary: z.unknown().nullable(),
  error: z.string().nullable(),
});
export type JobRun = z.infer<typeof JobRun>;
