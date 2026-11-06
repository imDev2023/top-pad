import { describe, expect, it } from "vitest";
import type { Db } from "@top-pad/db";
import type { Bindings } from "./env";
import { bandQuotes } from "./quoteBand";
import { testKeypair } from "./test/fakes";

const env = (more: Partial<Bindings> = {}): Bindings => ({
  CLUSTER: "devnet",
  WEB_ORIGIN: "http://localhost:3110",
  API_ORIGIN: "http://localhost:8801",
  HYPERDRIVE: { connectionString: "postgres://unused" },
  RPC_URL: "http://127.0.0.1:1",
  ...more,
});
// Nothing here reaches the database or the chain: each case stops before the job reads either.
const db = {} as Db;
const key = async () => JSON.stringify([...(await testKeypair()).secret]);

describe("the band job's keys", () => {
  it("runs nothing on a deployment without the quote manager key, as local development is", async () => {
    expect(await bandQuotes(db, env({ KEEPER_KEY: await key() }))).toEqual({ skipped: "the quote manager key is not bound to this deployment" });
  });

  it("refuses a quote manager key other than the one the cluster records", async () => {
    const run = bandQuotes(db, env({ KEEPER_KEY: await key(), QUOTE_MANAGER_KEY: await key() }));
    await expect(run).rejects.toThrow(/is \w+, not (639kdfnCQ762Rio8jdVXm66pqMx3uRHWeuiZpY5wwmWq|GpDvDUpEC9ynHTJBt3XaZcTvBUw1HaMnU9Wwox18xfNi)/);
  });

  it("runs nothing on a cluster without Heat's configs", async () => {
    expect(await bandQuotes(db, env({ CLUSTER: "mainnet", RPC_URL: "http://127.0.0.1:1" }))).toEqual({ skipped: "Heat has no configs or keys on mainnet" });
  });
});
