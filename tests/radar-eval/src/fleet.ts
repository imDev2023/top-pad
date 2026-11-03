// The second case (spec 11.5): the Cryptstarter and Harmonized operator's wallet fleet, which joined or bought its own
// five single-use launches on mainnet in October 2026, funded through exchanges and hop wallets (#29, research branch
// `research/alpha-vault-prior-art`). Every fleet wallet is the operator's, so the case measures what each signal finds
// of a fleet Jito never saw. The fleet is read from the chain by the two sweeps that gave it away: the 27 wallets that
// sent their SOL back to Cryptstarter's deployer within two minutes on 2026-10-07, and the wallets that swept SOL into
// one wallet within five minutes on 2026-10-17.
import { transfersIn, type ParsedTransaction } from "@top-pad/indexer";
import type { TransferRecord } from "./collect";
import type { JitoRecords } from "./jito";
import { signatureAt, slotAt } from "./launches";
import type { Rpc } from "./rpc";

const unix = (iso: string) => Date.parse(iso) / 1000;

/** A sweep that marks fleet wallets: every wallet that sent SOL to `to` in `[from, until]`. */
export const SWEEPS = [
  { to: "C4mpYCuYaV1YtSRnJacMxRB2kqYSu3WUoexyS9QzCrA7", from: unix("2026-10-07T13:20:00Z"), until: unix("2026-10-07T13:26:00Z"), note: "back to Cryptstarter's deployer" },
  { to: "FJeSoLmGzNvCNC55X92T9tye34gg8t35REpVXZkVyigy", from: unix("2026-10-17T21:42:00Z"), until: unix("2026-10-17T21:51:00Z"), note: "into the fleet's shared wallet" },
] as const;

/**
 * The five launches: each program's own instruction names for the creation and for a join or buy, and when trading
 * opened where it was later than the creation (the Alpha Vault pools' activation, research E3).
 */
export const FLEET_LAUNCHES = [
  { coin: "CSTARTER", program: "2nHzAKCrTNyyau8h3bMnszQohmmc4p8Ar893371JD5Hv", create: ["CreateLaunch"], join: ["Join"], openedAt: unix("2026-10-06T22:13:14Z") },
  { coin: "HMD", program: "83YHJYXu85Yj9JewVYcDAV8oXQ37Jc1MPhL73HwrWLTV", create: ["Propose"], join: ["AddVoice"], openedAt: unix("2026-10-08T01:34:33Z") },
  { coin: "CAKEDOG", program: "DBZ4kpf3auFcPspomkWsPWHr8BeSshQFU1ePcQPKgj6e", create: ["CreateToken"], join: ["Buy"], openedAt: null },
  { coin: "IVY", program: "ivy2VQCjyYEKAGT3oFx3pcyiYeAPKHeP6H6NQjG5oHb", create: ["Create"], join: ["Buy", "BuyExactSolIn"], openedAt: null },
  { coin: "lo0m", program: "8xgfMLpC1Kukf8QMdXH5z1W7VNyHYL1R4JmZ18LyufMb", create: ["Initialize"], join: ["Buy"], openedAt: null },
] as const;

export type FleetParticipant = { wallet: string; signature: string; slot: number; blockIndex: number; at: number; signers: string[]; jitoBundle: string | null };

export type FleetLaunch = {
  coin: string;
  program: string;
  creation: { signature: string; slot: number; blockIndex: number; at: number; jitoBundle: string | null };
  openedAt: number;
  creator: string;
  /** Every successful join or buy, by its fee payer. */
  participants: FleetParticipant[];
  /** The Creator wallet's direct transfers within 7 days either side of the open, read from its whole window. */
  transfers: TransferRecord[];
  /**
   * The transactions among them that called the launchpad's own program: its trades pay the creator's fee straight to
   * the Creator wallet, which Heat's programs never do, so they are no link here.
   */
  launchpadTransactions: string[];
  windowRead: number;
};

export type FleetSet = { fleet: string[]; sweeps: { to: string; note: string; wallets: number }[]; launches: FleetLaunch[] };

type Signed = { signature: string; slot: number; blockTime: number | null; err: unknown; transactionIndex?: number };

const WINDOW = 7 * 86_400;

/** Every signature of `account` in `[from, to]`, oldest first; listed from a block just after `to`. */
async function history(rpc: Rpc, account: string, from: number, to: number): Promise<Signed[]> {
  const out: Signed[] = [];
  const now = Date.now() / 1000;
  let before = to < now - 3600 ? (await signatureAt(rpc, await slotAt(rpc, to))).signature : undefined;
  for (;;) {
    const page = await rpc<Signed[]>("getSignaturesForAddress", [account, { before, limit: 1000 }]);
    out.push(...page.filter((s) => s.blockTime !== null && s.blockTime >= from && s.blockTime <= to));
    const last = page.at(-1);
    if (!last || page.length < 1000 || (last.blockTime ?? to) < from) return out.reverse();
    before = last.signature;
  }
}

