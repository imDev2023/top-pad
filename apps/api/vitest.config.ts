import { defineConfig } from "vitest/config";

// Each test file makes and drops its own Postgres database, and `pnpm test` runs every package's files at once against
// the one local Postgres: on a busy machine (load average 30, 2026-11-06) a 0.5 s test took over vitest's default 5 s
// and a database drop over its 10 s hook limit. The limits only catch a hang, so they allow for that load.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
