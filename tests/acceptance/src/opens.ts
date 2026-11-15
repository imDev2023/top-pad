// Every Fair Open the deployed keeper opened during the acceptance run (spec 11.2, 16), read from what the keeper recorded
// in the devnet database (DATABASE_URL): how long before its open the coin's metadata went up through Turbo, how long
// after its upload the gateway first served it, whether that was before the open's rung landed, how late the open landed
// by the chain's clock, and how soon after it every seat had its coins. It passes when every open the keeper sent had its
// metadata served within 10 s of the upload and before the rung, landed within 2 s of its time when its ladder was signed
// at scheduling (past which the open would move to a Durable Object alarm, spec 10.2; a rung signed at the open waits on
// the creator) and delivered every seat within 2 minutes. Writes `opens.json` and
// `opens.md` into ACCEPTANCE_RUN_DIR when set.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import { createDb, launches, metadataItems } from "@top-pad/db";

const url = process.env.DATABASE_URL;
const since = new Date(process.env.ACCEPTANCE_STARTED_AT ?? process.argv[2] ?? "");
if (!url || Number.isNaN(since.getTime())) throw new Error("needs DATABASE_URL and ACCEPTANCE_STARTED_AT (or an ISO time as its argument)");

const { db, close } = createDb(url);
try {
  const rows = await db
    .select({
      launch: launches.fairOpen,
      ladder: launches.ladder,
      opensAt: launches.opensAt,
      sentAt: launches.openSentAt,
      landedAt: launches.openLandedAt,
      deliveredAt: launches.deliveredAt,
      uploadedAt: metadataItems.uploadedAt,
      servedAt: metadataItems.servedAt,
    })
    .from(launches)
    .leftJoin(metadataItems, and(eq(metadataItems.launchId, launches.id), eq(metadataItems.item, "metadata")))
    .where(and(eq(launches.mode, "fair_open"), gte(launches.opensAt, since), isNotNull(launches.openSignature)))
    .orderBy(asc(launches.opensAt));
  const s = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(2)} s`);
  const ms = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null);
  const opens = rows.map((r) => {
    const served = ms(r.uploadedAt, r.servedAt);
    // The rung's block time has whole seconds, so a serve in the same second as the landing counts as before it.
    const beforeRung = r.servedAt && r.landedAt ? Math.floor(r.servedAt.getTime() / 1000) <= r.landedAt.getTime() / 1000 : false;
    const late = ms(r.opensAt, r.landedAt);
    const delivered = ms(r.landedAt, r.deliveredAt);
    // A rung signed at the open waits on the creator's click (ADR 0005), so only a signed ladder's open is held to 2 s.
    const onTime = late !== null && (r.ladder === "at_open" || late <= 2_000);
    const ok = served !== null && served <= 10_000 && beforeRung && onTime && delivered !== null && delivered <= 120_000;
    return { ...r, uploadLead: ms(r.uploadedAt, r.opensAt), served, beforeRung, late, delivered, ok };
  });
  const table = [
    "| Launch | Ladder | Uploaded before the open | Served after the upload | Before the rung | Landed after its time | Every seat delivered after the open |",
    "| - | - | -: | -: | - | -: | -: |",
    ...opens.map((o) => `| \`${o.launch}\` | ${o.ladder ?? "-"} | ${s(o.uploadLead)} | ${s(o.served)} | ${o.beforeRung ? "yes" : "NO"} | ${s(o.late)} | ${s(o.delivered)} |`),
  ].join("\n");
  console.log(`${opens.length} Fair Opens the keeper opened since ${since.toISOString()}`);
  console.log(table);
  const dir = process.env.ACCEPTANCE_RUN_DIR;
  if (dir) {
    writeFileSync(join(dir, "opens.json"), JSON.stringify(opens, null, 2));
    writeFileSync(join(dir, "opens.md"), `${table}\n`);
  }
  const failed = opens.filter((o) => !o.ok);
  if (!opens.length || failed.length) {
    console.log(opens.length ? `failed: ${failed.map((o) => o.launch).join(", ")}` : "no open to measure: the keeper opened nothing during the run");
    process.exitCode = 1;
  }
} finally {
  await close();
}
