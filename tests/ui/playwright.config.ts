// The launch flow end to end (`direnv exec . pnpm --filter @top-pad/tests-ui e2e`): the web app and the API run locally, X is
// the stand-in in tests/x-stand-in, and everything else is real: devnet, Meteora's programs, the fee program, Turbo and
// Arweave. `e2e:devnet` runs the same flow against the deployed devnet site, whose API links the deployed stand-in. Either
// spends devnet SOL from the Solana CLI's wallet, and locally the API signs with the keeper key, which only this Mac holds
// (~/.config/top-pad/devnet/keeper.json), so it runs by hand, like the devnet tests, never in CI. Local servers already
// running on the ports are reused.
import { defineConfig } from "@playwright/test";

const DEVNET = process.env.E2E_TARGET === "devnet";
const X_STAND_IN = "http://localhost:8890";

/** The API and the web app on this Mac, against devnet, as `wrangler dev` and `next dev`. */
function localServers() {
  // The API's RPC must be a provider's: Solana's public endpoints refuse Workers. The shared Helius key is the one devnet
  // provider in the owner's keys (CLAUDE.md); run through `direnv exec` so it is in the environment.
  const rpcUrl = process.env.API_RPC_URL || (process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
  if (!rpcUrl) throw new Error("Set API_RPC_URL or HELIUS_API_KEY: run `direnv exec . pnpm --filter @top-pad/tests-ui e2e`.");
  return [
    {
      command: [
        "pnpm exec wrangler dev --port 8801",
        "--var X_CLIENT_ID:x-stand-in --var X_CLIENT_SECRET:x-stand-in-has-no-secret",
        `--var X_AUTHORIZE_URL:${X_STAND_IN}/i/oauth2/authorize --var X_API_URL:${X_STAND_IN}`,
        `--var "RPC_URL:${rpcUrl}"`,
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
  ];
}

export default defineConfig({
  testDir: "./src",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./test-results",
  globalSetup: "./src/global-setup.ts",
  use: {
    baseURL: DEVNET ? "https://top-pad-web-devnet.imdev2023.workers.dev" : "http://localhost:3110",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  webServer: DEVNET ? [] : localServers(),
});
