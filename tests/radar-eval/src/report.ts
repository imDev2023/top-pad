// The report, `docs/bundle-radar-evaluation.md`, written from the results alone, so a rerun rewrites all of it.
import { PASS, SIGNALS, type FleetScore, type Results, type ScoredWallet, type Signal } from "./evaluate";

const NAMES: Record<Signal, string> = {
  same_slot: "Same slot (`same_slot`, a label only)",
  after_creation: "Positions 1 to 4 after the creation (`after_creation`)",
  jito_bundle: "Same Jito bundle as the creation (`jito_bundle`)",
  creator_signed: "Creator wallet signed or paid (`creator_signed`)",
  creator_funded: "Direct transfer with the Creator wallet (`creator_funded`)",
  direct_link: "Any direct link short of Jito's record (spec 6.5)",
};
const SHORT: Record<Signal, string> = {
  same_slot: "same slot",
  after_creation: "positions 1 to 4",
  jito_bundle: "Jito bundle",
  creator_signed: "signed or paid",
  creator_funded: "direct transfer",
  direct_link: "any direct link",
};

const pct = (x: number | null, digits = 2) => (x === null ? "-" : `${(x * 100).toFixed(digits)}%`);
const n = (x: number) => x.toLocaleString("en-US");
const tx = (sig: string) => `[${sig.slice(0, 8)}...](https://solscan.io/tx/${sig})`;
const acct = (a: string) => `[${a.slice(0, 6)}...](https://solscan.io/account/${a})`;
const WSOL = "So11111111111111111111111111111111111111112";
const amount = (t: { asset: string; amount: string }) =>
  t.asset === "SOL" ? `${Number(t.amount) / 1e9} SOL` : t.asset === WSOL ? `${Number(t.amount) / 1e9} wrapped SOL` : `${n(Number(t.amount))} of ${acct(t.asset)}`;
const share = (a: number, b: number) => `${n(a)} of ${n(b)} (${pct(b ? a / b : null, 1)})`;

function verdict(s: Results["scores"][number]): string {
  if (s.signal === "jito_bundle") return `is the ground truth itself, so it is right by definition on the ${n(s.flagged)} wallets it flags`;
  if (s.flagged === 0) return "flagged no wallet, so its precision is not measured";
  const w = `${n(s.flagged)} flagged, ${n(s.wrong)} wrong: precision ${pct(s.precision)}, Wilson low ${pct(s.lower)}`;
  return s.passes ? `passes (${w})` : `does not pass (${w}; it needs ${pct(PASS, 0)})`;
}

function wrongRows(wallets: readonly ScoredWallet[]): string[] {
  const wrong = wallets.filter((w) => w.inBundle === false && w.signals.includes("direct_link"));
  if (!wrong.length) return ["No direct link flagged a wallet outside the creation's bundle."];
  return [
    `${n(wrong.length)} wallets were flagged by a direct link but sat outside the creation's bundle; each is listed so it can be checked by hand.`,
    "",
    "| Launch | Wallet | Flagged by | Position | Its buy | Transfers with the Creator wallet |",
    "| - | - | - | - | - | - |",
    ...wrong.map(
      (w) =>
        `| ${tx(w.launch)} | ${acct(w.wallet)} | ${w.labels.filter((l) => l !== "same_slot").map((l) => SHORT[l]).join(", ")}${w.traded ? " (a trade)" : ""} | ${w.position} | ${tx(w.signature)} | ${w.transfers.length ? w.transfers.map((t) => `${tx(t.signature)} ${t.source === w.creator ? "from" : "to"} the creator, ${amount(t)}`).join("; ") : "-"} |`,
    ),
  ];
}

