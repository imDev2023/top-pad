// Scoring (spec 11.5): Bundle Radar's own rules (`labelBuy`, `fundingLinks`, `walletLabels` in @top-pad/indexer), run
// over every launch in the kept set, against Jito's record of which buyers sat in the creation's own bundle.
import { fundingLinks, labelBuy, walletLabels, POSITIONS_AFTER_CREATION, type RadarCreation, type RadarLabel } from "@top-pad/indexer";
import type { LaunchRecord, SkippedRecord, TransferRecord } from "./collect";
import type { FleetSet } from "./fleet";
import type { LaunchList } from "./launches";

/** The bar a signal must clear to count toward confirmation: the low end of its 95% Wilson interval (spec 6.5, 11.5). */
export const PASS = 0.99;
const Z = 1.959963984540054;

/** The low end of the Wilson score interval for `hits` of `n`, at 95%. */
export function wilsonLower(hits: number, n: number, z = Z): number {
  if (n === 0) return 0;
  const p = hits / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** A signal the evaluation scores; `direct_link` is spec 6.5's rule as a whole, short of Jito's record itself. */
export type Signal = RadarLabel | "direct_link";
export const SIGNALS: readonly Signal[] = ["same_slot", "after_creation", "creator_signed", "creator_funded", "direct_link", "jito_bundle"];
/** The direct links scored against Jito's record, which is the ground truth and so is not one of them here. */
const SCORED_DIRECT: ReadonlySet<RadarLabel> = new Set(["after_creation", "creator_signed", "creator_funded"]);

/** One wallet that bought a launch in its creation slot, other than the Creator wallet, as Bundle Radar labels it. */
export type ScoredWallet = {
  launch: string;
  mint: string;
  creator: string;
  wallet: string;
  /** Its first buy in the creation slot. */
  signature: string;
  /** Its nearest place after the creation. */
  position: number;
  labels: RadarLabel[];
  signals: Signal[];
  /** Jito's record: one of its buys sat in the creation's own bundle; null where the creation was in no bundle. */
  inBundle: boolean | null;
  /** Whether its funding links were read through. */
  fundingRead: boolean;
  transfers: TransferRecord[];
  /** Every transaction linking it to the Creator wallet moved value both ways between them: a trade, not funding. */
  traded: boolean;
};

export type Score = {
  signal: Signal;
  flagged: number;
  correct: number;
  wrong: number;
  precision: number | null;
  lower: number;
  passes: boolean;
  /** Of the wallets in the creation's bundle, the share the signal flags. */
  recall: number | null;
};

const ratio = (a: number, b: number) => (b ? a / b : null);

export function score(wallets: readonly ScoredWallet[], signal: Signal, flags = (w: ScoredWallet) => w.signals.includes(signal)): Score {
  const flagged = wallets.filter(flags);
  const correct = flagged.filter((w) => w.inBundle).length;
  const positives = wallets.filter((w) => w.inBundle).length;
  const lower = wilsonLower(correct, flagged.length);
  return { signal, flagged: flagged.length, correct, wrong: flagged.length - correct, precision: ratio(correct, flagged.length), lower, passes: lower >= PASS, recall: ratio(correct, positives) };
}

const date = (unix: number) => new Date(unix * 1000);

/** Every wallet that bought `r` in its creation slot, other than the Creator wallet, with Bundle Radar's labels. */
export function walletsOf(r: LaunchRecord): ScoredWallet[] {
  const creation: RadarCreation = { creator: r.creator, slot: r.slot, blockIndex: r.blockIndex, jitoBundle: r.jitoBundle };
  const bundle = new Set(r.bundleTransactions ?? []);
  const funding = new Map(r.funding.map((f) => [f.wallet, f]));
  const byWallet = new Map<string, LaunchRecord["buys"]>();
  for (const b of r.buys) if (b.trader !== r.creator) byWallet.set(b.trader, [...(byWallet.get(b.trader) ?? []), b]);
  return [...byWallet].map(([wallet, buys]) => {
    const labelled = buys.map((b) => ({ b, ...labelBuy(creation, { trader: wallet, slot: r.slot, blockIndex: b.blockIndex, signers: b.signers, jitoBundle: b.jitoBundle }) }));
    const f = funding.get(wallet);
    const transfers = f ? (fundingLinks(r.creator, date(r.at), f.transfers.map((t) => ({ ...t, at: date(t.at) }))).get(wallet) ?? []) : [];
    const labels = walletLabels({ buyLabels: labelled.flatMap((l) => l.labels), funded: transfers.length > 0, creator: false });
    const signals: Signal[] = [...labels, ...(labels.some((l) => SCORED_DIRECT.has(l)) ? (["direct_link"] as const) : [])];
    const first = labelled[0]!;
    return {
      launch: r.signature,
      mint: r.mint,
      creator: r.creator,
      wallet,
      signature: first.b.signature,
      position: Math.min(...labelled.map((l) => l.position ?? Infinity)),
      labels,
      signals,
      inBundle: r.jitoBundle ? buys.some((b) => bundle.has(b.signature)) : null,
      fundingRead: f?.complete ?? false,
      transfers: transfers.map((t) => ({ ...t, at: t.at.getTime() / 1000 })),
      traded: transfers.length > 0 && tradedOnly(r.creator, transfers),
    };
  });
}

/** Whether every transaction among `transfers` moved value both ways between the Creator wallet and the other wallet. */
export function tradedOnly(creator: string, transfers: readonly Pick<TransferRecord, "signature" | "source">[]): boolean {
  const ways = new Map<string, Set<boolean>>();
  for (const t of transfers) ways.set(t.signature, (ways.get(t.signature) ?? new Set()).add(t.source === creator));
  return [...ways.values()].every((w) => w.size === 2);
}

export type FleetScore = { coin: string; participants: number; fleet: number; flagged: Record<Signal, { fleet: number; other: number }> };

/**
 * What each signal flags of each fleet launch's joiners or buyers, the fleet's and the rest's. The launchpads' own
 * trades, which pay the creator's fee to the Creator wallet, are left out of the funding links.
 */
export function scoreFleet(set: FleetSet): FleetScore[] {
  const fleet = new Set(set.fleet);
  return set.launches.map((l) => {
    const creation: RadarCreation = { creator: l.creator, slot: l.creation.slot, blockIndex: l.creation.blockIndex, jitoBundle: l.creation.jitoBundle };
    const launchpad = new Set(l.launchpadTransactions);
    const links = fundingLinks(l.creator, date(l.openedAt), l.transfers.filter((t) => !launchpad.has(t.signature)).map((t) => ({ ...t, at: date(t.at) })));
    const byWallet = new Map<string, RadarLabel[]>();
    for (const p of l.participants) {
      if (p.wallet === l.creator) continue;
      const { labels } = labelBuy(creation, { trader: p.wallet, slot: p.slot, blockIndex: p.blockIndex, signers: p.signers, jitoBundle: p.jitoBundle });
      byWallet.set(p.wallet, [...(byWallet.get(p.wallet) ?? []), ...labels]);
    }
    const flagged = Object.fromEntries(SIGNALS.map((s) => [s, { fleet: 0, other: 0 }])) as FleetScore["flagged"];
    for (const [wallet, buyLabels] of byWallet) {
      const labels = walletLabels({ buyLabels, funded: links.has(wallet), creator: false });
      const signals: Signal[] = [...labels, ...(labels.some((x) => x !== "same_slot") ? (["direct_link"] as const) : [])];
      for (const s of signals) flagged[s][fleet.has(wallet) ? "fleet" : "other"]++;
    }
    return { coin: l.coin, participants: byWallet.size, fleet: [...byWallet.keys()].filter((w) => fleet.has(w)).length, flagged };
  });
}

export type Results = {
  list: Omit<LaunchList, "launches"> & { listed: number };
  read: number;
  skipped: { reason: string; count: number }[];
  bundled: number;
  /** Bundled launches whose bundle held a buy by another wallet: Bitquery's creator bundles. */
  creatorBundles: number;
  withSlotBuyers: number;
  /** Every wallet that bought a bundled launch in its creation slot, scored against Jito's record. */
  bundledWallets: ScoredWallet[];
  scores: Score[];
  /** `creator_funded` leaving out wallets linked only by trades with the Creator wallet: a variant, not production's rule. */
  fundedOneWay: Score;
  /** `after_creation` counting positions 1 to 3 only: a variant. */
  firstThree: Score;
  /** Spec 6.5's direct links with both variants: a variant. */
  directVariant: Score;
  /** After_creation by its place after a bundled creation. */
  byPosition: { position: number; flagged: number; correct: number }[];
  /** The four positions after a creation Jito did not bundle, where no record says who sat there. */
  unbundled: { flagged: number; corroborated: number; inOwnBundle: number; wallets: ScoredWallet[] };
  /** Scored wallets whose funding link was left unsettled, so unflagged. */
  fundingUnread: { bundled: number; unbundled: number };
  /** Wallets in the creation slot of 3 or more launches in the sample: what the known-bot list keys on (spec 8). */
  repeatBuyers: { wallets: number; buys: number; everInBundle: number };
  fleet: { set: Pick<FleetSet, "fleet" | "sweeps">; scores: FleetScore[] };
};

const fundedOneWay = (w: ScoredWallet) => w.labels.includes("creator_funded") && !w.traded;
const firstThree = (w: ScoredWallet) => w.labels.includes("after_creation") && w.position <= 3;

export function evaluate(list: LaunchList, records: readonly (LaunchRecord | SkippedRecord)[], fleet: FleetSet): Results {
  const onList = new Set(list.launches.map((l) => l.signature));
  const latest = new Map<string, LaunchRecord | SkippedRecord>();
  for (const r of records) if (onList.has(r.signature)) latest.set(r.signature, r);
  const all = [...latest.values()];
  const launches = all.filter((r): r is LaunchRecord => !("skipped" in r));
  const skipped = new Map<string, number>();
  for (const r of all) if ("skipped" in r) skipped.set(r.skipped, (skipped.get(r.skipped) ?? 0) + 1);

  const bundled = launches.filter((r) => r.jitoBundle);
  const bundledWallets = bundled.flatMap(walletsOf);
  const scores = SIGNALS.map((s) => score(bundledWallets, s));
  const byPosition = Array.from({ length: POSITIONS_AFTER_CREATION }, (_, i) => {
    const at = bundledWallets.filter((w) => w.position === i + 1);
    return { position: i + 1, flagged: at.length, correct: at.filter((w) => w.inBundle).length };
  });

  const unbundledWallets = launches.filter((r) => !r.jitoBundle).flatMap(walletsOf).filter((w) => w.labels.includes("after_creation"));
  const ownBundle = new Set(launches.flatMap((r) => r.buys.filter((b) => b.jitoBundle).map((b) => b.signature)));
  const unbundled = {
    flagged: unbundledWallets.length,
    corroborated: unbundledWallets.filter((w) => w.labels.includes("creator_signed") || w.labels.includes("creator_funded")).length,
    inOwnBundle: unbundledWallets.filter((w) => ownBundle.has(w.signature)).length,
    wallets: unbundledWallets,
  };

  const slotBuyers = launches.flatMap((r) => [...new Set(r.buys.filter((b) => b.trader !== r.creator).map((b) => b.trader))].map((w) => ({ w, r })));
  const launchesOf = new Map<string, number>();
  for (const { w } of slotBuyers) launchesOf.set(w, (launchesOf.get(w) ?? 0) + 1);
  const repeat = [...launchesOf].filter(([, n]) => n >= 3);
  const inAnyBundle = new Set(bundledWallets.filter((w) => w.inBundle).map((w) => w.wallet));

  const { launches: _launches, ...listInfo } = list;
  return {
    list: { ...listInfo, listed: _launches.length },
    read: launches.length,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
    bundled: bundled.length,
    creatorBundles: bundled.filter((r) => walletsOf(r).some((w) => w.inBundle)).length,
    withSlotBuyers: launches.filter((r) => r.buys.some((b) => b.trader !== r.creator)).length,
    bundledWallets,
    scores,
    fundedOneWay: score(bundledWallets, "creator_funded", fundedOneWay),
    firstThree: score(bundledWallets, "after_creation", firstThree),
    directVariant: score(bundledWallets, "direct_link", (w) => firstThree(w) || fundedOneWay(w) || w.labels.includes("creator_signed")),
    byPosition,
    unbundled,
    fundingUnread: { bundled: bundledWallets.filter((w) => !w.fundingRead).length, unbundled: unbundledWallets.filter((w) => !w.fundingRead).length },
    repeatBuyers: { wallets: repeat.length, buys: repeat.reduce((n, [, k]) => n + k, 0), everInBundle: repeat.filter(([w]) => inAnyBundle.has(w)).length },
    fleet: { set: { fleet: fleet.fleet, sweeps: fleet.sweeps }, scores: scoreFleet(fleet) },
  };
}
