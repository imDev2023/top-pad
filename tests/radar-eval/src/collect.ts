// The kept set: for each launch on the list, what Bundle Radar reads about it on mainnet, written one launch a line to
// `data/set.jsonl` as it is read, so a stopped run goes on where it stopped. Reads only Solana's public endpoint and
// Jito's public API (spec 11.5).
import { transfersIn, type ParsedTransaction } from "@top-pad/indexer";
import { launchFromBlock, type BlockTransaction } from "./block";
import type { JitoRecords } from "./jito";
import { signatureAt, slotAt, type Launch } from "./launches";
import type { Rpc } from "./rpc";

const DAY = 86_400;
/** The funding graph's reach either side of the open (spec 6.5), in seconds. */
export const WINDOW = 7 * DAY;
/**
 * The most signatures listed for one account over the list's window (the day and 7 days either side): an account busier
 * than about 1,000 transactions a day is read only as far back as this reaches.
 */
const HISTORY_PAGES = 16;
/** When one side is too busy to list, the other side's whole window is the candidates, if it holds no more than this. */
const READ_ALL = 200;
/**
 * The most transactions read for one wallet's link, nearest the open first, stopping at the first direct transfer: the
 * free tier serves about one transaction a second. More for a bundled launch, where Jito's record scores the flag.
 */
const READ_CAP_BUNDLED = 25;
const READ_CAP_UNBUNDLED = 8;