function fleetTable(scores: readonly FleetScore[]): string[] {
  const cols: Signal[] = ["same_slot", "after_creation", "jito_bundle", "creator_signed", "creator_funded", "direct_link"];
  const total = (f: (s: FleetScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const cell = (fleet: number, of: number, other: number) => `${fleet} of ${of}${other ? `, and ${other} other` : ""}`;
  return [
    `| Launch | Wallets that joined or bought | Fleet wallets among them | ${cols.map((c) => SHORT[c]).join(" | ")} |`,
    `| - | - | - | ${cols.map(() => "-").join(" | ")} |`,
    ...scores.map((s) => `| ${s.coin} | ${s.participants} | ${s.fleet} | ${cols.map((c) => cell(s.flagged[c].fleet, s.fleet, s.flagged[c].other)).join(" | ")} |`),
    `| All five | ${total((s) => s.participants)} | ${total((s) => s.fleet)} | ${cols.map((c) => cell(total((s) => s.flagged[c].fleet), total((s) => s.fleet), total((s) => s.flagged[c].other))).join(" | ")} |`,
  ];
}

export function writeReport(r: Results): string {
  const byName = new Map(r.scores.map((s) => [s.signal, s]));
  const direct = byName.get("direct_link")!;
  const fleetWallets = r.fleet.scores.reduce((a, s) => a + s.fleet, 0);
  const fleetFound = r.fleet.scores.reduce((a, s) => a + s.flagged.direct_link.fleet, 0);
  const lines = [
    "# The Bundle Radar evaluation",
    "",
    "Written by `pnpm --filter @top-pad/tests-radar-eval evaluate` (spec 11.5, [#61](https://github.com/imDev2023/top-pad/issues/61)); rerun it rather than editing this file.",
    "It measures how precisely each Bundle Radar signal finds a creator's bundle on mainnet pump.fun launches.",
    "It runs Bundle Radar's own rules over every launch, `labelBuy`, `fundingLinks` and `walletLabels` in `@top-pad/indexer`, the functions `radarOf` runs on Heat's coins, and scores them against Jito's public record of which buyers sat in the creation's own bundle.",
    `A signal may count toward confirming a bundle only once the low end of its 95% Wilson interval reaches ${pct(PASS, 0)} (spec 6.5): at least 400 flagged wallets with none wrong, or 1,000 with at most 3.`,
    "",
    "## Answer",
    "",
    "Scored over every wallet other than the Creator wallet that bought a launch in its creation slot, where Jito bundled the creation; a flag is right when one of the wallet's buys sat in the creation's bundle.",
    "",
    "| Signal | Wallets flagged | Wrong | Precision | Wilson low (95%) | Reaches 99% | Bundle wallets it finds |",
    "| - | - | - | - | - | - | - |",
    ...r.scores.map((s) => `| ${NAMES[s.signal]} | ${n(s.flagged)} | ${n(s.wrong)} | ${pct(s.precision)} | ${pct(s.lower)} | ${s.signal === "jito_bundle" ? "ground truth" : s.passes ? "yes" : "no"} | ${pct(s.recall, 1)} |`),
    "",
    ...SIGNALS.filter((s) => s !== "same_slot").map((s) => `- ${NAMES[s]} ${verdict(byName.get(s)!)}.`),
    `- ${NAMES.same_slot} ${byName.get("same_slot")!.flagged ? `is right on ${pct(byName.get("same_slot")!.precision, 1)} of the wallets it marks, which is why it only labels` : "marked no wallet"}.`,
    `- Where Jito did not bundle the creation, the four positions after it held ${n(r.unbundled.flagged)} wallets; another direct link backs ${share(r.unbundled.corroborated, r.unbundled.flagged)}, a floor under the rule's precision there, not a measure of it (below).`,
    `- The Cryptstarter and Harmonized fleet: the direct links found ${share(fleetFound, fleetWallets)} of the fleet wallets that joined or bought its five launches, all of them CSTARTER's, through the transfer that defines the fleet (below).`,
    "",
    "## The launches",
    "",
    `- The list is an even sample, about every ${Math.round(r.list.creations / Math.max(1, r.list.listed))}th in chain order, of the ${n(r.list.creations)} successful pump.fun creations of ${r.list.day} (UTC), so every hour is in it: ${n(r.list.listed)} launches, in \`tests/radar-eval/data/launches.json\`.`,
    `- Launches read: ${n(r.read)}.`,
    ...(r.skipped.length ? [`  Not launches after all: ${r.skipped.map((s) => `${n(s.count)} (${s.reason})`).join(", ")}.`] : []),
    `- Jito bundled the creation of ${share(r.bundled, r.read)}; in ${share(r.creatorBundles, r.read)} the bundle also held a buy by another wallet, a creator bundle in Bitquery's sense (it found the creator's wallets in block 0 of 21%).`,
    `- A wallet other than the Creator wallet bought in the creation slot of ${share(r.withSlotBuyers, r.read)}.`,
    `- Scored wallets: ${n(r.bundledWallets.length)} bought a bundled launch in its creation slot, of which ${n(r.bundledWallets.filter((w) => w.inBundle).length)} sat in its bundle.`,
    "",
    "## Spec 6.5's direct links, one by one",
    "",
    `- **Positions 1 to 4** ${verdict(byName.get("after_creation")!)}.`,
    "  By position after a bundled creation:",
    "",
    "  | Position | Wallets | In the creation's bundle |",
    "  | - | - | - |",
    ...r.byPosition.map((p) => `  | ${p.position} | ${n(p.flagged)} | ${share(p.correct, p.flagged)} |`),
    "",
    `- **Same Jito bundle** ${verdict(byName.get("jito_bundle")!)}; production reads it from the same API (\`jitoApi\`).`,
    `- **Signed or paid by the Creator wallet** ${verdict(byName.get("creator_signed")!)}.`,
    `- **Direct transfers with the Creator wallet** in the 7 days either side of the open ${verdict(byName.get("creator_funded")!)}.`,
    `  The link was settled, a transfer found or every candidate read, for ${n(r.bundledWallets.length - r.fundingUnread.bundled)} of the ${n(r.bundledWallets.length)} scored wallets (${pct((r.bundledWallets.length - r.fundingUnread.bundled) / Math.max(1, r.bundledWallets.length), 1)}); the rest count as unflagged (Method, below), which lowers what it finds, not its precision.`,
    "  Some links are trades: one transaction in which the Creator wallet sent the buyer coins and the buyer paid it SOL, or the reverse, which spec 6.5 counts as coins passed directly.",
    `  Leaving out wallets linked only by trades, a variant and not production's rule, ${verdict(r.fundedOneWay)}.`,
    "  The reading stops at the first linking transaction, so a wallet whose first was a trade may hold a one-way transfer too, and the variant may flag more than this counts.",
    `- **Any of them** ${verdict(direct)}: this is what puts a wallet in a case today, short of Jito's record, which settles it on mainnet.`,
    "",
    "## Two variants the wrong flags suggest",
    "",
    "Every wrong flag was either a trade or position 4, so two narrower rules would have made no mistake here:",
    `- Positions 1 to 3 only ${verdict(r.firstThree)}.`,
    `- Direct transfers leaving out trades ${verdict(r.fundedOneWay)}.`,
    `- Spec 6.5's direct links with both ${verdict(r.directVariant)}.`,
    "",
    "They were chosen after seeing these wrong flags, so this sample cannot measure them fairly: a rule change would need them confirmed on a fresh sample, another day's launches, which the same command reads once `DAY` in `tests/radar-eval/src/main.ts` names that day and the kept data is moved aside.",
    "",
    "## The position rule where the creation was not bundled",
    "",
    "Heat's launch key sends every creation, so a creator's bundle can never hold it, and the position rule then flags whoever lands next; on devnet a sniper with no tie to the creator was flagged that way (spec 6.4).",
    `On the ${n(r.read - r.bundled)} launches whose creation Jito did not bundle, ${n(r.unbundled.flagged)} wallets bought in the four positions after it.`,
    `No record says whose they were; another direct link (the Creator wallet signing for them, or a direct transfer) backs ${share(r.unbundled.corroborated, r.unbundled.flagged)}, so that is the floor under the rule's precision there.`,
    `None of the rest is known to be wrong either: the funding link was left unsettled for ${n(r.fundingUnread.unbundled)} of them, read at most 8 transactions each, and ${share(r.unbundled.inOwnBundle, r.unbundled.flagged)} landed in a Jito bundle of their own.`,
    "",
    "## The Cryptstarter and Harmonized fleet",
    "",
    "The second case is one operator's wallet fleet, which joined or bought its own five single-use launches on mainnet in October 2026, funded through exchanges and hop wallets (#29, `research/alpha-vault-prior-art`); Jito saw none of it.",
    `The fleet is read from the chain by the two sweeps that gave it away, ${r.fleet.set.sweeps.map((s) => `${s.wallets} wallets sending SOL ${s.note} (${acct(s.to)})`).join(" and ")}: ${r.fleet.set.fleet.length} wallets in all.`,
    "The first sweep is itself a direct transfer with Cryptstarter's Creator wallet, as proceeds sent back, so `creator_funded` finding CSTARTER's fleet is partly how that fleet was found.",
    "CAKEDOG's, IVY's and lo0m's launchpads pay the creator's fee straight to the Creator wallet in every trade, which production's `transfersIn` reads as a direct transfer from the buyer, so every buyer looked funded; Heat's programs never pay the creator from a trade, so transactions that called the launchpad's own program are left out of the funding links here (`launchpadTransactions` in the kept fleet).",
    "Each cell counts the fleet wallets a signal flags, and any other wallet it flags:",
    "",
    ...fleetTable(r.fleet.scores),
    "",
    "## Every wrong flag of a direct link",
    "",
    ...wrongRows(r.bundledWallets),
    "",
    "## For the known-bot list",
    "",
    `The known-bot list keys on wallets that bought in the first 2 seconds of 3 or more launches (spec 8); this set holds the creation slot only.`,
    `${n(r.repeatBuyers.wallets)} wallets bought in the creation slot of 3 or more of the ${n(r.read)} launches (${n(r.repeatBuyers.buys)} launches between them), and ${n(r.repeatBuyers.everInBundle)} of them ever sat in a creation's bundle, which a threshold would mark as bots.`,
    "The kept set, `tests/radar-eval/data/set.jsonl`, holds every creation-slot buy with its signers, block position and Jito bundle, to tune the thresholds against.",
    "",
    "## Method and limits",
    "",
    "- Reads only Solana's public mainnet endpoint (`api.mainnet-beta.solana.com`, about 10 calls of a method each 10 seconds) and Jito's public bundle API, with no key, no paid archive and no transaction.",
    "- The launch list comes from the history of pump.fun's mint authority, an account of every `create` and `create_v2`; each launch's block is read once with account details, which gives the creation's place, every later transaction in the slot, its signers and its token balances.",
    "- A buy is a later transaction in the creation slot in which the bonding curve's balance of the coin fell and a wallet's rose; that wallet is the buyer, as the indexer's trade event names the trader on Heat.",
    "- The Creator wallet is the creation's fee payer, the wallet that made and paid for the launch (Bitquery's \"dev\"); its own buys are left out, as production leaves them out of a case.",
    "- The ground truth is Jito's bundle record (`/api/v1/bundles/bundle/<id>`): a wallet is in the bundle when one of its creation-slot buys is among the bundle's transactions.",
    "  A wallet outside the bundle is counted wrong for any signal that flags it, even where it may be the creator's by another route, so every such flag is listed above.",
    "- The funding window is 7 days either side of the open, as production's, read 8 or more days after the launches so the days after are complete.",
    "  Production reads the Creator wallet's whole history; here, to stay within the free tier, each account's history over the day and the 7 days either side is listed once (up to 16,000 signatures), and the transactions read are those both the Creator wallet's and the buyer's histories hold, where one side is too busy to list, the other side's whole window is the candidates when it holds 200 transactions or fewer, and otherwise the wallet is unread.",
    "  Candidates are read with production's `transfersIn`, nearest the open first, where a bundle's funding and its proceeds sit, and stop at the first direct transfer, since one settles the flag; at most 25 a wallet on a bundled launch and 8 on another, as the free tier serves about one transaction a second.",
    "  A wallet left unsettled counts as unflagged.",
    "  A direct SOL transfer names both wallets; a token transfer names the buyer only when the buyer is its authority or its account is made in it, so the Creator wallet sending tokens into a buyer's existing account is the one kind of link this can miss.",
    "- Mainnet now carries version 1 transactions, which a read must allow (`maxSupportedTransactionVersion: 1`); production's devnet reads ask for version 0.",
    "",
    "## Rerun",
    "",
    "`pnpm --filter @top-pad/tests-radar-eval evaluate` reads whatever the kept set lacks, then scores and rewrites this report; `--refetch` reads every launch and the fleet again, the launch list kept, so the same launches are measured.",
    "A whole run from nothing takes about four hours on the free tier, the fleet about two of them, and a stopped run goes on where it stopped.",
    "",
  ];
  return lines.join("\n");
}
