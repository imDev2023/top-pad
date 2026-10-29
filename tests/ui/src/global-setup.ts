import { randomInt } from "node:crypto";
import { serveXStandIn } from "@top-pad/x-stand-in/node";

/**
 * The run's creator, new to Heat each run: a fresh handle on the stand-in for X makes a fresh Creator record, so the
 * run's own wallet becomes its Creator wallet. The handle reaches the tests through the environment. Locally it also
 * serves the stand-in on 8890 for the local API; against devnet the API links the deployed stand-in.
 */
export default async function globalSetup() {
  process.env.E2E_X_HANDLE = `e2e_creator_${randomInt(1e9, 1e10)}`;
  if (process.env.E2E_TARGET === "devnet") return;
  const server = await serveXStandIn(8890, { callbacks: ["http://localhost:8801/auth/x/callback"] });
  return () => new Promise<void>((done) => server.close(() => done()));
}
