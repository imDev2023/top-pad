import postgres from "postgres";
import { runMigrations } from "./migrate";

/**
 * A throwaway, migrated database on the Postgres server in TEST_DATABASE_URL (`docker compose up -d` locally, a
 * service container in CI), so test files never share state and never touch a developer's own database.
 */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) throw new Error("TEST_DATABASE_URL is not set: run `docker compose up -d` and see CLAUDE.md.");
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
