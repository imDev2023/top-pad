import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  admissionReviews,
  auditLog,
  bundleCases,
  createDb,
  creators,
  jobRuns,
  launches,
  launchReviews,
  linkageHubs,
  vampAppeals,
  vampChecks,
  vampClearances,
  walletClearances,
  type Db,
} from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { Bindings } from "./env";
import { auditKey, exportAudit, type AuditStore } from "./exportAudit";
import worker, { scheduled } from "./worker";

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
});
afterAll(async () => {
  await Promise.allSettled(pending);
  await closeDb();
  await drop();
});

/** R2 as the app uses it, in memory. */
class MemoryBucket {
  objects = new Map<string, { body: string; customMetadata: Record<string, string> }>();
  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { text: async () => o.body } : null;
  }
  async put(key: string, body: string | Uint8Array, opts?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, { body: typeof body === "string" ? body : new TextDecoder().decode(body), customMetadata: opts?.customMetadata ?? {} });
    return { key };
  }
  async list(opts: { prefix?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { objects: keys.map((key) => ({ key, size: this.objects.get(key)!.body.length, customMetadata: this.objects.get(key)!.customMetadata })) };
  }
}

const AUD = "heat-operator-test";
const ORIGIN = "https://operator.heat.test";
const pending: Promise<unknown>[] = [];
let bucket: MemoryBucket;
const env = (o: Partial<Bindings> = {}): Bindings =>
  ({ HYPERDRIVE: { connectionString: url } as Hyperdrive, BLOBS: bucket as unknown as R2Bucket, CLUSTER: "devnet", ACCESS_AUD: AUD, ...o }) as Bindings;

/** What the runtime hands a request Access signed in: this app's audience tag and the operator's identity. */
const signedIn = (email: string | undefined = "Operator@Heat.test", aud = AUD) => ({ aud, getIdentity: async () => (email ? { email } : {}) });
/** `null`: a request that did not come through Access at all. */
type Access = ReturnType<typeof signedIn> | null;
const ctx = (access: Access) =>
  ({ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, access: access ?? undefined }) as unknown as ExecutionContext;

const call = (path: string, init: RequestInit = {}, access: Access = signedIn(), bindings = env()) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), bindings, ctx(access));
const page = async (path: string, access: Access = signedIn()) => {
  const res = await call(path, {}, access);
  return { status: res.status, html: await res.text(), location: res.headers.get("location") };
};
const post = (path: string, fields: Record<string, string>, o: { origin?: string; access?: Access } = {}) =>
  call(path, { method: "POST", body: new URLSearchParams(fields), headers: { origin: o.origin ?? ORIGIN, "content-type": "application/x-www-form-urlencoded" } }, o.access ?? signedIn());

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const BONK = { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", ticker: "Bonk", name: "Bonk", source: "jupiter_verified", url: "https://jup.ag/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", imageUrl: null };
const SHA = "a".repeat(64);
const imageRefused = [{ field: "image", rule: "pdq", status: "refused", coin: BONK, reason: "The image is the picture of $Bonk, a protected coin, mirrored." }];
const wallet = (n: number) => `${n}`.padStart(4, "1") + "WaLLetAddressxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, `${n % 9 || 1}`).slice(0, 36);

let creatorSeq = 0;
async function creator(handle: string) {
  const [row] = await db.insert(creators).values({ xUserId: `${9000 + creatorSeq++}`, xHandle: handle, xName: handle }).returning();
  return row!;
}

/** A Fair Open with its launch row, sealed until `opened`. */
async function fairOpen(o: { creatorId: string; launch: string; ticker: string; teaser: string; opened: boolean }) {
  await db.insert(launches).values({
    creatorId: o.creatorId,
    wallet: wallet(1),
    mode: "fair_open",
    name: `${o.ticker} Coin`,
    ticker: o.ticker,
    mint: `${o.launch.slice(0, 30)}Mint`,
    pool: `${o.launch.slice(0, 30)}Pool`,
    config: "config",
    quoteMint: "So11111111111111111111111111111111111111112",
    metadataUri: "https://turbo-gateway.com/x",
    imageUri: "https://turbo-gateway.com/y",
    message: "",
    lastValidBlockHeight: 0n,
    fairOpen: o.launch,
    teaser: o.teaser,
    opensAt: hoursAgo(-2),
    openLandedAt: o.opened ? hoursAgo(1) : null,
  });
}

const trace = (w: string, root: string) => ({ wallet: w, root, chain: [{ wallet: w, funder: root, signature: "sig", amount: "120000000", at: hoursAgo(60).toISOString(), passThrough: false }], funders: [root] });

describe("Cloudflare Access", () => {
  it("refuses every request Access did not sign in for this app, showing nothing of the queue", async () => {
    const someone = await creator("hidden_creator");
    await db.insert(vampChecks).values({ stage: "prepare", creatorId: someone.id, ticker: "HIDDEN", name: "Hidden", outcome: "refused", matches: imageRefused });
    for (const [access, bindings] of [
      [null, env()],
      [signedIn("operator@heat.test", "another-app"), env()],
      [signedIn(""), env()],
      [signedIn(), env({ ACCESS_AUD: undefined })],
    ] as const) {
      const res = await call("/", {}, access, bindings);
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("Sign in through Cloudflare Access");
      expect(html).not.toContain("HIDDEN");
      expect(html).not.toContain("hidden_creator");
    }
    await db.delete(vampChecks);
  });

  it("serves no page from a cache and none in a frame", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'; form-action 'self'; frame-ancestors 'none'/);
  });
});

