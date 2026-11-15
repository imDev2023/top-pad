// The cohort's measures (spec 11.3, #63) and the default-mode rule worked out from them, read as `heat_operator` for the
// operator app's Cohort page. Every measure counts only the cohort's members (`cohort_members`): their launches, and the
// Fair Opens they scheduled with the seats in them.
//
// - A creator is a member with a landed launch. They keep Fair Open, preselected in the launch flow, when their first
//   landed launch is a Fair Open: their first choice, before anything else they saw on Heat could sway it.
// - A sealed Fair Open (every Fair Open is sealed: its coin hidden behind a hash until the open) reached its minimum raise
//   when it opened, and missed it when it failed for a pot below the minimum raise or below the lowest rung. One that
//   failed because the open went out late, or one a Bar cancelled, says nothing of demand, and is left out; one still
//   before its open waits.
// - A Fair Open's depositors are the people, by the admission server's cluster, whose seat held a deposit when the window
//   closed, the creator's own seat aside, in each Fair Open that reached its minimum raise or missed it.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { admissions, cohortMembers, cohortTaps, creators, fairOpens, fairOpenSeatEvents, jobRuns, launches, operatorAlerts, type DbOrTransaction } from "@top-pad/db";

/** A share: how many of how many. */
export type Share = { count: number; of: number };

export type FairOpenOutcome = "reached" | "missed" | "waiting" | "late" | "cancelled";

export type CohortFairOpen = {
  launch: string;
  ticker: string;
  creator: string;
  handle: string | null;
  opensAt: Date;
  minRaise: bigint;
  quoteMint: string;
  outcome: FairOpenOutcome;
  /** The people whose seat held a deposit when the window closed, the creator's aside; null before the window closes. */
  depositors: number | null;
};

export type CohortMeasures = {
  members: number;
  membersWithX: number;
  /** Members with a landed launch, and of them, those whose first was a Fair Open, and those who launched a second coin. */
  keptFairOpen: Share;
  secondCoin: Share;
  /** Decided sealed Fair Opens, and of them, those that reached their minimum raise. */
  reachedMinRaise: Share;
  fairOpens: CohortFairOpen[];
  /** Depositors per decided Fair Open: their mean and median, over `reachedMinRaise.of` Fair Opens. */
  depositorsPerFairOpen: { mean: number | null; median: number | null };
  /** People who deposited in a decided Fair Open, and of them, those who deposited in a second. */
  secondFairOpen: Share;
};

