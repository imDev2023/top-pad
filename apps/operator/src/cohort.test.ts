import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admissions, cohortMembers, cohortTaps, createDb, creators, fairOpens, fairOpenSeatEvents, jobRuns, launches, operatorAlerts, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { cohortMeasures, defaultMode, outcomeOf } from "./cohort";
import { asOperator } from "./db";
import type { Bindings } from "./env";
import worker from "./worker";

// The cohort's measures and the default-mode rule (spec 11.3, #63) on scripted launches: members who keep Fair Open or
// switch, Fair Opens that reach their minimum raise, miss it, fail late or wait, seats deposited, withdrawn and shared by
// one person across launches, and a non-member's launches, which count for nothing.

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;
const pending: Promise<unknown>[] = [];
beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
});
afterAll(async () => {
  await Promise.allSettled(pending);
  await closeDb();
  await drop();
});

const AUD = "heat-operator-test";
const env = { HYPERDRIVE: { connectionString: "" } as Hyperdrive, CLUSTER: "devnet", ACCESS_AUD: AUD, WEB_APP: "https://heat.test" } as Bindings;
const page = async (path: string) => {
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, access: { aud: AUD, getIdentity: async () => ({ email: "operator@heat.test" }) } };
  const res = await worker.fetch(new Request(`https://operator.heat.test${path}`), { ...env, HYPERDRIVE: { connectionString: url } as Hyperdrive }, ctx as unknown as ExecutionContext);
  return { status: res.status, html: await res.text() };
};

const DAY = 24 * 3600_000;
const T0 = Date.now() - 20 * DAY;
const at = (days: number) => new Date(T0 + days * DAY);
let n = 0;
/** A distinct base58-looking string for each address, mint or signature. */
const id = (prefix: string) => `${prefix}${(++n).toString().padStart(6, "1")}`.padEnd(44, "1");

async function record(o: { x?: boolean; member?: boolean } = {}) {
  n++;
  const [c] = await db
    .insert(creators)
    .values(o.x === false ? {} : { xUserId: `${9_000 + n}`, xHandle: `member_${n}`, xName: `Member ${n}` })
    .returning({ id: creators.id });
  if (o.member !== false) await db.insert(cohortMembers).values({ creatorId: c!.id });
  return { id: c!.id, wallet: id("W") };
}

type Rec = Awaited<ReturnType<typeof record>>;

async function launch(r: Rec, mode: "instant" | "fair_open", day: number, o: { status?: "landed" | "failed" | "expired"; cancelled?: boolean } = {}) {
  const fairOpen = mode === "fair_open" ? id("L") : null;
  await db.insert(launches).values({
    creatorId: r.id,
    wallet: r.wallet,
    mode,
    name: `Coin ${n}`,
    ticker: `C${n}`,
    mint: id("M"),
    pool: id("P"),
    config: id("C"),
    quoteMint: "So11111111111111111111111111111111111111112",
    metadataUri: "https://turbo-gateway.com/x",
    imageUri: "https://turbo-gateway.com/y",
    message: "AA==",
    lastValidBlockHeight: 1n,
    status: o.status ?? "landed",
    createdAt: at(day),
    landedAt: o.status && o.status !== "landed" ? null : at(day),
    fairOpen,
    cancelledAt: o.cancelled ? at(day) : null,
  });
  return fairOpen;
}

async function fairOpenRow(launchAccount: string, r: Rec, day: number, o: { opened?: boolean; failure?: "below_lowest_rung" | "min_raise_missed" | "late" } = {}) {
  await db.insert(fairOpens).values({
    launch: launchAccount,
    creator: r.wallet,
    nonce: id("N"),
    dbcConfig: id("C"),
    quoteMint: "So11111111111111111111111111111111111111112",
    identityHash: "00",
    depositsOpenAt: at(day),
    opensAt: at(day + 1),
    minRaise: 1_000_000_000n,
    potCap: 10_000_000_000n,
    lowestRung: 500_000_000n,
    step: 10_000_000n,
    status: o.opened ? "opened" : o.failure ? "closed" : "scheduled",
    failure: o.failure ?? null,
    openedAt: o.opened ? at(day + 1) : null,
    createdSignature: id("S"),
    createdSlot: 1,
    createdAt: at(day),
  });
}

