// The launch list: every pump.fun launch of one whole UTC day, listed from the history of pump.fun's mint authority, an
// account of every creation, and an even sample of them, kept in the repo so a rerun reads the same launches (the
// collector checks that each one created a coin).
import { RpcError, type Rpc } from "./rpc";

/** pump.fun's mint authority, an account of every `create` and `create_v2`. */
export const PUMP_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

export type Launch = { signature: string; slot: number; blockIndex: number; at: number };

export type LaunchList = {
  source: string;
  /** The UTC day the launches were made, `YYYY-MM-DD`. */
  day: string;
  /** Successful creations that day; the sample is spread evenly over them, in chain order. */
  creations: number;
  launches: Launch[];
};

type Signed = { signature: string; slot: number; blockTime: number | null; err: unknown; transactionIndex?: number };

/** A slot whose block was made at or just after `unix`, found by stepping on the chain's own block times. */
export async function slotAt(rpc: Rpc, unix: number): Promise<number> {
  let slot = await rpc<number>("getSlot", [{ commitment: "finalized" }]);
  for (let i = 0; i < 12; i++) {
    const time = await blockTime(rpc, slot);
    const off = unix - time;
    if (Math.abs(off) <= 2) break;
    slot += Math.round(off / 0.4);
  }
  while ((await blockTime(rpc, slot)) < unix) slot += 5;
  return slot;
}

async function blockTime(rpc: Rpc, slot: number): Promise<number> {
  for (let s = slot; ; s++) {
    try {
      const t = await rpc<number | null>("getBlockTime", [s]);
      if (t !== null) return t;
    } catch (e) {
      // A skipped slot has no block; the next one does.
      if (!(e instanceof RpcError)) throw e;
    }
  }
}

/** A signature from the block at `slot` or the first block after it, to list history back from. */
export async function signatureAt(rpc: Rpc, slot: number): Promise<{ slot: number; signature: string }> {
  for (let s = slot; ; s++) {
    try {
      const block = await rpc<{ signatures: string[] } | null>("getBlock", [s, { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1 }]);
      if (block?.signatures[0]) return { slot: s, signature: block.signatures[0] };
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
    }
  }
}

/** Every successful pump.fun creation in `[from, to)` (unix seconds), oldest first. */
export async function creationsBetween(rpc: Rpc, from: number, to: number, log: (s: string) => void = () => {}): Promise<Launch[]> {
  const anchor = await signatureAt(rpc, await slotAt(rpc, to));
  const found: Launch[] = [];
  for (let before = anchor.signature, pages = 0; ; pages++) {
    const page = await rpc<Signed[]>("getSignaturesForAddress", [PUMP_MINT_AUTHORITY, { before, limit: 1000 }]);
    for (const s of page) {
      if (s.err !== null || s.blockTime === null || s.blockTime < from || s.blockTime >= to) continue;
      if (s.transactionIndex === undefined) throw new Error(`the node gave no block index for ${s.signature}`);
      found.push({ signature: s.signature, slot: s.slot, blockIndex: s.transactionIndex, at: s.blockTime });
    }
    const last = page.at(-1);
    if (pages % 10 === 0) log(`listed back to ${last?.blockTime ? new Date(last.blockTime * 1000).toISOString() : "?"}, ${found.length} creations`);
    if (!last || page.length < 1000 || (last.blockTime ?? to) < from) break;
    before = last.signature;
  }
  return found.sort((a, b) => a.slot - b.slot || a.blockIndex - b.blockIndex);
}

/** `count` launches spread evenly over `all`, in order, so every hour of the day is in the sample. */
export function evenSample<T>(all: readonly T[], count: number): T[] {
  if (all.length <= count) return [...all];
  return Array.from({ length: count }, (_, i) => all[Math.floor(((i + 0.5) * all.length) / count)]!);
}

export async function launchList(rpc: Rpc, day: string, count: number, log?: (s: string) => void): Promise<LaunchList> {
  const from = Date.parse(`${day}T00:00:00Z`) / 1000;
  const all = await creationsBetween(rpc, from, from + 86_400, log);
  return {
    source: `successful transactions signed with pump.fun's mint authority ${PUMP_MINT_AUTHORITY}, listed by getSignaturesForAddress on Solana's public mainnet endpoint`,
    day,
    creations: all.length,
    launches: evenSample(all, count),
  };
}