/** What a Fair Open's row and its launch say about how it ended. */
export function outcomeOf(o: { cancelledAt: Date | null; openedAt: Date | null; failure: string | null }): FairOpenOutcome {
  if (o.cancelledAt) return "cancelled";
  if (o.openedAt) return "reached";
  if (o.failure === "min_raise_missed" || o.failure === "below_lowest_rung") return "missed";
  if (o.failure === "late") return "late";
  return "waiting";
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The cohort's measures, read now. */
export async function cohortMeasures(tx: DbOrTransaction): Promise<CohortMeasures> {
  const members = await tx
    .select({ id: cohortMembers.creatorId, xUserId: creators.xUserId, handle: creators.xHandle })
    .from(cohortMembers)
    .innerJoin(creators, eq(creators.id, cohortMembers.creatorId));
  const ids = members.map((m) => m.id);
  const handles = new Map(members.map((m) => [m.id, m.handle]));
  const landed = ids.length
    ? await tx
        .select({
          creatorId: launches.creatorId,
          mode: launches.mode,
          ticker: launches.ticker,
          fairOpen: launches.fairOpen,
          cancelledAt: launches.cancelledAt,
          landedAt: launches.landedAt,
          createdAt: launches.createdAt,
        })
        .from(launches)
        .where(and(inArray(launches.creatorId, ids), eq(launches.status, "landed")))
    : [];

  // Creators: each member's landed launches, first first.
  const byCreator = new Map<string, typeof landed>();
  for (const l of landed) byCreator.set(l.creatorId, [...(byCreator.get(l.creatorId) ?? []), l]);
  const at = (l: (typeof landed)[number]) => (l.landedAt ?? l.createdAt).getTime();
  let kept = 0;
  let second = 0;
  for (const list of byCreator.values()) {
    list.sort((a, b) => at(a) - at(b));
    if (list[0]!.mode === "fair_open") kept++;
    if (list.length >= 2) second++;
  }

  // Fair Opens: those members scheduled, with how each ended.
  const scheduled = landed.filter((l) => l.mode === "fair_open" && l.fairOpen);
  const rows = scheduled.length
    ? await tx
        .select()
        .from(fairOpens)
        .where(
          inArray(
            fairOpens.launch,
            scheduled.map((l) => l.fairOpen!),
          ),
        )
    : [];
  const rowOf = new Map(rows.map((r) => [r.launch, r]));
  const decided = scheduled.filter((l) => {
    const r = rowOf.get(l.fairOpen!);
    const outcome = r ? outcomeOf({ cancelledAt: l.cancelledAt, openedAt: r.openedAt, failure: r.failure }) : "waiting";
    return outcome === "reached" || outcome === "missed";
  });

  // Seats: each decided Fair Open's people whose seat held a deposit as the window closed, the creator's aside.
  const decidedLaunches = decided.map((l) => l.fairOpen!);
  const events = decidedLaunches.length
    ? await tx
        .select({
          launch: fairOpenSeatEvents.launch,
          wallet: fairOpenSeatEvents.wallet,
          kind: fairOpenSeatEvents.kind,
          deposit: fairOpenSeatEvents.deposit,
          slot: fairOpenSeatEvents.slot,
          eventIndex: fairOpenSeatEvents.eventIndex,
        })
        .from(fairOpenSeatEvents)
        .where(and(inArray(fairOpenSeatEvents.launch, decidedLaunches), inArray(fairOpenSeatEvents.kind, ["deposit", "withdraw"])))
    : [];
  const clusters = decidedLaunches.length
    ? await tx.select({ launch: admissions.launch, wallet: admissions.wallet, cluster: admissions.cluster }).from(admissions).where(inArray(admissions.launch, decidedLaunches))
    : [];
  const clusterOf = new Map(clusters.map((a) => [`${a.launch}:${a.wallet}`, a.cluster]));
  // The last deposit or withdrawal of each seat says what it held as the window closed.
  const last = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const key = `${e.launch}:${e.wallet}`;
    const seen = last.get(key);
    if (!seen || e.slot > seen.slot || (e.slot === seen.slot && e.eventIndex > seen.eventIndex)) last.set(key, e);
  }
  const people = new Map<string, Set<string>>();
  for (const e of last.values()) {
    if (e.deposit <= 0n || rowOf.get(e.launch)?.creator === e.wallet) continue;
    const person = clusterOf.get(`${e.launch}:${e.wallet}`) ?? `wallet:${e.wallet}`;
    people.set(e.launch, (people.get(e.launch) ?? new Set()).add(person));
  }
  const perFairOpen = decidedLaunches.map((l) => people.get(l)?.size ?? 0);
  const joined = new Map<string, number>();
  for (const set of people.values()) for (const person of set) joined.set(person, (joined.get(person) ?? 0) + 1);

  const fairOpenList: CohortFairOpen[] = scheduled
    .map((l) => {
      const r = rowOf.get(l.fairOpen!);
      const outcome = r ? outcomeOf({ cancelledAt: l.cancelledAt, openedAt: r.openedAt, failure: r.failure }) : "waiting";
      return {
        launch: l.fairOpen!,
        ticker: l.ticker,
        creator: r?.creator ?? "",
        handle: handles.get(l.creatorId) ?? null,
        opensAt: r?.opensAt ?? l.createdAt,
        minRaise: r?.minRaise ?? 0n,
        quoteMint: r?.quoteMint ?? "",
        outcome,
        depositors: outcome === "reached" || outcome === "missed" ? (people.get(l.fairOpen!)?.size ?? 0) : null,
      };
    })
    .sort((a, b) => b.opensAt.getTime() - a.opensAt.getTime());

  return {
    members: members.length,
    membersWithX: members.filter((m) => m.xUserId).length,
    keptFairOpen: { count: kept, of: byCreator.size },
    secondCoin: { count: second, of: byCreator.size },
    reachedMinRaise: { count: decided.filter((l) => rowOf.get(l.fairOpen!)!.openedAt).length, of: decided.length },
    fairOpens: fairOpenList,
    depositorsPerFairOpen: {
      mean: perFairOpen.length ? perFairOpen.reduce((a, b) => a + b, 0) / perFairOpen.length : null,
      median: median(perFairOpen),
    },
    secondFairOpen: { count: [...joined.values()].filter((n) => n >= 2).length, of: joined.size },
  };
}

