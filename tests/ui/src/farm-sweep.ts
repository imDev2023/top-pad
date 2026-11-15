// Sweeps a farm simulation's wallets back to Heat's bank after a run stopped partway: `pnpm exec tsx
// tests/ui/src/farm-sweep.ts <run> [mint]`, the run's name as farm-simulation.spec.ts logged it, and its coin if it
// opened, which the seats sell back first. Run it once the Fair Open has opened or failed: the keeper returns a failed
// launch's deposits to its seats' wallets.
import type { Address } from "@solana/kit";
import { sweepFarm } from "./farm";

const [run, mint] = process.argv.slice(2);
if (!run) throw new Error("usage: farm-sweep.ts <run> [mint]");
await sweepFarm(run, (mint as Address | undefined) ?? null);
