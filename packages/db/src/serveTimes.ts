// `pnpm --filter @top-pad/db serve-times`: how each Fair Open's coin metadata went up and was served (spec 11.2), from
// what the keeper recorded in the database in DATABASE_URL: when the metadata was uploaded before the open, how long
// after its upload the gateway first served it, and whether that was before the open's rung landed.
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { createDb, launches, metadataItems } from "./index";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set: put the database's connection string in the project's .env.");
  process.exit(1);
}
const { db, close } = createDb(url);
try {
  const rows = await db
    .select({ launch: launches.fairOpen, opensAt: launches.opensAt, landedAt: launches.openLandedAt, uploadedAt: metadataItems.uploadedAt, servedAt: metadataItems.servedAt })
    .from(metadataItems)
    .innerJoin(launches, eq(launches.id, metadataItems.launchId))
    .where(and(eq(launches.mode, "fair_open"), eq(metadataItems.item, "metadata"), isNotNull(metadataItems.uploadedAt)))
    .orderBy(desc(launches.opensAt));
  const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  for (const r of rows) {
    const lead = r.opensAt ? r.opensAt.getTime() - r.uploadedAt!.getTime() : null;
    const uploaded = lead === null ? "uploaded" : lead >= 0 ? `uploaded ${s(lead)} before the open` : `uploaded ${s(-lead)} after the open`;
    const served = r.servedAt ? s(r.servedAt.getTime() - r.uploadedAt!.getTime()) : "not seen";
    // The open's block time has whole seconds, so a serve in the same second as the landing counts as before it.
    const first = r.servedAt && r.landedAt ? (Math.floor(r.servedAt.getTime() / 1000) <= r.landedAt.getTime() / 1000 ? "yes" : "NO") : "-";
    console.log(`${r.launch}  ${uploaded}, served ${served} after its upload, before the rung landed: ${first}`);
  }
  console.log(`${rows.length} Fair Opens with their metadata uploaded`);
} finally {
  await close();
}
