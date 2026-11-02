// The funding graph (spec 6.5, 10.4): direct transfers of SOL or a token between a coin's Creator wallet and anyone, read
// from that wallet's history over the 7 days before each of its coins' opens and the 7 days after. Every direct transfer
// names the Creator wallet, so reading its history alone finds every buyer it sent to or received from, one account's
// signatures rather than every buyer's. Transfers are read from the transaction's instructions, inner ones included, so
// a transfer made through another program counts, and a multi-party transaction's other transfers do not.
import { address, createSolanaRpc, type Signature } from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { fundingScans, transfers, type Db } from "@top-pad/db";
import type { ListedSignature } from "./index";

/** An instruction as `getTransaction` answers with `encoding: "jsonParsed"`: parsed where the node knows the program. */
export type ParsedInstruction = {
  programId: string;
  program?: string;
  parsed?: { type: string; info: Record<string, unknown> } | string;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
};

type TokenBalance = { accountIndex: number; mint: string; owner?: string };

/** A confirmed transaction in the shape `getTransaction` answers with `encoding: "jsonParsed"`. */
export type ParsedTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string; signer?: boolean }[]; instructions: ParsedInstruction[] };
  };
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
};

/** One direct transfer between two wallets. */
export type Transfer = {
  /** Its place among the transaction's instructions, inner ones included, in the order they ran. */
  ordinal: number;
  source: string;
  destination: string;
  /** `SOL` for lamports, else the token's mint. */
  asset: string;
  amount: bigint;
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
export const SOL = "SOL";

const text = (v: unknown) => (typeof v === "string" ? v : null);
const whole = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/**
 * The direct transfers a transaction made that `wallet` sent or received: lamports by the System program's `transfer`,
 * and tokens by the Token programs' `transfer` and `transferChecked`, from the sending account's authority to the
 * receiving account's owner. A failed transaction moved nothing; a wallet paying itself is no link.
 */
export function transfersIn(tx: ParsedTransaction, wallet: string): Transfer[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  // Each token account's owner and mint, as the node reports them before or after the transaction.
  const accounts = new Map<string, { owner?: string; mint: string }>();
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const key = keys[b.accountIndex];
    if (key) accounts.set(key, { owner: b.owner ?? accounts.get(key)?.owner, mint: b.mint });
  }
  const inner = new Map((tx.meta.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const ordered = tx.transaction.message.instructions.flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
  // And each token account the transaction made, which a balance list leaves out when it was closed again (wrapped SOL).
  for (const ix of ordered) {
    if (!ix.parsed || typeof ix.parsed === "string") continue;
    const { type, info } = ix.parsed;
    const account = text(info.account);
    const mint = text(info.mint);
    const owner = type.startsWith("initializeAccount") ? text(info.owner) : type === "create" || type === "createIdempotent" ? text(info.wallet) : null;
    if (account && mint && owner && !accounts.has(account)) accounts.set(account, { owner, mint });
  }

  const found: Transfer[] = [];
  ordered.forEach((ix, ordinal) => {
    if (!ix.parsed || typeof ix.parsed === "string") return;
    const { type, info } = ix.parsed;
    let t: Omit<Transfer, "ordinal"> | null = null;
    if (ix.programId === SYSTEM_PROGRAM && (type === "transfer" || type === "transferWithSeed")) {
      const source = text(info.sourceBase) ?? text(info.source);
      // Lamports sent into a token account (wrapping SOL) went to its owner: a wallet wrapping its own is no transfer.
      const to = text(info.destination);
      const destination = (to && accounts.get(to)?.owner) ?? to;
      const amount = whole(info.lamports);
      if (source && destination && amount !== null) t = { source, destination, asset: SOL, amount };
    } else if (TOKEN_PROGRAMS.has(ix.programId) && (type === "transfer" || type === "transferChecked")) {
      const from = text(info.source);
      const to = text(info.destination);
      const source = text(info.authority) ?? text(info.multisigAuthority) ?? (from && accounts.get(from)?.owner) ?? null;
      const destination = (to && accounts.get(to)?.owner) ?? null;
      const mint = text(info.mint) ?? (from && accounts.get(from)?.mint) ?? (to && accounts.get(to)?.mint) ?? null;
      const amount = whole(info.amount) ?? whole((info.tokenAmount as { amount?: unknown } | undefined)?.amount);
      if (source && destination && mint && amount !== null) t = { source, destination, asset: mint, amount };
    }
    if (t && t.amount > 0n && t.source !== t.destination && (t.source === wallet || t.destination === wallet)) found.push({ ordinal, ...t });
  });
  return found;
}

/** A listed signature with its block's time, newest first as the node lists them. */
export type DatedSignature = ListedSignature & { blockTime: number | null };

/** What a funding scan reads from the chain; `rpcFundingSource` is the RPC one, and tests pass their own. */
export type FundingSource = {
  /** Up to `limit` signatures of the account, newest first, older than `before` and newer than `until`. */
  listSignatures(account: string, opts: { before?: string; until?: string; limit: number }): Promise<DatedSignature[]>;
  /** The transaction, parsed, or null when the node does not serve it yet. */
  fetchParsed(signature: string): Promise<ParsedTransaction | null>;
};

/**
 * How far apart a scan's reads go out: a scan shares the RPC with everything else Heat does, on Helius's free tier (about
 * 10 requests a second, spec 10.5), and must never crowd out a launch or a trade.
 */
const READ_SPACING_MS = 250;

/** A funding scan over a plain RPC endpoint, its reads spaced out. */
export function rpcFundingSource(rpcUrl: string): FundingSource {
  const rpc = createSolanaRpc(rpcUrl);
  let next = 0;
  const turn = async () => {
    const at = Math.max(Date.now(), next);
    next = at + READ_SPACING_MS;
    if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
  };
  return {
    async listSignatures(account, { before, until, limit }) {
      const page = await rpc
        .getSignaturesForAddress(address(account), { before: before as Signature | undefined, until: until as Signature | undefined, limit, commitment: "confirmed" })
        .send();
      return page.map((s) => ({ signature: s.signature, slot: Number(s.slot), failed: s.err !== null, blockTime: s.blockTime === null ? null : Number(s.blockTime) }));
    },
    async fetchParsed(signature) {
      await turn();
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      if (!res.ok) throw new Error(`RPC getTransaction failed: ${res.status}`);
      const body = (await res.json()) as { result: ParsedTransaction | null; error?: { message: string } };
      if (body.error) throw new Error(`RPC getTransaction failed: ${body.error.message}`);
      return body.result;
    },
  };
}

const PAGE = 1000;
/** The most signatures listed in one direction: a wallet busier than this in its window is read from where listing got. */
const LIST_LIMIT = 20 * PAGE;
/** Transactions read at once. */
const FETCH_BATCH = 2;
/**
 * The most transactions one scan reads unless told otherwise. A busier wallet, such as a test bank that funds every test
 * wallet, is read over several scans, each going on from where the last stopped; listing is cheap, one call a thousand.
 */
export const SCAN_READ_LIMIT = 300;

/**
 * Reads a wallet's history into the funding graph, from `coversFrom` to now. What it has read is one unbroken stretch,
 * from `funding_scans.covers_from` to its newest signature: each scan goes on forward from the newest, oldest first, and
 * back from the oldest, newest first, only when a coin needs history from before it. A transaction the node does not
 * serve yet, or fails to, ends that direction's reading where it is, so the stretch never has a hole; the next scan goes
 * on from there. Each transaction's transfers with the wallet are written once. Says how many transfers it wrote, how
 * many transactions it read, and whether it now covers everything from `coversFrom` to the newest it listed.
 */
export async function scanFunding(
  db: Db,
  source: FundingSource,
  wallet: string,
  coversFrom: Date,
  { maxReads = SCAN_READ_LIMIT }: { maxReads?: number } = {},
): Promise<{ recorded: number; read: number; complete: boolean }> {
  const [scan] = await db.select().from(fundingScans).where(eq(fundingScans.wallet, wallet));
  const floor = coversFrom.getTime();
  const inRange = (s: DatedSignature) => s.blockTime === null || s.blockTime * 1000 >= floor;
  let recorded = 0;
  let read = 0;
  let budget = maxReads;
  let complete = true;

  /** Lists signatures newest first from `before` (or now), down to `until` or the floor; whether it got all the way. */
  const list = async (opts: { before?: string; until?: string; toFloor: boolean }) => {
    const listed: DatedSignature[] = [];
    for (let cursor = opts.before; ; ) {
      const page = await source.listSignatures(wallet, { before: cursor, until: opts.until, limit: PAGE });
      const kept = opts.toFloor ? page.filter(inRange) : page;
      listed.push(...kept);
      if (kept.length < page.length || page.length < PAGE) return { listed, reached: true };
      if (listed.length >= LIST_LIMIT) return { listed, reached: false };
      cursor = page.at(-1)!.signature;
    }
  };

  /** Reads transactions in the order given, within the scan's budget, until one is not served; how many it read. */
  const readInOrder = async (sigs: DatedSignature[]) => {
    const take = sigs.slice(0, budget);
    for (let i = 0; i < take.length; i += FETCH_BATCH) {
      const batch = take.slice(i, i + FETCH_BATCH);
      const txs = await Promise.all(
        batch.map((s) =>
          s.failed
            ? null
            : source.fetchParsed(s.signature).catch((e) => {
                console.warn(`reading ${s.signature} for ${wallet}'s funding failed; the next scan goes on from it`, e);
                return null;
              }),
        ),
      );
      for (const [j, listed] of batch.entries()) {
        const tx = txs[j];
        if (!listed.failed && !tx) return finish(i + j);
        read++;
        const found = tx ? transfersIn(tx, wallet) : [];
        if (!found.length) continue;
        const at = new Date((tx!.blockTime ?? listed.blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
        const rows = await db
          .insert(transfers)
          .values(found.map((f) => ({ signature: listed.signature, ordinal: f.ordinal, slot: listed.slot, at, source: f.source, destination: f.destination, asset: f.asset, amount: f.amount.toString() })))
          .onConflictDoNothing()
          .returning({ ordinal: transfers.ordinal });
        recorded += rows.length;
      }
    }
    return finish(take.length);
    function finish(done: number) {
      budget -= done;
      if (done < sigs.length) complete = false;
      return done;
    }
  };

  if (!scan?.newestSignature) {
    // A first scan: back to the floor, read oldest first, so what is read reaches back to the floor unbroken.
    const { listed, reached } = await list({ toFloor: true });
    const oldestFirst = listed.slice().reverse();
    const done = await readInOrder(oldestFirst);
    if (!reached) complete = false;
    const newest = done ? oldestFirst[done - 1]! : null;
    const oldest = oldestFirst[0] ?? null;
    // A wallet with nothing in range is read to the floor all the same; one listed only partly reaches its oldest.
    const reach = reached ? coversFrom : oldest?.blockTime ? new Date(oldest.blockTime * 1000) : null;
    if (reach && (newest || listed.length === 0)) {
      const row = { newestSignature: newest?.signature ?? null, newestSlot: newest?.slot ?? null, oldestSignature: oldest?.signature ?? null, coversFrom: reach, scannedAt: new Date() };
      await db.insert(fundingScans).values({ wallet, ...row }).onConflictDoUpdate({ target: fundingScans.wallet, set: row });
    }
    return { recorded, read, complete };
  }

  // Forward: everything newer than the newest read, oldest first.
  const forward = await list({ until: scan.newestSignature, toFloor: false });
  if (!forward.reached) throw new Error(`${wallet} has more than ${LIST_LIMIT} transactions since its last funding scan`);
  const forwardOldestFirst = forward.listed.slice().reverse();
  const forwardDone = await readInOrder(forwardOldestFirst);
  const newest = forwardDone ? forwardOldestFirst[forwardDone - 1]! : null;

  // Back: further than the scan reached, when a coin's 7 days before its open start earlier; newest first, so what is
  // read joins the stretch already read.
  let reachBack: { oldest: DatedSignature | null; coversFrom: Date } | null = null;
  if (scan.coversFrom.getTime() > floor && scan.oldestSignature) {
    const back = await list({ before: scan.oldestSignature, toFloor: true });
    const backDone = await readInOrder(back.listed);
    if (!back.reached) complete = false;
    const oldest = backDone ? back.listed[backDone - 1]! : null;
    const reached = back.reached && backDone === back.listed.length ? coversFrom : oldest?.blockTime ? new Date(oldest.blockTime * 1000) : null;
    if (reached) reachBack = { oldest, coversFrom: reached };
  }

  await db
    .update(fundingScans)
    .set({
      ...(newest ? { newestSignature: newest.signature, newestSlot: newest.slot } : {}),
      ...(reachBack ? { ...(reachBack.oldest ? { oldestSignature: reachBack.oldest.signature } : {}), coversFrom: reachBack.coversFrom } : {}),
      scannedAt: sql`now()`,
    })
    .where(eq(fundingScans.wallet, wallet));
  return { recorded, read, complete };
}
