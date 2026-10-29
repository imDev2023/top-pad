import { createSolanaRpc, isSolanaError } from "@solana/kit";
import { and, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { Health, type Platform } from "@top-pad/contract";
import { createDb, launches, probe, sessions, xAuthorizations, type Db } from "@top-pad/db";
import { notifyPending, runJob } from "@top-pad/jobs";
import { finishXLink, logout, me, startXLink } from "./auth";
import { config, instantLaunchSetup, type Bindings } from "./env";
import { sameOriginWrites, withConfig, withDb, type AppEnv } from "./http";
import { checkKeeperFloat } from "./keeper";
import { getLaunch, prepareLaunch, submitLaunch } from "./launches";
import { IMAGE_TYPES } from "./metadata";
import { checkRoute } from "./vampShield";

export const app = new Hono<AppEnv>();

app.use("*", withConfig);
// Credentialed: the session cookie rides along from the web app's origins, and from no other.
app.use("*", async (c, next) => cors({ origin: c.var.cfg.webOrigins, allowMethods: ["GET", "POST", "DELETE"], credentials: true })(c, next));
app.use("*", sameOriginWrites);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  // The Solana RPC refusing or stalling (each call is time-limited): nothing was sent, and the request can be retried.
  if (isSolanaError(err) || err.name === "TimeoutError" || err.name === "AbortError") {
    console.error("the Solana RPC failed", err);
    return c.json({ error: "The Solana network did not answer in time. Try again in a moment." }, 503);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Healthy only when the configuration is valid and the database answers through Hyperdrive, so a deploy with a wrong
// binding or unapplied migrations never looks ready. Answers 503 with the reason when it is not.
app.get("/health", async (c) => {
  const { cluster } = c.var.cfg;
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
  const started = performance.now();
  let database: Health["database"];
  try {
    const { serverTime, migrations } = await probe(db);
    database = { ok: true, latencyMs: Math.round(performance.now() - started), migrations, serverTime: serverTime.toISOString(), error: null };
  } catch (e) {
    console.error("health query failed", e);
    // The detail stays in the Worker's logs: it can name the database's host.
    database = { ok: false, latencyMs: null, migrations: null, serverTime: null, error: "the database did not answer" };
  } finally {
    c.executionCtx.waitUntil(close());
  }
  const health = Health.parse({ ok: database.ok, cluster, database });
  return c.json(health, health.ok ? 200 : 503);
});

app.get("/platform", (c) => {
  const { cfg } = c.var;
  const platform: Platform = {
    cluster: cfg.cluster,
    xLinking: cfg.x !== null,
    launchModes: { instant: cfg.x !== null && instantLaunchSetup(cfg, c.env).ok, fairOpen: false },
    maxImageBytes: cfg.maxImageBytes,
    imageTypes: [...IMAGE_TYPES],
  };
  return c.json(platform);
});

for (const path of ["/auth/*", "/me", "/launches", "/launches/*", "/vamp-shield/*"]) app.use(path, withDb);
app.get("/auth/x/start", startXLink);
app.get("/auth/x/callback", finishXLink);
app.post("/auth/logout", logout);
app.get("/me", me);
app.post("/vamp-shield/check", checkRoute);
app.post("/launches", prepareLaunch);
app.post("/launches/:id/submit", submitLaunch);
app.get("/launches/:id", getLaunch);

/** Expired sign-in state, and launches prepared so long ago that their blockhash can no longer land. */
async function housekeeping(db: Db) {
  const authorizations = await db.delete(xAuthorizations).where(lt(xAuthorizations.expiresAt, sql`now()`)).returning({ state: xAuthorizations.state });
  const expiredSessions = await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`)).returning({ tokenHash: sessions.tokenHash });
  const stale = await db
    .update(launches)
    .set({ status: "expired" })
    .where(and(eq(launches.status, "prepared"), lt(launches.createdAt, sql`now() - interval '15 minutes'`)))
    .returning({ id: launches.id });
  return { authorizations: authorizations.length, sessions: expiredSessions.length, expiredLaunches: stale.length };
}

/** The Cron Trigger: the keeper's float, housekeeping, then every open alert to the operator. */
async function scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  const cfg = config(env);
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const keeper = cfg.heat?.keys?.keeper;
    // A failed run is recorded and raises its own alert, so one job failing never keeps the others from running.
    if (keeper) {
      await runJob(db, "keeper-balance", () => checkKeeperFloat(db, createSolanaRpc(cfg.rpcUrl), keeper, cfg.keeperFloatMinLamports), { exclusive: true }).catch(() => undefined);
    }
    await runJob(db, "housekeeping", () => housekeeping(db), { exclusive: true }).catch(() => undefined);
    await notifyPending(db, cfg.alertWebhookUrl);
  } finally {
    ctx.waitUntil(close());
  }
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>;
