import { z } from "zod";

/** Every error answer from the API. */
export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const Cluster = z.enum(["localnet", "devnet", "mainnet"]);
export type Cluster = z.infer<typeof Cluster>;

/**
 * `GET /health`: whether the API is up and can reach its database. The database is read on every call, so a deploy
 * whose Hyperdrive binding or migrations are wrong never looks healthy.
 */
export const Health = z.object({
  ok: z.boolean(),
  cluster: Cluster,
  database: z.object({
    ok: z.boolean(),
    /** The round trip of the health query, through Hyperdrive when deployed. */
    latencyMs: z.number().nonnegative().nullable(),
    /** How many migrations the database has applied. */
    migrations: z.number().int().nonnegative().nullable(),
    /** The database server's clock, as it answered the health query. */
    serverTime: z.iso.datetime().nullable(),
    error: z.string().nullable(),
  }),
});
export type Health = z.infer<typeof Health>;
