// Rebuilds every coin's candles from its trades and compares them with the candles the indexer wrote, at each length
// (spec 10.2: any candle can be rebuilt from trades). Fine candles past their retention are left out, as the trades
// outlive them. `DATABASE_URL=... pnpm --filter @top-pad/indexer check-candles`; it exits 1 on any difference.
import { sql } from "drizzle-orm";
import { createDb } from "@top-pad/db";
import { CANDLE_RETENTION_DAYS, CANDLE_SECONDS, rebuildCandles, writtenCandles } from "../src/candles";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to the database to check.");
const { db, close } = createDb(url);
try {
  const mints = (await db.execute<{ mint: string }>(sql`select distinct mint from trades order by mint`)).map((r) => r.mint);
  let compared = 0;
  const differences: string[] = [];
  for (const mint of mints) {
    for (const seconds of CANDLE_SECONDS) {
      const days = CANDLE_RETENTION_DAYS[seconds];
      const kept = (c: { startsAt: Date }) => days === undefined || c.startsAt.getTime() >= Date.now() - days * 86_400_000;
      const written = (await writtenCandles(db, mint, seconds)).filter(kept);
      const rebuilt = (await rebuildCandles(db, mint, seconds)).filter(kept);
      compared += written.length;
      if (JSON.stringify(written) !== JSON.stringify(rebuilt)) differences.push(`${mint} at ${seconds} s: ${written.length} written, ${rebuilt.length} rebuilt`);
    }
  }
  console.log(`${mints.length} coins, ${compared} candles compared at ${CANDLE_SECONDS.length} lengths: ${differences.length ? "DIFFERENT" : "all equal"}`);
  for (const d of differences) console.log(`  ${d}`);
  process.exitCode = differences.length ? 1 : 0;
} finally {
  await close();
}
