import type { Context, MiddlewareHandler } from "hono";
import { createDb, type Db } from "@top-pad/db";
import type { LaunchRefusal } from "@top-pad/contract";
import { config, type Bindings, type Config } from "./env";

export type AppEnv = { Bindings: Bindings; Variables: { cfg: Config; db: Db } };

/** Checks the Worker's settings once per request, so every handler reads them typed. */
export const withConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("cfg", config(c.env));
  await next();
};

/** One short-lived database client per request (Workers do not share sockets across requests), closed afterwards. */
export const withDb: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
  c.set("db", db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
};

/**
 * Requests that change something must come from the web app's own pages. The session cookie is SameSite=Lax, which
 * already keeps other sites out, but other `*.workers.dev` subdomains are the same site, and a form post or a multipart
 * upload needs no CORS preflight, so the Origin header is checked as well.
 */
export const sameOriginWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (!origin || !c.var.cfg.webOrigins.includes(origin)) return c.json({ error: "This request must come from Heat's own pages." }, 403);
  }
  await next();
};

/** A launch refused, with the reason the launch flow shows. */
export function refuse(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 502 | 503, body: LaunchRefusal) {
  return c.json(body, status);
}