const parsed = (rpc: Rpc, signature: string) =>
  rpc<(ParsedTransaction & { meta: { logMessages?: string[] | null } | null }) | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" },
  ]);

/** The names of `program`'s own top-level instructions in a transaction, from its logs. */
export function instructionsOf(logs: readonly string[], program: string): string[] {
  const names: string[] = [];
  logs.forEach((line, i) => {
    if (line !== `Program ${program} invoke [1]`) return;
    const next = logs[i + 1];
    if (next?.startsWith("Program log: Instruction: ")) names.push(next.slice("Program log: Instruction: ".length));
  });
  return names;
}

/** Whether a transaction called `program` at any depth, from its logs. */
export const callsProgram = (logs: readonly string[], program: string) => logs.some((line) => line.startsWith(`Program ${program} invoke [`));

export async function collectFleet(rpc: Rpc, jito: JitoRecords, log: (s: string) => void): Promise<FleetSet> {
  const fleet = new Set<string>();
  const sweeps: FleetSet["sweeps"] = [];
  for (const sweep of SWEEPS) {
    const wallets = new Set<string>();
    for (const s of await history(rpc, sweep.to, sweep.from, sweep.until)) {
      if (s.err !== null) continue;
      const tx = await parsed(rpc, s.signature);
      if (!tx) continue;
      for (const t of transfersIn(tx, sweep.to)) if (t.destination === sweep.to && t.asset === "SOL") wallets.add(t.source);
    }
    wallets.forEach((w) => fleet.add(w));
    sweeps.push({ to: sweep.to, note: sweep.note, wallets: wallets.size });
    log(`${wallets.size} wallets swept ${sweep.note}`);
  }

  const launches: FleetLaunch[] = [];
  for (const l of FLEET_LAUNCHES) {
    const sigs = await history(rpc, l.program, 0, Date.now() / 1000);
    let creation: FleetLaunch["creation"] | null = null;
    let creator = "";
    const participants: FleetParticipant[] = [];
    for (const s of sigs) {
      if (s.err !== null || s.blockTime === null) continue;
      const tx = await parsed(rpc, s.signature);
      if (!tx?.meta || tx.meta.err) continue;
      const names = instructionsOf(tx.meta.logMessages ?? [], l.program);
      const keys = tx.transaction.message.accountKeys;
      const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
      const at = tx.blockTime ?? s.blockTime;
      if (!creation && names.some((n) => (l.create as readonly string[]).includes(n))) {
        creation = { signature: s.signature, slot: s.slot, blockIndex: s.transactionIndex ?? -1, at, jitoBundle: await jito.bundleOf(s.signature) };
        creator = keys[0]!.pubkey;
      } else if (creation && names.some((n) => (l.join as readonly string[]).includes(n))) {
        participants.push({ wallet: keys[0]!.pubkey, signature: s.signature, slot: s.slot, blockIndex: s.transactionIndex ?? -1, at, signers, jitoBundle: null });
      }
    }
    if (!creation) throw new Error(`no ${l.create.join(" or ")} in ${l.program}'s history`);
    for (const p of participants) if (p.slot === creation.slot) p.jitoBundle = await jito.bundleOf(p.signature);
    const openedAt = l.openedAt ?? creation.at;
    const transfers: TransferRecord[] = [];
    const launchpadTransactions: string[] = [];
    const window = await history(rpc, creator, openedAt - WINDOW, openedAt + WINDOW);
    for (const s of window) {
      if (s.err !== null) continue;
      const tx = await parsed(rpc, s.signature);
      if (!tx) continue;
      const found = transfersIn(tx, creator);
      if (found.length && callsProgram(tx.meta?.logMessages ?? [], l.program)) launchpadTransactions.push(s.signature);
      for (const t of found) {
        transfers.push({ signature: s.signature, ordinal: t.ordinal, slot: s.slot, at: tx.blockTime ?? s.blockTime ?? 0, source: t.source, destination: t.destination, asset: t.asset, amount: t.amount.toString() });
      }
    }
    launches.push({ coin: l.coin, program: l.program, creation, openedAt, creator, participants, transfers, launchpadTransactions, windowRead: window.length });
    log(`${l.coin}: ${participants.length} joins or buys, ${participants.filter((p) => fleet.has(p.wallet)).length} by the fleet; the Creator wallet's window held ${window.length} transactions`);
  }
  return { fleet: [...fleet].sort(), sweeps, launches };
}
