// The acceptance run's stages (spec 11, #62), in the order `run.ts` takes them: every mandatory integration test of spec
// 11.2 and all four attack simulations of spec 11.1, each an existing devnet test, UI spec or check run as it is run by
// hand, then the run's own measurements. One at a time, since every on-chain step shares the free devnet endpoints
// (CLAUDE.md, Traps) and every UI spec the one deployed site.

/** Where a stage runs, from the repo's root. */
type Cwd = "tests/devnet" | "tests/ui" | "tests/acceptance";

export type Stage = {
  name: string;
  /** What of spec 11 it proves. */
  proves: string;
  cwd: Cwd;
  command: string[];
  env?: Record<string, string>;
  /** The most SOL the stage holds out of the bank at once, lent or spent: the run checks the bank covers it first. */
  peakSol: number;
  /** About how long it takes, for the plan the run prints. */
  minutes: number;
  /** It needs the two operator apps on this Mac (`pnpm --filter @top-pad/tests-ui operators`, ports 8803 and 8804). */
  operators?: boolean;
  /** It reads what every earlier stage did, so it runs last and also when stages failed. */
  measurement?: boolean;
};

/** A devnet test file, with vitest's console output kept: the measurements are in it (CLAUDE.md, Traps). */
const vitest = (file: string) => ["pnpm", "exec", "vitest", "run", file, "--silent=false"];
/** A UI spec against the deployed devnet site, by its whole file name (CLAUDE.md: a bare name matches every spec). */
const playwright = (file: string) => ["pnpm", "exec", "playwright", "test", file];
const devnetSite = { E2E_TARGET: "devnet" };

