import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Applies the SQL migrations in `packages/db/migrations`. Used by tests and deploys, never by a Worker. */
export async function runMigrations(connectionString: string) {
  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations") });
  } finally {
    await client.end();
  }
}