export type DefaultMode = {
  mode: "fair_open" | "instant";
  /** Each clause of the rule, whether it applies, and whether there is anything yet to judge it on. */
  clauses: { name: "kept" | "reached"; share: Share; threshold: "a third" | "half"; below: boolean; judged: boolean }[];
};

/**
 * Spec 11.3's rule: Fair Open stays the default unless fewer than a third of cohort creators keep it, or fewer than half
 * of sealed Fair Opens reach their minimum raise. Worked out in whole numbers, so exactly a third or exactly half keeps
 * it; a clause with nothing yet to count cannot apply.
 */
export function defaultMode(m: Pick<CohortMeasures, "keptFairOpen" | "reachedMinRaise">): DefaultMode {
  const kept = m.keptFairOpen;
  const reached = m.reachedMinRaise;
  const clauses: DefaultMode["clauses"] = [
    { name: "kept", share: kept, threshold: "a third", below: kept.of > 0 && 3 * kept.count < kept.of, judged: kept.of > 0 },
    { name: "reached", share: reached, threshold: "half", below: reached.of > 0 && 2 * reached.count < reached.of, judged: reached.of > 0 },
  ];
  return { mode: clauses.some((c) => c.below) ? "instant" : "fair_open", clauses };
}

export type TapView = {
  address: string | null;
  /** The cron's last reading of the tap's float, with when it was read. */
  float: { lamports: string; floor: string; claimsLeft: number; at: Date } | null;
  sent: number;
  sending: number;
  lamports: bigint;
  alert: { message: string; raisedAt: Date } | null;
  recent: { handle: string; wallet: string; lamports: bigint; signature: string; status: string; at: Date }[];
};

/** The tap as the operator reads it: its claims, the cron's last reading of its float, and its alert if one is open. */
export async function tapView(tx: DbOrTransaction): Promise<TapView> {
  const taps = await tx.select().from(cohortTaps).orderBy(desc(cohortTaps.createdAt));
  const [run] = await tx
    .select({ summary: jobRuns.summary, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, "cohort-tap"), eq(jobRuns.status, "succeeded")))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  const float = (run?.summary as { float?: { tap: string; lamports: string; floor: string; claimsLeft: number } } | null)?.float ?? null;
  const [alert] = await tx
    .select({ message: operatorAlerts.message, raisedAt: operatorAlerts.raisedAt })
    .from(operatorAlerts)
    .where(and(eq(operatorAlerts.kind, "tap_low_balance"), isNull(operatorAlerts.resolvedAt)));
  const live = taps.filter((t) => t.status !== "failed");
  return {
    address: float?.tap ?? null,
    float: float && run?.finishedAt ? { lamports: float.lamports, floor: float.floor, claimsLeft: float.claimsLeft, at: run.finishedAt } : null,
    sent: live.filter((t) => t.status === "sent").length,
    sending: live.filter((t) => t.status === "sending").length,
    lamports: live.filter((t) => t.status === "sent").reduce((a, t) => a + t.lamports, 0n),
    alert: alert ?? null,
    recent: live.slice(0, 20).map((t) => ({ handle: t.xHandle, wallet: t.wallet, lamports: t.lamports, signature: t.signature, status: t.status, at: t.createdAt })),
  };
}
