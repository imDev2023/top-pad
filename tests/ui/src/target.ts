/** Where the end-to-end test runs: this Mac's servers, or the deployed devnet site and its API (E2E_TARGET=devnet). */
export const TARGET =
  process.env.E2E_TARGET === "devnet"
    ? { name: "devnet", web: "https://top-pad-web-devnet.imdev2023.workers.dev", api: "https://top-pad-api-devnet.imdev2023.workers.dev" }
    : { name: "local", web: "http://localhost:3110", api: "http://localhost:8801" };
