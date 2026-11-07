import { defineConfig } from "vitest/config";

// Signing a 64-rung ladder is a few hundred ed25519 signatures: about a second alone, but `pnpm test` runs every package
// at once, and on a loaded machine (load average 95, 2026-11-07) two such tests passed vitest's default 5 s. The limit
// only catches a hang, so it allows for that load, as apps/api's does.
export default defineConfig({ test: { testTimeout: 30_000 } });
