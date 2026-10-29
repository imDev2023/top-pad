import { serveXStandIn } from "@top-pad/x-stand-in/node";

/** Locally, the stand-in for X on 8890 for the local API; against devnet the API links the deployed stand-in. */
export default async function globalSetup() {
  if (process.env.E2E_TARGET === "devnet") return;
  const server = await serveXStandIn(8890, { callbacks: ["http://localhost:8801/auth/x/callback"] });
  return () => new Promise<void>((done) => server.close(() => done()));
}
