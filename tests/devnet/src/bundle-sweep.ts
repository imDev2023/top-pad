// Sweeps a stopped bundle run's wallets back to Heat's devnet bank: `pnpm exec tsx tests/devnet/src/bundle-sweep.ts <run>
// [mint...]`, the run's name as its spec logged it, and the coins it launched, which are sold first.
import { address } from "@solana/kit";
import { sweepRun } from "./bundle";

const [run, ...mints] = process.argv.slice(2);
if (!run) throw new Error("usage: bundle-sweep.ts <run> [mint...]");
await sweepRun(run, mints.map((m) => address(m)));
console.log(`swept the wallets of bundle run ${run}`);
