import { defineConfig } from "vitest/config";

export default defineConfig({
  // The public devnet endpoint is slow and rate-limited; one file at a time, with room to answer.
  test: { testTimeout: 60_000, fileParallelism: false },
});
