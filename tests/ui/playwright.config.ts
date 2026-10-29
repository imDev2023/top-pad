// The launch flow end to end (`direnv exec . pnpm --filter @top-pad/tests-ui e2e`): the web app and the API run locally, X is the stand-in
// in src/fake-x.ts, and everything else is real: devnet, Meteora's programs, the fee program, Turbo and Arweave. It spends
// devnet SOL from the Solana CLI's wallet and signs with the keeper key, which only this Mac holds
// (~/.config/top-pad/devnet/keeper.json), so it runs by hand, like the devnet tests, never in CI. Servers already
// running on the ports are reused.
import { defineConfig } from "@playwright/test";

const FAKE_X = "http://localhost:8890";
// The API's RPC must be a provider's: Solana's public endpoints refuse Workers. The shared Helius key is the one devnet
// provider in the owner's keys (CLAUDE.md); run through `direnv exec` so it is in the environment.
const API_RPC_URL = process.env.API_RPC_URL || (process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!API_RPC_URL) throw new Error("Set API_RPC_URL or HELIUS_API_KEY: run `direnv exec . pnpm --filter @top-pad/tests-ui e2e`.");

export default defineConfig({
  testDir: "./src",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./test-results",
  globalSetup: "./src/global-setup.ts",
  use: { baseURL: "http://localhost:3110", trace: "retain-on-failure", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  webServer: [
    {
      command: [
        "pnpm exec wrangler dev --port 8801",
        "--var X_CLIENT_ID:local-client --var X_CLIENT_SECRET:local-secret",
        `--var X_AUTHORIZE_URL:${FAKE_X}/i/oauth2/authorize --var X_API_URL:${FAKE_X}`,
        `--var "RPC_URL:${API_RPC_URL}"`,
        '--var "KEEPER_KEY:$(cat "$HOME/.config/top-pad/devnet/keeper.json")"',
      ].join(" "),
      cwd: "../../apps/api",
      url: "http://localhost:8801/platform",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm exec next dev --port 3110",
      cwd: "../../apps/web",
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8801" },
      url: "http://localhost:3110/launch",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
