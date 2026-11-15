// `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui picture-check [count]` (#107): draws `count` pictures (300
// by default) exactly as the UI specs draw them (`pictureScript` in a headless Chromium page), signs each with the
// vision service (VISION_URL, default http://127.0.0.1:18080: `docker run --rm -p 127.0.0.1:18080:8080 <the vision
// image>`, built by `docker build --platform linux/amd64 -t heat-vision:dev apps/vision`), and measures what Vamp Shield
// would: each picture's nearest protected image by SSCD in the database DATABASE_URL names (the devnet one), and every
// pair of drawn pictures against each other, by SSCD and by PDQ over the eight orientations. Vamp Shield labels at SSCD
// 0.60 and refuses at PDQ distance 31 or under (packages/vamp-shield/src/images.ts), so it passes when no picture
// reaches SSCD 0.40 against the protected set, no two reach 0.60 against each other (drawn pictures join the set as
// their Fair Opens open; SSCD rates two random pictures of one recipe about 0.39 apart, so the label itself is the bar)
// and none comes within PDQ 31 of another. Reads only.
import { chromium } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createDb } from "@top-pad/db";
import { pictureScript } from "./picture";

const count = Number(process.argv[2] ?? 300);
const visionUrl = process.env.VISION_URL ?? "http://127.0.0.1:18080";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Run through direnv exec, so DATABASE_URL names the database with the protected set.");
/** The most SSCD similarity a drawn picture may reach against the protected set: well under Vamp Shield's 0.60 label. */
const SSCD_LIMIT = 0.4;
/** Vamp Shield's label, which no two drawn pictures may reach against each other. */
const SSCD_NEAR = 0.6;
const PDQ_MATCH_DISTANCE = 31;

type Signed = { seed: string; sscd: number[]; pdq: string[] };

const browser = await chromium.launch();
const page = await browser.newPage();
const { db, close } = createDb(databaseUrl);
try {
  const signed: Signed[] = [];
  for (let i = 0; i < count; i++) {
    // Seeds as the specs make them: a ticker drawn for the run.
    const seed = `E2E${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const png = Buffer.from((await page.evaluate(pictureScript(seed))) as string, "base64");
    const answer = await fetch(`${visionUrl}/signatures`, { method: "POST", body: png, headers: { "content-type": "image/png" } });
    if (!answer.ok) throw new Error(`the vision service answered ${answer.status}: ${await answer.text()}`);
    // PDQ's eight orientations, the original first, each 256 bits written as 0s and 1s.
    const { sscd, pdq } = (await answer.json()) as { sscd: number[]; pdq: { dihedral: string[] } };
    signed.push({ seed, sscd, pdq: pdq.dihedral });
  }

  // Against the protected set, as `vampShield.ts` asks it.
  const nearest: { seed: string; url: string; similarity: number }[] = [];
  for (const s of signed) {
    const vector = `[${s.sscd.join(",")}]`;
    const rows = (await db.execute(
      sql`select url, 1 - (sscd <=> ${vector}::vector) as similarity from protected_images where sscd is not null and status = 'done' order by sscd <=> ${vector}::vector limit 1`,
    )) as unknown as { url: string; similarity: number }[];
    if (rows[0]) nearest.push({ seed: s.seed, url: rows[0].url, similarity: Number(rows[0].similarity) });
  }
  nearest.sort((a, b) => b.similarity - a.similarity);

  // Against each other: every pair, SSCD by cosine (the embeddings are unit vectors) and PDQ by Hamming distance.
  const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0) / Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0));
  const hamming = (a: string, b: string) => [...a].filter((bit, i) => bit !== b[i]).length;
  let worstSscd = { a: "", b: "", similarity: -1 };
  let worstPdq = { a: "", b: "", distance: 257 };
  for (let i = 0; i < signed.length; i++) {
    for (let j = i + 1; j < signed.length; j++) {
      const [a, b] = [signed[i]!, signed[j]!];
      const similarity = cosine(a.sscd, b.sscd);
      if (similarity > worstSscd.similarity) worstSscd = { a: a.seed, b: b.seed, similarity };
      const distance = Math.min(...a.pdq.map((p) => hamming(p, b.pdq[0]!)));
      if (distance < worstPdq.distance) worstPdq = { a: a.seed, b: b.seed, distance };
    }
  }

  const share = (limit: number) => nearest.filter((n) => n.similarity >= limit).length;
  console.log(`${signed.length} pictures drawn and signed`);
  console.log(`against the protected set: the nearest at SSCD ${nearest[0]?.similarity.toFixed(3)} (${nearest[0]?.seed} near ${nearest[0]?.url}); median ${nearest[Math.floor(nearest.length / 2)]?.similarity.toFixed(3)}`);
  console.log(`  at or over 0.40: ${share(0.4)}; at or over 0.60 (labelled): ${share(0.6)}`);
  console.log(`against each other: the closest pair at SSCD ${worstSscd.similarity.toFixed(3)} (${worstSscd.a}, ${worstSscd.b}); at PDQ distance ${worstPdq.distance} (${worstPdq.a}, ${worstPdq.b})`);
  const passed = share(SSCD_LIMIT) === 0 && worstSscd.similarity < SSCD_NEAR && worstPdq.distance > PDQ_MATCH_DISTANCE;
  console.log(passed ? "PASS" : "FAIL");
  process.exitCode = passed ? 0 : 1;
} finally {
  await close();
  await browser.close();
}
