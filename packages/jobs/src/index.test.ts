import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, jobLocks, operatorAlerts, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { JobFailure, runJob } from "./index";

let db: Db;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());

const alert = async () => (await db.select().from(operatorAlerts))[0];

describe("the job runner", () => {
  it("records a run that succeeds with what it reports doing", async () => {
    const run = await runJob(db, "indexer-reconcile", async () => ({ indexed: 3 }));
    expect(run).toMatchObject({ job: "indexer-reconcile", status: "succeeded", summary: { indexed: 3 }, error: null });
    expect(run.finishedAt).not.toBeNull();
  });

  it("records a failure with what was done, raises one alert, and resolves it when the job next succeeds", async () => {
    const failing = () => runJob(db, "indexer-reconcile", async () => { throw new JobFailure("RPC timed out", { indexed: 1 }); });
    await expect(failing()).rejects.toThrow("RPC timed out");
    await expect(failing()).rejects.toThrow("RPC timed out");
    expect(await db.select().from(operatorAlerts)).toHaveLength(1);
    expect(await alert()).toMatchObject({ kind: "job_failed", subject: "indexer-reconcile", resolvedAt: null });

    await runJob(db, "indexer-reconcile", async () => null);
    expect((await alert())?.resolvedAt).not.toBeNull();
  });

  it("skips an exclusive run while another run holds the job's lease, and releases its own lease when done", async () => {
    await db.insert(jobLocks).values({ job: "indexer-reconcile", runId: "another-run", expiresAt: new Date(Date.now() + 60_000) });
    let ran = false;
    const skipped = await runJob(db, "indexer-reconcile", async () => { ran = true; }, { exclusive: true });
    expect(skipped.status).toBe("skipped");
    expect(ran).toBe(false);

    await db.delete(jobLocks);
    const done = await runJob(db, "indexer-reconcile", async () => "ok", { exclusive: true });
    expect(done.status).toBe("succeeded");
    expect(await db.select().from(jobLocks)).toHaveLength(0);
  });
});
