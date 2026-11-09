// The operator app (spec 6.6, 10.2): its own Worker behind Cloudflare Access, never a route of the public site or the
// API. One queue of refused launches with their appeals, refused or merged admissions and bundling cases; each action
// written to the audit log in the transaction that takes it; the log exported to R2 a day at a time.
import { desc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Child } from "hono/jsx";
import { csrf } from "hono/csrf";
import { auditLog, createDb, jobRuns, linkageHubs } from "@top-pad/db";
import { runJob } from "@top-pad/jobs";
import { operatorOf } from "./access";
import { addHub, decideAdmission, decideLaunch, openedRecently, openEvidence, audit, Refused, removeHub } from "./actions";
import { asOperator } from "./db";
import type { AppEnv, Bindings } from "./env";
import { exportAudit } from "./exportAudit";
import { admissionItem, caseByMint, launchItem, queue, type CaseItem, type LaunchKey } from "./queue";
import { AdmissionPage, AuditPage, CasePage, Denied, EvidencePage, Flash, HubsPage, ICON, LaunchPage, Missing, QueuePage, THEME_COOKIE, type Shell } from "./views";

export const app = new Hono<AppEnv>();

const nonceOf = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

// Every answer: a fresh script nonce, nothing cached, nothing framed, nothing sent onward in a Referer.
app.use("*", async (c, next) => {
  const nonce = nonceOf();
  c.set("nonce", nonce);
  await next();
  c.header(
    "content-security-policy",
    `default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
});

app.get("/icon.svg", (c) => c.body(ICON, 200, { "content-type": "image/svg+xml" }));

const shell = (c: Context<AppEnv>, current?: Shell["current"]): Shell => {
  const theme = getCookie(c, THEME_COOKIE);
  return {
    nonce: c.var.nonce,
    operator: c.var.operator ?? null,
    cluster: c.env.CLUSTER,
    theme: theme === "light" || theme === "dark" ? theme : null,
    current,
  };
};

// Cloudflare Access signs the operator in before the Worker runs; anything it did not sign in for this app is refused.
app.use("*", async (c, next) => {
  // Hono types the context as its own interface; the Workers runtime's carries `access`.
  const operator = await operatorOf((c.executionCtx as ExecutionContext).access, c.env.ACCESS_AUD);
  if (!operator) return c.html(<Denied {...shell(c)} />, 403);
  c.set("operator", operator);
  await next();
});

// A form post must come from the app's own pages: Access's cookie rides along on any request to this host.
app.use("*", csrf());

app.use("*", async (c, next) => {
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
  c.set("db", db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** What the last action did, read back from its audit row, for the page it lands on. */
async function flashOf(c: Context<AppEnv>) {
  const done = Number(c.req.query("done"));
  if (!Number.isSafeInteger(done) || done <= 0) return null;
  const [row] = await asOperator(c.var.db, (tx) => tx.select().from(auditLog).where(eq(auditLog.id, done)));
  if (!row || row.operator !== c.var.operator.email) return null;
  return (
    <Flash tone="go">
      Done, and written to the audit log as row <span class="num">#{row.id}</span>.
    </Flash>
  );
}

const form = async (c: Context<AppEnv>) => (await c.req.parseBody()) as Record<string, string | File>;
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

app.get("/", async (c) => {
  const items = await asOperator(c.var.db, queue);
  return c.html(<QueuePage {...shell(c, "queue")} items={items} now={new Date()} flash={await flashOf(c)} />);
});

const launchKeyOf = (c: Context<AppEnv>): LaunchKey | null => {
  const [creatorId, ticker, name] = [c.req.query("creator"), c.req.query("ticker"), c.req.query("name")];
  if (!creatorId || !/^[0-9a-f-]{36}$/.test(creatorId) || !ticker || !name) return null;
  return { creatorId, ticker, name, imageSha256: c.req.query("image") || null };
};

async function launchPage(c: Context<AppEnv>, error: string | null = null, status: 200 | 400 | 409 = 200) {
  const key = launchKeyOf(c);
  const item = key && (await asOperator(c.var.db, (tx) => launchItem(tx, key)));
  if (!item) return c.html(<Missing {...shell(c, "queue")} what="This refused launch is not waiting on an operator: it was decided, or never refused." />, 404);
  return c.html(<LaunchPage {...shell(c, "queue")} item={item} now={new Date()} error={error} />, status);
}

app.get("/launch", (c) => launchPage(c));
app.post("/launch", async (c) => {
  const key = launchKeyOf(c);
  if (!key) return launchPage(c);
  const body = await form(c);
  const decision = text(body.decision);
  if (decision !== "cleared" && decision !== "kept") return launchPage(c, "Choose to clear the launch or keep it refused.", 400);
  try {
    const done = await decideLaunch(c.var.db, c.var.operator, key, decision, body.note);
    return c.redirect(`/?done=${done.auditId}`, 303);
  } catch (e) {
    if (e instanceof Refused) return launchPage(c, e.message, 409);
    throw e;
  }
});

async function admissionPage(c: Context<AppEnv>, error: string | null = null, status: 200 | 400 | 409 = 200) {
  const item = await asOperator(c.var.db, (tx) => admissionItem(tx, c.req.param("launch")!, c.req.param("wallet")!));
  if (!item) return c.html(<Missing {...shell(c, "queue")} what="This admission is not waiting on an operator: it was dealt with, or never refused or merged." />, 404);
  return c.html(<AdmissionPage {...shell(c, "queue")} item={item} now={new Date()} error={error} />, status);
}

app.get("/admissions/:launch/:wallet", (c) => admissionPage(c));
app.post("/admissions/:launch/:wallet", async (c) => {
  const body = await form(c);
  const decision = text(body.decision);
  if (decision !== "cleared" && decision !== "hub" && decision !== "kept") return admissionPage(c, "Choose what to do with this admission.", 400);
  try {
    const done = await decideAdmission(c.var.db, c.var.operator, c.req.param("launch"), c.req.param("wallet"), decision, body.note, body.label);
    return c.redirect(`/?done=${done.auditId}`, 303);
  } catch (e) {
    if (e instanceof Refused) return admissionPage(c, e.message, 409);
    throw e;
  }
});

/** A case as the pages show it, with the coin's quote for the amounts. */
async function caseOf(c: Context<AppEnv>) {
  const mint = c.req.param("mint")!;
  const row = await asOperator(c.var.db, (tx) => caseByMint(tx, mint));
  if (!row) return null;
  const item: CaseItem = {
    kind: "case",
    id: row.c.id,
    mint: row.c.mint,
    since: row.c.openedAt,
    creatorWallet: row.c.creatorWallet,
    handle: row.handle,
    linkedWallets: row.c.linkedWallets,
    share: (row.c.evidence as { floor?: { share?: string } } | null)?.floor?.share ?? null,
    coin: row.ticker && row.name ? { ticker: row.ticker, name: row.name } : null,
    evidenceKey: row.c.evidenceKey,
  };
  return { item, evidence: row.c.evidence, quoteMint: row.quoteMint };
}

const missingCase = (c: Context<AppEnv>) => c.html(<Missing {...shell(c, "queue")} what="Bundle Radar opened no case for this coin." />, 404);

app.get("/cases/:mint", async (c) => {
  const found = await caseOf(c);
  if (!found) return missingCase(c);
  return c.html(<CasePage {...shell(c, "queue")} item={found.item} quoteMint={found.quoteMint} now={new Date()} error={null} />);
});
app.post("/cases/:mint/evidence", async (c) => {
  const found = await caseOf(c);
  if (!found) return missingCase(c);
  const { auditId } = await openEvidence(c.var.db, c.var.operator, found.item.mint);
  return c.redirect(`/cases/${found.item.mint}/evidence?opened=${auditId}`, 303);
});

/** Key order aside, whether two stored packs say the same: Postgres's jsonb keeps keys in its own order. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

app.get("/cases/:mint/evidence", async (c) => {
  const found = await caseOf(c);
  if (!found) return missingCase(c);
  // Every look at the pack follows its own audit row: a page opened another way goes back to the case's button.
  const opened = Number(c.req.query("opened"));
  if (!Number.isSafeInteger(opened) || !(await openedRecently(c.var.db, c.var.operator, found.item.mint, opened))) return c.redirect(`/cases/${found.item.mint}`, 303);
  const object = await c.env.BLOBS.get(found.item.evidenceKey);
  const stored = object ? (JSON.parse(await object.text()) as unknown) : null;
  const pack = (stored ?? found.evidence) as Parameters<typeof EvidencePage>[0]["pack"];
  return c.html(
    <EvidencePage {...shell(c, "queue")} item={found.item} quoteMint={found.quoteMint} now={new Date()} pack={pack} source={stored ? "r2" : "postgres"} matches={stored !== null && canonical(stored) === canonical(found.evidence)} />,
  );
});

async function hubsPage(c: Context<AppEnv>, flash: Child = null, status: 200 | 400 | 409 = 200) {
  const hubs = await asOperator(c.var.db, (tx) => tx.select().from(linkageHubs).orderBy(desc(linkageHubs.createdAt)));
  return c.html(<HubsPage {...shell(c, "hubs")} hubs={hubs} flash={flash ?? (await flashOf(c))} />, status);
}

app.get("/hubs", (c) => hubsPage(c));
app.post("/hubs", async (c) => {
  const body = await form(c);
  try {
    const { auditId } = await addHub(c.var.db, c.var.operator, body.address, body.label);
    return c.redirect(`/hubs?done=${auditId}`, 303);
  } catch (e) {
    if (e instanceof Refused) return hubsPage(c, <Flash tone="stop">{e.message}</Flash>, 409);
    throw e;
  }
});
app.post("/hubs/:address/remove", async (c) => {
  const body = await form(c);
  try {
    const { auditId } = await removeHub(c.var.db, c.var.operator, c.req.param("address"), body.note);
    return c.redirect(`/hubs?done=${auditId}`, 303);
  } catch (e) {
    if (e instanceof Refused) return hubsPage(c, <Flash tone="stop">{e.message}</Flash>, 409);
    throw e;
  }
});

app.get("/audit", async (c) => {
  const { db } = c.var;
  const [rows, runs] = await asOperator(db, async (tx) => [
    await tx.select().from(auditLog).orderBy(desc(auditLog.id)).limit(100),
    await tx.select().from(jobRuns).where(eq(jobRuns.job, "audit-export")).orderBy(desc(jobRuns.startedAt)).limit(5),
  ] as const);
  const listed = await c.env.BLOBS.list({ prefix: "operator-audit/", include: ["customMetadata"] });
  const files = listed.objects
    .slice(-10)
    .reverse()
    .map((o) => ({ key: o.key, size: o.size, rows: o.customMetadata?.rows ?? null }));
  return c.html(<AuditPage {...shell(c, "audit")} rows={rows} runs={runs} files={files} flash={await flashOf(c)} />);
});
app.post("/audit/export", async (c) => {
  const { db, operator } = c.var;
  const run = await runJob(db, "audit-export", () => exportAudit(db, c.env.BLOBS), { exclusive: true });
  const auditId = await asOperator(db, (tx) => audit(tx, operator, "audit_exported", `job:${run.id}`, { status: run.status, summary: run.summary }));
  return c.redirect(`/audit?done=${auditId}`, 303);
});

app.notFound((c) => c.html(<Missing {...shell(c)} heading="No page here" what="The operator app has no page at this address." />, 404));

/** The daily export (00:15 UTC): every whole day not yet in R2, recorded in `job_runs` as `audit-export`. */
export async function scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await runJob(db, "audit-export", () => exportAudit(db, env.BLOBS, new Date(controller.scheduledTime)), { exclusive: true });
  } finally {
    ctx.waitUntil(close());
  }
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>;
