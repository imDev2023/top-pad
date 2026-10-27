import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { Health } from "@top-pad/contract";
import { createDb, probe } from "@top-pad/db";
import { config, type Bindings } from "./env";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", async (c, next) => cors({ origin: config(c.env).webOrigins, allowMethods: ["GET", "POST", "DELETE"] })(c, next));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Healthy only when the configuration is valid and the database answers through Hyperdrive, so a deploy with a wrong
// binding or unapplied migrations never looks ready. Answers 503 with the reason when it is not.
app.get("/health", async (c) => {
  const { cluster } = config(c.env);
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

export default app;
