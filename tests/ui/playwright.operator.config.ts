// The operator app end to end (`pnpm --filter @top-pad/tests-ui e2e:operator`): the operator Worker under `wrangler dev`,
// where the runtime stands in for Cloudflare Access with the identity in apps/operator/wrangler.jsonc, against a database
// of its own seeded with one of each kind of queue item (src/operator-demo.ts). Reads no chain and spends nothing; the
// shared local database is never touched. Every step is photographed on a phone and a desktop in both themes.
import { defineConfig } from "@playwright/test";

export const OPERATOR = "http://localhost:8803";

export default defineConfig({
  testDir: "./src",
  testMatch: /operator\.e2e\.ts/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./test-results/operator",
  use: { baseURL: OPERATOR, trace: "retain-on-failure", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  webServer: {
    // Seeded afresh each run, so never an operator app already running against something else.
    command:
      'export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$(pnpm --silent exec tsx src/operator-demo.ts)" && cd ../../apps/operator && exec pnpm exec wrangler dev --port 8803',
    url: `${OPERATOR}/icon.svg`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