describe("the queue", () => {
  let launchCreator: Awaited<ReturnType<typeof creator>>;
  const launchAccount = "LaunchAccount1111111111111111111111111111111";
  beforeEach(async () => {
    for (const t of [vampClearances, vampAppeals, launchReviews, vampChecks, admissionReviews, walletClearances, linkageHubs, bundleCases, launches]) await db.delete(t);
    launchCreator = await creator(`relauncher${creatorSeq}`);
    await db.insert(vampChecks).values([
      { stage: "prepare", creatorId: launchCreator.id, ticker: "B0NK", name: "Frog Relaunch", imageSha256: SHA, outcome: "refused", matches: imageRefused, at: hoursAgo(30) },
      { stage: "prepare", creatorId: launchCreator.id, ticker: "B0NK", name: "Frog Relaunch", imageSha256: SHA, outcome: "refused", matches: imageRefused, at: hoursAgo(29) },
    ]);
    await db.insert(vampAppeals).values({
      creatorId: launchCreator.id,
      ticker: "B0NK",
      name: "Frog Relaunch",
      imageSha256: SHA,
      message: "We are Bonk's own team, relaunching.",
      verdict: { text: null, image: { matches: imageRefused, outcome: "refused" } },
      createdAt: hoursAgo(10),
    });
    await fairOpen({ creatorId: launchCreator.id, launch: launchAccount, ticker: "SEALEDX", teaser: "lantern", opened: false });
    await db.insert(admissionReviews).values({
      launch: launchAccount,
      wallet: wallet(2),
      kind: "merged",
      cluster: `wallet:${wallet(9)}`,
      reason: "Heat counts this wallet as one person with every wallet funded from it.",
      evidence: { wallet: trace(wallet(2), wallet(9)) },
      createdAt: hoursAgo(50),
    });
    await db.insert(bundleCases).values({
      mint: "CaseMint11111111111111111111111111111111111",
      creatorWallet: wallet(3),
      creatorId: launchCreator.id,
      linkedWallets: 4,
      linkedCoins: 158264351050603n,
      supply: 1000000000000000n,
      evidence: {
        rule: "Wallets directly linked to the Creator wallet bought 1% or more.",
        floor: { supply: "1000000000000000", floor: "10000000000000", linkedCoins: "158264351050603", share: "15.82%" },
        wallets: [{ wallet: wallet(4), labels: ["creator_funded"], counted: "90304748460142", deposits: [], buys: [], transfers: [{ signature: "tsig", at: hoursAgo(6).toISOString(), direction: "from_creator", asset: "SOL", amount: "420000000" }] }],
      },
      evidenceKey: "bundle-radar/cases/CaseMint11111111111111111111111111111111111.json",
      openedAt: hoursAgo(5),
    });
  });

  it("shows one list, oldest first, each item's age against the 48-hour aim, and nothing of a sealed coin", async () => {
    const { status, html } = await page("/");
    expect(status).toBe(200);
    const kinds = [...html.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["admission", "launch", "case"]);
    expect(html).toMatch(/data-testid="tally-over">1</);
    expect(html).toContain("past the 48 h aim");
    // The appeal's clock is the one that runs: 10 hours, not the first refusal's 30.
    expect(html).toMatch(/Appeal<\/span>[\s\S]*?\$B0NK · Frog Relaunch[\s\S]*?<b>10 h<\/b>/);
    expect(html).toContain("the Fair Open &quot;lantern&quot;");
    expect(html).not.toContain("SEALEDX");
  });

  it("clears a refused launch: its clearances, the appeal upheld and the audit row, all at once", async () => {
    const href = `/launch?creator=${launchCreator.id}&ticker=B0NK&name=Frog+Relaunch&image=${SHA}`;
    const shown = await page(href);
    expect(shown.html).toContain("We are Bonk&#39;s own team, relaunching.");
    // A decision with no reason is refused, and nothing is written.
    const noNote = await post(href, { decision: "cleared", note: " " });
    expect(noNote.status).toBe(409);
    expect(await db.select().from(launchReviews)).toEqual([]);

    const res = await post(href, { decision: "cleared", note: "Bonk's team, shown by the mint authority" });
    expect(res.status).toBe(303);
    const done = Number(new URL(res.headers.get("location")!, ORIGIN).searchParams.get("done"));
    const [review] = await db.select().from(launchReviews);
    expect(review).toMatchObject({ decision: "cleared", operator: "operator@heat.test", ticker: "B0NK", imageSha256: SHA });
    expect(await db.select({ field: vampClearances.field, value: vampClearances.value }).from(vampClearances)).toEqual([{ field: "image", value: SHA }]);
    expect(await db.select({ status: vampAppeals.status, by: vampAppeals.decidedBy, review: vampAppeals.reviewId }).from(vampAppeals)).toEqual([{ status: "upheld", by: "operator@heat.test", review: review!.id }]);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, done));
    expect(row).toMatchObject({ operator: "operator@heat.test", action: "launch_cleared", subject: `launch:${launchCreator.id}:B0NK` });
    expect(row!.detail).toMatchObject({ fields: ["image"], note: "Bonk's team, shown by the mint authority", refusing: [{ field: "image", coin: BONK.mint }] });
    const after = await page(`/?done=${done}`);
    expect(after.html).toContain(`row <span class="num">#${done}</span>`);
    expect(after.html).not.toContain("data-kind=\"launch\"");
    // The item is gone; a second decision on it finds nothing.
    expect((await post(href, { decision: "kept", note: "again" })).status).toBe(404);
  });

  it("keeps a refused launch refused, denying its appeal, and it comes back only with a new refusal", async () => {
    const href = `/launch?creator=${launchCreator.id}&ticker=B0NK&name=Frog+Relaunch&image=${SHA}`;
    expect((await post(href, { decision: "kept", note: "a copy of Bonk's picture" })).status).toBe(303);
    expect(await db.select({ status: vampAppeals.status }).from(vampAppeals)).toEqual([{ status: "denied" }]);
    expect(await db.select().from(vampClearances)).toEqual([]);
    expect((await page("/")).html).not.toContain('data-kind="launch"');
    await db.insert(vampChecks).values({ stage: "prepare", creatorId: launchCreator.id, ticker: "B0NK", name: "Frog Relaunch", imageSha256: SHA, outcome: "refused", matches: imageRefused });
    expect((await page("/")).html).toContain('data-kind="launch"');
  });

  it("clears a wallet for future Fair Opens, answering every open review of it", async () => {
    await db.insert(admissionReviews).values({ launch: "OtherLaunch111111111111111111111111111111111", wallet: wallet(2), kind: "refused", cluster: "x:1", reason: "The Creator wallet funded this wallet, directly.", evidence: { wallet: trace(wallet(2), wallet(8)) } });
    const res = await post(`/admissions/${launchAccount}/${wallet(2)}`, { decision: "cleared", note: "a friend's gift" });
    expect(res.status).toBe(303);
    expect(await db.select({ wallet: walletClearances.wallet, operator: walletClearances.operator }).from(walletClearances)).toEqual([{ wallet: wallet(2), operator: "operator@heat.test" }]);
    const reviews = await db.select().from(admissionReviews);
    expect(reviews.map((r) => [r.resolution, r.resolvedBy])).toEqual([
      ["cleared", "operator@heat.test"],
      ["cleared", "operator@heat.test"],
    ]);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "wallet_cleared"));
    expect(row).toMatchObject({ subject: `wallet:${wallet(2)}`, detail: { launch: launchAccount, kinds: ["merged"], note: "a friend's gift" } });
  });

  it("names a merged wallet's funding root a hub, answering every review traced to it", async () => {
    const path = `/admissions/${launchAccount}/${wallet(2)}`;
    expect((await page(path)).html).toContain(`Name ${wallet(9).slice(0, 4)}…${wallet(9).slice(-4)} a hub`);
    expect((await post(path, { decision: "hub", note: "an exchange", label: "" })).status).toBe(409);
    expect((await post(path, { decision: "hub", note: "an exchange's withdrawals", label: "Faucet drip 2" })).status).toBe(303);
    expect(await db.select({ address: linkageHubs.address, label: linkageHubs.label, by: linkageHubs.addedBy }).from(linkageHubs)).toEqual([{ address: wallet(9), label: "Faucet drip 2", by: "operator@heat.test" }]);
    expect((await db.select().from(admissionReviews))[0]).toMatchObject({ resolution: "hub" });
    expect((await db.select().from(auditLog).where(and(eq(auditLog.action, "hub_added"), eq(auditLog.subject, `wallet:${wallet(9)}`)))).length).toBe(1);
  });

  it("opens a case's evidence pack only after writing that it did, and says which copy it read", async () => {
    const mint = "CaseMint11111111111111111111111111111111111";
    const [stored] = await db.select().from(bundleCases);
    await bucket.put(stored!.evidenceKey, JSON.stringify(stored!.evidence, null, 2));
    // No audit row, no pack: the page goes back to the case and its button.
    expect(await page(`/cases/${mint}/evidence?opened=1`)).toMatchObject({ status: 303, location: `/cases/${mint}` });
    const res = await post(`/cases/${mint}/evidence`, {});
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    const opened = Number(new URL(location, ORIGIN).searchParams.get("opened"));
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, opened));
    expect(row).toMatchObject({ action: "evidence_opened", subject: `case:${mint}`, operator: "operator@heat.test" });
    const shown = await page(location);
    expect(shown.status).toBe(200);
    expect(shown.html).toContain("the same as the case&#39;s own copy in Postgres");
    expect(shown.html).toContain(wallet(4));
    expect(shown.html).toContain("0.42 SOL");
    // Another operator cannot read it through this one's row.
    expect((await page(location, signedIn("someone@else.test"))).status).toBe(303);
    // The case stays in the queue: confirming it comes with the Bars (#56).
    expect((await page("/")).html).toContain('data-kind="case"');
  });

  it("refuses a form posted from anywhere but the app's own pages", async () => {
    const res = await post(`/admissions/${launchAccount}/${wallet(2)}`, { decision: "cleared", note: "forged" }, { origin: "https://top-pad-web-devnet.imdev2023.workers.dev" });
    expect(res.status).toBe(403);
    expect(await db.select().from(walletClearances)).toEqual([]);
  });
});

