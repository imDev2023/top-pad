import { randomInt } from "node:crypto";
import { startFakeX } from "./fake-x";

/**
 * Serves the stand-in X on 8890, as a creator new to Heat each run: a fresh X user id makes a fresh Creator record, so
 * the run's own wallet becomes its Creator wallet. The id and handle reach the tests through the environment.
 */
export default async function globalSetup() {
  const id = String(randomInt(1e12, 9e12));
  const username = `e2e_${id.slice(-6)}`;
  process.env.E2E_X_HANDLE = username;
  const server = await startFakeX(8890, { id, username, name: "E2E Creator" });
  return () => new Promise<void>((done) => server.close(() => done()));
}
