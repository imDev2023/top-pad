// Sweeps a stopped bundle run's wallets back to Heat's devnet bank: `pnpm exec tsx tests/devnet/src/bundle-sweep.ts <run>
// [mint...]`, the run's name as its spec logged it, and the coins it launched, which are sold first. A wallet left too
// empty to pay for its sells is topped up from the bank first, then swept back with the rest.
import { address } from "@solana/kit";
import { runWallets, sweepRun } from "./bundle";
import { fund, rpc } from "./devnet";

const FEES = 3_000_000n;
const [run, ...mints] = process.argv.slice(2);
if (!run) throw new Error("usage: bundle-sweep.ts <run> [mint...]");
const { creator, sniper, funded } = await runWallets(run);
const all = [creator, sniper, ...funded];
const low = [];
for (const w of all) if ((await rpc.getBalance(w.address, { commitment: "confirmed" }).send()).value < FEES) low.push(w);
if (mints.length && low.length) await fund(low, low.map(() => FEES));
await sweepRun(run, mints.map((m) => address(m)));
console.log(`swept the wallets of bundle run ${run}`);
