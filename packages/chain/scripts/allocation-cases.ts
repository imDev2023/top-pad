// `pnpm --filter @top-pad/chain allocation-cases`: writes src/fixtures/allocations.json, pots and the allocation this
// package's reference calculation gives each (spec 2.1 step 11). The Fair Open program's tests read the same file
// (`programs/fair_open/tests/allocation.rs`), so the program's allocation must equal the reference to the lamport.
// Regenerate it only when the rules change, and the program with them.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocate, DEPOSIT_STEP } from "../src/fairOpen";

const SOL = 1_000_000_000n;

/** A small deterministic generator (xorshift), the same pots on every run. */
let state = 0x5eed_f00dn;
function next(below: number): number {
  state ^= (state << 13n) & 0xffff_ffff_ffff_ffffn;
  state ^= state >> 7n;
  state ^= (state << 17n) & 0xffff_ffff_ffff_ffffn;
  return Number(state % BigInt(below));
}

type Case = { name: string; cap: bigint; counts: number[]; unverifiedCounts: number[] };

const empty = () => ({ counts: new Array<number>(200).fill(0), unverifiedCounts: new Array<number>(10).fill(0) });
const cases: Case[] = [];

// The worked example (spec 2.1 step 11): a 15 SOL pot, 30 people asking 0.1 SOL and 50 asking 0.5 to 2 SOL.
const example = empty();
example.counts[9] = 30;
for (let i = 0; i < 50; i++) example.counts[49 + i * 3]! += 1;
cases.push({ name: "the worked example", cap: 15n * SOL, ...example });

// Unverified asks beyond a quarter of the spend, and both tiers cut.
const quarter = empty();
quarter.counts[49] = 5;
quarter.unverifiedCounts[9] = 100;
cases.push({ name: "Unverified asks over a quarter", cap: 17n * SOL, ...quarter });
const both = empty();
both.counts[199] = 20;
both.unverifiedCounts[9] = 400;
cases.push({ name: "both tiers cut", cap: 17n * SOL, ...both });
cases.push({ name: "an empty pot", cap: 1_700_000_000n, ...empty() });

for (let i = 0; i < 400; i++) {
  const pot = empty();
  for (let j = next(40); j > 0; j--) pot.counts[next(next(2) === 0 ? 50 : 200)]! += next(30) + 1;
  for (let j = next(20); j > 0; j--) pot.unverifiedCounts[next(10)]! += next(200) + 1;
  // Devnet's 1.7 SOL cap, mainnet's 17 SOL, and anything between.
  const cap = i % 3 === 0 ? 1_700_000_000n : i % 3 === 1 ? 17n * SOL : BigInt(next(20_000_000)) * 1_000n + BigInt(next(1_000)) + 1n;
  cases.push({ name: `pot ${i}`, cap, ...pot });
}

/** Counts as [step index, seats] pairs, the zeros left out. */
const sparse = (counts: number[]) => counts.flatMap((n, k) => (n ? [[k, n]] : []));
const level = (l: { level: bigint; filled: bigint; limited: boolean }) => ({ level: `${l.level}`, filled: `${l.filled}`, limited: l.limited });

const out = cases.map((c) => {
  const a = allocate(c.counts, c.unverifiedCounts, DEPOSIT_STEP, c.cap);
  return {
    name: c.name,
    cap: `${c.cap}`,
    step: `${DEPOSIT_STEP}`,
    counts: sparse(c.counts),
    unverifiedCounts: sparse(c.unverifiedCounts),
    spend: `${a.spend}`,
    others: level(a.others),
    unverified: level(a.unverified),
  };
});
const path = join(dirname(fileURLToPath(import.meta.url)), "../src/fixtures/allocations.json");
// One pot a line, so a change to the rules shows pot by pot in a diff.
writeFileSync(path, `[\n${out.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`);
console.log(`wrote ${out.length} pots to ${path}`);