export const STAGES: Stage[] = [
  {
    name: "verified-builds",
    proves: "11.2: both programs deployed from verified builds, rebuilt from the commit recorded on chain",
    cwd: "tests/acceptance",
    command: ["pnpm", "exec", "tsx", "src/verified-builds.ts"],
    peakSol: 0,
    minutes: 20,
  },
  {
    name: "configs",
    proves: "11.2: Heat's two DBC configs as spec 3 sets them, and the generated clients reading Meteora's accounts",
    cwd: "tests/devnet",
    command: [...vitest("src/configs.test.ts"), "src/clients.test.ts"],
    peakSol: 0,
    minutes: 1,
  },
  {
    name: "instant-launch",
    proves: "11.2: an Instant launch as the launch service builds it, its creation-slot buy at the 99% cliff",
    cwd: "tests/devnet",
    command: vitest("src/instant-launch.test.ts"),
    peakSol: 0.1,
    minutes: 2,
  },
  {
    name: "fee-claims",
    proves: "11.2: the fee program's PDA claiming partner fees by CPI, the 60 s window claim, the 50/50 split to the creator role holder",
    cwd: "tests/devnet",
    command: vitest("src/fee-claims.test.ts"),
    peakSol: 0.2,
    minutes: 4,
  },
  {
    name: "fair-open-window",
    proves: "11.2: a Fair Open's window on chain: seats, caps, admissions, the minimum raise, the late failure and every refund",
    cwd: "tests/devnet",
    command: vitest("src/fair-open.test.ts"),
    peakSol: 1,
    minutes: 20,
  },
  {
    name: "fair-open-open",
    proves: "11.2: a full Fair Open (the open, the lock escrow's cliff and recipient, the pushes, the Tax Share, closed seats) and a partial fill",
    cwd: "tests/devnet",
    // Its three launches one at a time: run side by side, their polling outran the public endpoint's per-IP budget,
    // which answered 429 for minutes on end (2026-11-15).
    command: [...vitest("src/fair-open-open.test.ts"), "--maxConcurrency=1"],
    peakSol: 4,
    minutes: 20,
  },
  {
    name: "graduation-8.5",
    proves: "11.2: an Instant launch through to Graduation at 8.5 SOL by our deployed keeper, both LP halves locked, the fee stepping down",
    cwd: "tests/devnet",
    command: vitest("src/graduation.test.ts"),
    env: { GRADUATION: "real" },
    peakSol: 9.5,
    minutes: 5,
  },
  {
    name: "usdc-instant",
    proves: "11.2: an Instant launch in Circle's devnet USDC through Graduation, the creator's earnings claimed in USDC",
    cwd: "tests/devnet",
    command: vitest("src/graduation.test.ts"),
    env: { GRADUATION_QUOTE: "usdc" },
    peakSol: 0.2,
    minutes: 5,
  },
  {
    name: "usdc-fair-open-refunds",
    proves: "11.2: a Fair Open in USDC: deposits through the API and to the program, a withdrawal, the failure and every refund in USDC",
    cwd: "tests/devnet",
    command: vitest("src/fair-open-usdc.test.ts"),
    peakSol: 0.2,
    minutes: 6,
  },
  {
    name: "usdc-fair-open",
    proves: "11.2: a Fair Open in USDC that opens: refunds, pushes, the Tax Share and the creator's earnings in USDC",
    cwd: "tests/devnet",
    command: vitest("src/fair-open-graduation.test.ts"),
    env: { FAIR_OPEN_QUOTE: "usdc" },
    peakSol: 0.3,
    minutes: 5,
  },
  {
    name: "token2022-instant",
    proves: "11.2 (the stand-in xStock's path, in T22Q until Meteora badges the stand-in, #115): an Instant launch in a Token-2022 quote through Graduation",
    cwd: "tests/devnet",
    command: vitest("src/graduation.test.ts"),
    env: { GRADUATION_QUOTE: "token2022" },
    peakSol: 0.2,
    minutes: 5,
  },
  {
    name: "token2022-fair-open",
    proves: "11.2 (the stand-in xStock's path, in T22Q, #115): a Fair Open in a Token-2022 quote through its open, Tax Share and Graduation",
    cwd: "tests/devnet",
    command: vitest("src/fair-open-graduation.test.ts"),
    env: { FAIR_OPEN_QUOTE: "token2022" },
    peakSol: 0.3,
    minutes: 6,
  },
  {
    name: "sniper",
    proves: "11.1: the sniper simulation",
    cwd: "tests/devnet",
    command: vitest("src/sniper-simulation.test.ts"),
    peakSol: 3,
    minutes: 8,
  },
  {
    name: "failure",
    proves: "11.1: the failure simulation",
    cwd: "tests/devnet",
    command: vitest("src/failure-simulation.test.ts"),
    peakSol: 1,
    minutes: 21,
  },
  {
    name: "fair-open-scheduled",
    proves: "11.2: a Fair Open scheduled from the site, the 64-rung ladder signed in one approval (the test wallet), opened and settled by the deployed keeper; Turbo serving its metadata",
    cwd: "tests/ui",
    command: playwright("fair-open-scheduled.spec.ts"),
    env: devnetSite,
    peakSol: 1,
    minutes: 15,
  },
  {
    name: "sign-at-open",
    proves: "11.2: the sign-at-the-open fallback for a wallet that cannot sign the ladder",
    cwd: "tests/ui",
    command: playwright("fair-open-sign-at-open.spec.ts"),
    env: devnetSite,
    peakSol: 1,
    minutes: 14,
  },
  {
    name: "farm",
    proves: "11.1: the farm simulation",
    cwd: "tests/ui",
    command: playwright("farm-simulation.spec.ts"),
    env: devnetSite,
    peakSol: 4.5,
    minutes: 25,
  },
  {
    name: "bundler",
    proves: "11.1: the bundler simulation",
    cwd: "tests/ui",
    command: playwright("bundler-simulation.spec.ts"),
    env: devnetSite,
    peakSol: 1,
    minutes: 90,
    operators: true,
  },
  {
    name: "compute",
    proves: "11.2: each instruction's compute, measured from every transaction of both programs during the run",
    cwd: "tests/acceptance",
    command: ["pnpm", "exec", "tsx", "src/compute.ts"],
    peakSol: 0,
    minutes: 8,
    measurement: true,
  },
  {
    name: "opens",
    proves: "11.2: Turbo serving each open's metadata within 10 s, before its rung; how late each open landed",
    cwd: "tests/acceptance",
    command: ["pnpm", "exec", "tsx", "src/opens.ts"],
    peakSol: 0,
    minutes: 1,
    measurement: true,
  },
];
