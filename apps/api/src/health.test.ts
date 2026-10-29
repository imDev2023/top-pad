import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Health } from "@top-pad/contract";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import type { Bindings } from "./env";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const migrationCount = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length;

let url: string;
let drop: () => Promise<void>;
beforeAll(async () => ({ url, drop } = await createTestDatabase()));
afterAll(() => drop());

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} };
const env = (connectionString: string): Bindings => ({
  CLUSTER: "localnet",
  WEB_ORIGIN: "http://localhost:3110",
  API_ORIGIN: "http://localhost:8801",
  HYPERDRIVE: { connectionString },
});
const health = (connectionString: string, init?: RequestInit) => app.request("/health", init, env(connectionString), ctx as never);

describe("GET /health", () => {
  it("reads the database and reports every migration it has applied", async () => {
    const res = await health(url);
    expect(res.status).toBe(200);
    const body = Health.parse(await res.json());
    expect(body).toMatchObject({ ok: true, cluster: "localnet", database: { ok: true, migrations: migrationCount, error: null } });
    expect(Date.now() - Date.parse(body.database.serverTime!)).toBeLessThan(60_000);
  });

  it("answers 503 without the database's address when the database does not answer", async () => {
    const res = await health("postgres://nobody:secret@127.0.0.1:1/none");
    expect(res.status).toBe(503);
    const body = Health.parse(await res.json());
    expect(body).toMatchObject({ ok: false, database: { ok: false, error: "the database did not answer" } });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("lets the web app's origin read it from a browser", async () => {
    const res = await health(url, { headers: { origin: "http://localhost:3110" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3110");
    const other = await health(url, { headers: { origin: "https://elsewhere.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

afterAll(() => Promise.allSettled(pending));