/** Each transaction's direct transfers with a Creator wallet, read once: serial launchers' buyers share them. */
const transferCache = new Map<string, Promise<TransferRecord[]>>();
function transfersOf(rpc: Rpc, s: Signed, creator: string): Promise<TransferRecord[]> {
  const key = `${s.signature}:${creator}`;
  let p = transferCache.get(key);
  if (!p) {
    p = (async () => {
      if (s.err !== null) return [];
      const tx = await rpc<ParsedTransaction | null>("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
      if (!tx) throw new Error(`the node served no transaction ${s.signature}`);
      return transfersIn(tx, creator).map((t) => ({ signature: s.signature, ordinal: t.ordinal, slot: s.slot, at: tx.blockTime ?? s.blockTime ?? 0, source: t.source, destination: t.destination, asset: t.asset, amount: t.amount.toString() }));
    })();
    p.catch(() => transferCache.delete(key));
    transferCache.set(key, p);
  }
  return p;
}

export type BuyRecord = {
  signature: string;
  blockIndex: number;
  trader: string;
  signers: string[];
  baseAmount: string;
  /** The Jito bundle it landed in, as Jito's API says, or null for none. */
  jitoBundle: string | null;
};

export type TransferRecord = { signature: string; ordinal: number; slot: number; at: number; source: string; destination: string; asset: string; amount: string };

export type FundingRecord = {
  wallet: string;
  /** Whether its link is settled: a direct transfer found, or every candidate transaction read and none held one. */
  complete: boolean;
  /** How it was read: the transactions both wallets' histories hold, or one wallet's whole window. */
  method: "shared" | "creator" | "buyer" | "unread";
  read: number;
  /** The first transaction found holding direct transfers with the Creator wallet, nearest the open; one settles the flag. */
  transfers: TransferRecord[];
};

export type LaunchRecord = Launch & {
  mint: string;
  creator: string;
  curve: string;
  tokenProgram: string;
  /** The Jito bundle the creation landed in, or null. */
  jitoBundle: string | null;
  /** The transactions of that bundle, in its order: the ground truth. */
  bundleTransactions: string[] | null;
  buys: BuyRecord[];
  funding: FundingRecord[];
};

export type SkippedRecord = Launch & { skipped: string };

type Signed = { signature: string; slot: number; blockTime: number | null; err: unknown };

/** One account's signatures over the whole list's window, newest first, and how far back the listing reached. */
type Listing = { sigs: Signed[]; reached: number };

/**
 * Every account's history over the window all the list's launches need (the day, and 7 days either side), listed once
 * and kept: serial launchers, their bundle wallets and sniper bots come back launch after launch. A listing starts from a
 * block just after the window, so a bot's later trades stay out of its pages, and stops at `HISTORY_PAGES`.
 */
export class Histories {
  private readonly cache = new Map<string, Promise<Listing>>();
  private anchor: Promise<string> | null = null;
  constructor(
    private readonly rpc: Rpc,
    readonly from: number,
    readonly to: number,
  ) {}

  /** For a list of launches made on `day` (UTC). */
  static forDay(rpc: Rpc, day: string): Histories {
    const start = Date.parse(`${day}T00:00:00Z`) / 1000;
    return new Histories(rpc, start - WINDOW, start + DAY + WINDOW);
  }

  of(account: string): Promise<Listing> {
    let p = this.cache.get(account);
    if (!p) {
      p = this.list(account);
      p.catch(() => this.cache.delete(account));
      this.cache.set(account, p);
    }
    return p;
  }

  private async list(account: string): Promise<Listing> {
    this.anchor ??= slotAt(this.rpc, this.to).then(async (slot) => (await signatureAt(this.rpc, slot)).signature);
    const sigs: Signed[] = [];
    let before = await this.anchor;
    for (let n = 0; n < HISTORY_PAGES; n++) {
      const page = await this.rpc<Signed[]>("getSignaturesForAddress", [account, { before, limit: 1000 }]);
      sigs.push(...page.filter((s) => s.blockTime !== null && s.blockTime >= this.from && s.blockTime <= this.to));
      const last = page.at(-1);
      if (!last || page.length < 1000 || (last.blockTime ?? this.to) < this.from) return { sigs, reached: this.from };
      before = last.signature;
    }
    return { sigs, reached: sigs.at(-1)?.blockTime ?? this.to };
  }
}

/** An account's signatures in `[from, to]`, and whether its listing reached back to `from`. */
async function windowOf(histories: Histories, account: string, from: number, to: number): Promise<{ sigs: Signed[]; complete: boolean }> {
  const { sigs, reached } = await histories.of(account);
  return { sigs: sigs.filter((s) => s.blockTime! >= from && s.blockTime! <= to), complete: reached <= from };
}

/** Reads one launch: its block, Jito's record of its creation and its slot's buys, and its buyers' funding links. */
export async function collectLaunch(rpc: Rpc, jito: JitoRecords, histories: Histories, launch: Launch): Promise<LaunchRecord | SkippedRecord> {
  const block = await rpc<{ transactions: BlockTransaction[] } | null>("getBlock", [
    launch.slot,
    { transactionDetails: "accounts", maxSupportedTransactionVersion: 1, rewards: false, commitment: "finalized" },
  ]);
  if (!block) return { ...launch, skipped: "the node served no block" };
  const found = launchFromBlock(block.transactions, launch.signature, launch.blockIndex);
  if ("skipped" in found) return { ...launch, ...found };

  const jitoBundle = await jito.bundleOf(launch.signature);
  const bundleTransactions = jitoBundle ? await jito.bundleTransactions(jitoBundle) : null;
  const inBundle = new Set(bundleTransactions ?? []);
  const bundles = new Map<string, string | null>();
  const buys: BuyRecord[] = [];
  for (const b of found.buys) {
    if (!bundles.has(b.signature)) bundles.set(b.signature, inBundle.has(b.signature) ? jitoBundle : await jito.bundleOf(b.signature));
    buys.push({ ...b, jitoBundle: bundles.get(b.signature)! });
  }

  // Funding links are read for the wallets the evaluation can score: every buyer of a launch whose creation Jito
  // bundled, where Jito's record says who was in the bundle, and the four positions after any other creation.
  const scored = new Set(
    buys.filter((b) => b.trader !== found.creator && (jitoBundle !== null || b.blockIndex - launch.blockIndex <= 4)).map((b) => b.trader),
  );
  const funding = scored.size ? await fundingOf(rpc, histories, launch, found.creator, [...scored], jitoBundle ? READ_CAP_BUNDLED : READ_CAP_UNBUNDLED) : [];
  return { ...launch, ...found, buys, jitoBundle, bundleTransactions, funding };
}

/**
 * Each wallet's direct transfers with the Creator wallet in the 7 days either side of the open, found by production's
 * `transfersIn`. A direct transfer of SOL names both wallets, and one of tokens names the
 * Creator wallet and the buyer when either side is its authority or the buyer's account is made in it, so the
 * transactions to read are those both histories hold; a wallet too busy to list is read from the other side's whole window when that is small.
 */
async function fundingOf(rpc: Rpc, histories: Histories, launch: Launch, creator: string, wallets: string[], readCap: number): Promise<FundingRecord[]> {
  const from = launch.at - WINDOW;
  const to = launch.at + WINDOW;
  // Closest to the open first, where a bundle's funding and its proceeds sit; one transfer settles the flag.
  const nearest = (sigs: Signed[]) => sigs.slice().sort((a, b) => Math.abs(a.blockTime! - launch.at) - Math.abs(b.blockTime! - launch.at));
  const transfersWith = async (wallet: string, sigs: Signed[]): Promise<{ transfers: TransferRecord[]; read: number; settled: boolean }> => {
    const ordered = nearest(sigs);
    let read = 0;
    for (const s of ordered.slice(0, readCap)) {
      read++;
      const found = (await transfersOf(rpc, s, creator)).filter((t) => t.source === wallet || t.destination === wallet);
      if (found.length) return { transfers: found, read, settled: true };
    }
    return { transfers: [], read, settled: read === ordered.length };
  };

  const creatorWindow = await windowOf(histories, creator, from, to);
  const records: FundingRecord[] = [];
  for (const wallet of wallets) {
    const own = await windowOf(histories, wallet, from, to);
    let method: FundingRecord["method"];
    let sigs: Signed[];
    if (creatorWindow.complete && own.complete) {
      const theirs = new Set(own.sigs.map((s) => s.signature));
      method = "shared";
      sigs = creatorWindow.sigs.filter((s) => theirs.has(s.signature));
    } else if (creatorWindow.complete && creatorWindow.sigs.length <= READ_ALL) {
      method = "creator";
      sigs = creatorWindow.sigs;
    } else if (own.complete && own.sigs.length <= READ_ALL) {
      method = "buyer";
      sigs = own.sigs;
    } else {
      records.push({ wallet, complete: false, method: "unread", read: 0, transfers: [] });
      continue;
    }
    const { transfers, read, settled } = await transfersWith(wallet, sigs);
    records.push({ wallet, complete: settled, method, read, transfers });
  }
  return records;
}