let slot = 1_000;
/** A seat's deposit or withdrawal, leaving it holding `holds`, and the admission that let the wallet in as `cluster`. */
async function seat(launchAccount: string, wallet: string, holds: bigint, o: { kind?: "deposit" | "withdraw"; cluster?: string } = {}) {
  await db.insert(fairOpenSeatEvents).values({
    signature: id("S"),
    eventIndex: 0,
    slot: ++slot,
    at: new Date(),
    launch: launchAccount,
    wallet,
    person: "aa",
    kind: o.kind ?? "deposit",
    tier: o.kind === "withdraw" ? null : "scored",
    amount: 1n,
    deposit: holds,
  });
  await db
    .insert(admissions)
    .values({ launch: launchAccount, wallet, cluster: o.cluster ?? `wallet:${wallet}`, pseudonym: "aa", tier: "scored" })
    .onConflictDoNothing();
}

describe("the cohort's measures", () => {
  it("count members' launches and Fair Opens, and apply the default-mode rule at its boundaries", async () => {
    // Keeps Fair Open, and launches three more coins: one Instant, one Fair Open that fails late, one still waiting.
    const a = await record();
    const fo1 = (await launch(a, "fair_open", 1))!;
    await launch(a, "instant", 3);
    const foLate = (await launch(a, "fair_open", 4))!;
    const foWaiting = (await launch(a, "fair_open", 30))!;
    // Switches to Instant first, then schedules a Fair Open that misses its minimum raise.
    const b = await record();
    await launch(b, "instant", 2);
    const fo2 = (await launch(b, "fair_open", 5))!;
    // One Instant coin, and a Fair Open that never landed, which counts for nothing.
    const c = await record();
    await launch(c, "instant", 2);
    await launch(c, "fair_open", 1, { status: "expired" });
    // A member with no X and no launch, and a non-member whose Fair Open opened full of depositors.
    await record({ x: false });
    const outsider = await record({ member: false });
    const foOutside = (await launch(outsider, "fair_open", 1))!;

    await fairOpenRow(fo1, a, 1, { opened: true });
    await fairOpenRow(foLate, a, 4, { failure: "late" });
    await fairOpenRow(foWaiting, a, 30);
    await fairOpenRow(fo2, b, 5, { failure: "min_raise_missed" });
    await fairOpenRow(foOutside, outsider, 1, { opened: true });

    // fo1: two people, the creator's own seat, and one who withdrew everything; person x:1 deposits from two wallets.
    await seat(fo1, "w1", 5n, { cluster: "x:1" });
    await seat(fo1, "w2", 3n);
    await seat(fo1, a.wallet, 9n);
    await seat(fo1, "w3", 2n);
    await seat(fo1, "w3", 0n, { kind: "withdraw" });
    await seat(fo1, "w2", 4n);
    // fo2: person x:1 again from another wallet, and one more; a late or waiting Fair Open's seats count for nothing.
    await seat(fo2, "w1b", 1n, { cluster: "x:1" });
    await seat(fo2, "w4", 1n);
    await seat(foLate, "w5", 1n);
    for (const w of ["o1", "o2", "o3"]) await seat(foOutside, w, 1n);

    const m = await asOperator(db, cohortMeasures);
    expect(m).toMatchObject({
      members: 4,
      membersWithX: 3,
      keptFairOpen: { count: 1, of: 3 },
      secondCoin: { count: 2, of: 3 },
      reachedMinRaise: { count: 1, of: 2 },
      depositorsPerFairOpen: { mean: 2, median: 2 },
      secondFairOpen: { count: 1, of: 3 },
    });
    expect(Object.fromEntries(m.fairOpens.map((f) => [f.launch, [f.outcome, f.depositors]]))).toEqual({
      [fo1]: ["reached", 2],
      [fo2]: ["missed", 2],
      [foLate]: ["late", null],
      [foWaiting]: ["waiting", null],
    });
    // Exactly a third keep it and exactly half reached their minimum raise: neither is fewer, so Fair Open stays.
    expect(defaultMode(m)).toMatchObject({ mode: "fair_open", clauses: [{ name: "kept", below: false, judged: true }, { name: "reached", below: false, judged: true }] });

    // One more Fair Open missing its minimum raise: 1 of 3 is fewer than half, so Instant launch would become the default.
    const fo3 = (await launch(c, "fair_open", 6))!;
    await fairOpenRow(fo3, c, 6, { failure: "below_lowest_rung" });
    const after = await asOperator(db, cohortMeasures);
    expect(after.reachedMinRaise).toEqual({ count: 1, of: 3 });
    expect(after.depositorsPerFairOpen).toEqual({ mean: 4 / 3, median: 2 });
    expect(defaultMode(after)).toMatchObject({ mode: "instant", clauses: [{ name: "kept", below: false }, { name: "reached", below: true }] });

    // The page, read as heat_operator, says the same.
    const { status, html } = await page("/cohort");
    expect(status).toBe(200);
    expect(html).toContain("Instant launch would become the default");
    expect(html).toContain("Sealed Fair Opens that reached their minimum raise: 1 of 3, fewer than half.");
    expect(html).toContain("Creators who kept Fair Open: 1 of 3, not fewer than a third.");
    expect(html).toContain("4 members, 3 with X linked");
    expect(html).toContain("Failed late, not counted");
  });

  it("applies the rule's creator clause, and judges nothing it has nothing to count", () => {
    expect(defaultMode({ keptFairOpen: { count: 0, of: 0 }, reachedMinRaise: { count: 0, of: 0 } })).toMatchObject({ mode: "fair_open", clauses: [{ judged: false }, { judged: false }] });
    // 3 of 10 is fewer than a third; 4 of 12 is exactly a third.
    expect(defaultMode({ keptFairOpen: { count: 3, of: 10 }, reachedMinRaise: { count: 5, of: 5 } }).mode).toBe("instant");
    expect(defaultMode({ keptFairOpen: { count: 4, of: 12 }, reachedMinRaise: { count: 5, of: 5 } }).mode).toBe("fair_open");
    expect(outcomeOf({ cancelledAt: new Date(), openedAt: null, failure: "min_raise_missed" })).toBe("cancelled");
  });

  it("shows the tap's claims, the newest reading of its float, and its open alert", async () => {
    const r = await record();
    await db.insert(cohortTaps).values({ creatorId: r.id, xUserId: "77", xHandle: "tapped_member", wallet: r.wallet, lamports: 1_000_000_000n, signature: id("S"), lastValidBlockHeight: 1n, status: "sent" });
    const float = (lamports: string, claimsLeft: number) => ({ tap: "AQkkeusaMSeJdtz3iatfsvUJjBuYU2riQSrqLKwpUQTv", lamports, floor: "3000000000", low: true, claimsLeft });
    // The cron read 3.5 SOL; a tap since left 2.5, and its own reading is the newer.
    await db.insert(jobRuns).values([
      { id: "run-1", job: "cohort-tap", status: "succeeded", finishedAt: new Date(Date.now() - 60_000), summary: { sent: 0, failed: 0, waiting: 0, float: float("3500000000", 3) } },
      { id: "run-2", job: "cohort-tap-float", status: "succeeded", finishedAt: new Date(), summary: { float: float("2500000000", 2) } },
    ]);
    await db.insert(operatorAlerts).values({ kind: "tap_low_balance", subject: "AQkkeusaMSeJdtz3iatfsvUJjBuYU2riQSrqLKwpUQTv", message: "The cohort tap holds 2.500 SOL, below its 3.000 SOL floor." });
    const { status, html } = await page("/cohort");
    expect(status).toBe(200);
    expect(html).toContain("@tapped_member");
    expect(html).toContain("2.5</span> SOL, floor <span class=\"num\">3</span> SOL: 2 more members can be paid");
    expect(html).toContain("The cohort tap holds 2.500 SOL, below its 3.000 SOL floor.");
  });
});
