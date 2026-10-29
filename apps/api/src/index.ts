import { createSolanaRpc, isSolanaError } from "@solana/kit";
import { and, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { Health, type LaunchRefusal, type Platform } from "@top-pad/contract";
import { createDb, launches, probe, sessions, xAuthorizations, type Db } from "@top-pad/db";
import { pruneCandles } from "@top-pad/indexer";
import { notifyPending, runJob } from "@top-pad/jobs";
import { finishXLink, logout, me, startXLink } from "./auth";
import { getCoin, getCoinCandles, getCoinTrades } from "./coins";
import { getEarnings, prepareClaim, reportClaim } from "./earnings";
import { indexerOf } from "./indexing";
import { config, instantLaunchSetup, type Bindings } from "./env";
import { sameOriginWrites, withConfig, withDb, type AppEnv } from "./http";
import { checkKeeperFloat } from "./keeper";
import { getLaunch, prepareLaunch, submitLaunch } from "./launches";
import { IMAGE_TYPES } from "./metadata";
import { checkRoute } from "./vampShield";
import { sweepWindowClaims } from "./windowClaims";

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

// Bodies are read whole, so their size is capped before anything reads them; only a launch's form carries an image.
app.post("*", async (c, next) => {
  const { maxImageBytes } = c.var.cfg;
  if (c.req.path !== "/launches") return bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "The request is too large." }, 413) })(c, next);
  const refusal: LaunchRefusal = { error: `The image is too large: a coin's image can be at most ${Math.round(maxImageBytes / 1024)} KB.`, code: "image" };
  return bodyLimit({ maxSize: maxImageBytes + 16 * 1024, onError: (c) => c.json(refusal, 413) })(c, next);
});
for (const path of ["/auth/*", "/me", "/launches", "/launches/*", "/vamp-shield/*", "/coins/*", "/earnings/*"]) app.use(path, withDb);
app.get("/auth/x/start", startXLink);
app.get("/auth/x/callback", finishXLink);
app.post("/auth/logout", logout);
app.get("/me", me);
app.post("/vamp-shield/check", checkRoute);
app.post("/launches", prepareLaunch);
app.post("/launches/:id/submit", submitLaunch);
app.get("/launches/:id", getLaunch);
app.get("/coins/:mint", getCoin);
app.get("/coins/:mint/trades", getCoinTrades);
app.get("/coins/:mint/candles", getCoinCandles);
app.get("/earnings/:wallet", getEarnings);
app.post("/earnings/claims", reportClaim);
app.post("/earnings/:wallet/claim", prepareClaim);

/**
 * `GET /indexer`: how the indexer stands; asking also starts it if it is not running, as the cron does, and moves it to
 * this Worker's version if it still runs an older one: it resets itself, and the second ask reaches it restarted.
 */
app.get("/indexer", async (c) => {
  const indexer = indexerOf(c.env);
  if (!indexer) return c.json({ error: "The indexer is not bound to this deployment." }, 503);
  const version = c.env.CF_VERSION_METADATA?.id;
  c.header("cache-control", "no-store");
  return c.json(await indexer.wake(version).catch(() => indexerOf(c.env)!.wake(version)));
});

/** Expired sign-in state, and launches prepared so long ago that their blockhash can no longer land. */
async function housekeeping(db: Db) {
  const authorizations = await db.delete(xAuthorizations).where(lt(xAuthorizations.expiresAt, sql`now()`)).returning({ state: xAuthorizations.state });
  const expiredSessions = await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`)).returning({ tokenHash: sessions.tokenHash });
  const stale = await db
    .update(launches)
    .set({ status: "expired" })
    .where(and(eq(launches.status, "prepared"), lt(launches.createdAt, sql`now() - interval '15 minutes'`)))
    .returning({ id: launches.id });
  return { authorizations: authorizations.length, sessions: expiredSessions.length, expiredLaunches: stale.length, candles: await pruneCandles(db) };
}

/**
 * The Cron Trigger: the indexer kept running, the keeper's float, any window claim the keeper's Workflows missed,
 * housekeeping, then every open alert to the operator.
 */
async function scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  const cfg = config(env);
  const indexer = indexerOf(env);
  if (indexer) ctx.waitUntil(indexer.wake(env.CF_VERSION_METADATA?.id).catch((e) => console.error("waking the indexer failed", e)));
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const keeper = cfg.heat?.keys?.keeper;
    // A failed run is recorded and raises its own alert, so one job failing never keeps the others from running.
    if (keeper) {
      await runJob(db, "keeper-balance", () => checkKeeperFloat(db, createSolanaRpc(cfg.rpcUrl), keeper, cfg.keeperFloatMinLamports), { exclusive: true }).catch(() => undefined);
    }
    await runJob(db, "window-claims", () => sweepWindowClaims(db, env), { exclusive: true }).catch(() => undefined);
    await runJob(db, "housekeeping", () => housekeeping(db), { exclusive: true }).catch(() => undefined);
    await notifyPending(db, cfg.alertWebhookUrl);
  } finally {
    ctx.waitUntil(close());
  }
}

const ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const LIVE_PATH = new RegExp(`^/live/(?:board|coins/(${ADDRESS}))$`);

/**
 * `GET /live/board` and `GET /live/coins/:mint`: a WebSocket on a live room (spec 10.2), handed straight to its Durable
 * Object, outside Hono, whose middleware would rewrite the 101 answer's headers. Browsers always send their origin on a
 * WebSocket handshake, and only Heat's pages may join; a client with no origin reads the same public trades as the API.
 */
function liveRoom(request: Request, env: Bindings): Promise<Response> | null {
  const match = LIVE_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const refuse = (status: number, error: string) => Promise.resolve(Response.json({ error }, { status }));
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426, "A live room speaks WebSocket.");
  const origin = request.headers.get("origin");
  if (origin && !config(env).webOrigins.includes(origin)) return refuse(403, "Only Heat's own pages may join a live room.");
  const rooms = env.LIVE_ROOMS;
  if (!rooms) return refuse(503, "Live rooms are not bound to this deployment.");
  return rooms.get(rooms.idFromName(match[1] ? `coin:${match[1]}` : "board")).fetch(request);
}

export default {
  fetch: (request, env, ctx) => liveRoom(request, env) ?? app.fetch(request, env, ctx),
  scheduled,
} satisfies ExportedHandler<Bindings>;