describe("hubs", () => {
  it("names and removes a hub, each in the audit log", async () => {
    await db.delete(linkageHubs);
    expect((await post("/hubs", { address: "not an address", label: "x" })).status).toBe(409);
    expect((await post("/hubs", { address: wallet(7), label: "Bridge router" })).status).toBe(303);
    expect((await page("/hubs")).html).toContain("Bridge router");
    expect((await post(`/hubs/${wallet(7)}/remove`, { note: "not a hub after all" })).status).toBe(303);
    expect(await db.select().from(linkageHubs)).toEqual([]);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.subject, `wallet:${wallet(7)}`)).orderBy(auditLog.id)).map((r) => r.action);
    expect(actions).toEqual(["hub_added", "hub_removed"]);
  });
});

describe("the audit log", () => {
  it("is append-only: heat_operator may insert and read it, never update or delete it, and no role may", async () => {
    await db.insert(auditLog).values({ operator: "operator@heat.test", action: "hub_added", subject: "wallet:test", detail: {} });
    const asOperator = (statement: string) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role heat_operator`);
        return tx.execute(sql.raw(statement));
      });
    await asOperator("insert into audit_log (operator, action, subject, detail) values ('operator@heat.test', 'hub_added', 'wallet:test', '{}')");
    expect((await asOperator("select count(*)::int as n from audit_log where subject = 'wallet:test'"))[0]).toEqual({ n: 2 });
    await expect(asOperator("update audit_log set operator = 'someone else'")).rejects.toThrow();
    await expect(asOperator("delete from audit_log")).rejects.toThrow();
    for (const statement of ["update audit_log set operator = 'someone else'", "delete from audit_log", "truncate audit_log"]) {
      await expect(db.execute(sql.raw(statement))).rejects.toThrow();
    }
    // Nor does the role reach what is not the operator's: the creators' records, the launches.
    await expect(asOperator("update creators set x_handle = 'x'")).rejects.toThrow();
    await expect(asOperator("delete from launches")).rejects.toThrow();
  });

  it("exports each finished day to R2 once, an empty day included, and never today", async () => {
    const store = new MemoryBucket();
    const now = new Date("2026-11-09T00:15:00Z");
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    expect(before).toBeGreaterThan(0);
    // Rows on the 6th and the 8th, and one from today that must wait for tomorrow's run.
    await db.insert(auditLog).values([
      { operator: "a@heat.test", action: "launch_kept", subject: "launch:x", detail: { n: 1 }, at: new Date("2026-11-06T10:00:00Z") },
      { operator: "a@heat.test", action: "launch_kept", subject: "launch:y", detail: { n: 2 }, at: new Date("2026-11-08T23:59:59Z") },
      { operator: "a@heat.test", action: "launch_kept", subject: "launch:z", detail: { n: 3 }, at: new Date("2026-11-09T00:01:00Z") },
    ]);
    const first = await exportAudit(db, store as unknown as AuditStore, now);
    // From the first row's day to yesterday: the rows the other tests wrote today are today's, and wait too.
    const days = first.exported.map((e) => e.day);
    expect(days).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(first.exported.find((e) => e.day === "2026-11-07")).toEqual({ day: "2026-11-07", rows: 0 });
    const eighth = store.objects.get(auditKey("2026-11-08"))!;
    expect(eighth.body.trim().split("\n").map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ subject: "launch:y", at: "2026-11-08T23:59:59.000Z", detail: { n: 2 } })]);
    expect(eighth.customMetadata.rows).toBe("1");
    // A second run writes nothing again.
    expect(await exportAudit(db, store as unknown as AuditStore, now)).toMatchObject({ exported: [], alreadyThere: days.length });
  });

  it("runs the export from the daily Cron Trigger, kept in job_runs", async () => {
    bucket = new MemoryBucket();
    await scheduled({ scheduledTime: Date.now(), cron: "15 0 * * *", noRetry: () => {} } as ScheduledController, env(), ctx(null));
    const [run] = await db.select().from(jobRuns).where(eq(jobRuns.job, "audit-export"));
    expect(run).toMatchObject({ status: "succeeded" });
    expect([...bucket.objects.keys()].length).toBeGreaterThan(0);
  });

  it("shows the latest actions, the export's runs and the days in R2", async () => {
    const res = await post("/audit/export", {});
    expect(res.status).toBe(303);
    const { html } = await page("/audit");
    expect(html).toContain("Exported the audit log");
    expect(html).toContain("operator-audit/");
    expect(html).toContain("succeeded");
  });
});

beforeEach(() => {
  bucket = new MemoryBucket();
});
