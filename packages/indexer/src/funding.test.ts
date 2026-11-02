import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, fundingScans, transfers, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { SCAN_READ_LIMIT, scanFunding, SOL, transfersIn, type DatedSignature, type FundingSource, type ParsedTransaction } from "./funding";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ParsedTransaction;
const BANK = "Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933";
const WSOL = "So11111111111111111111111111111111111111112";

describe("reading direct transfers from a parsed transaction", () => {
  it("reads lamports a wallet sent to others, and only the ones it sent or received", () => {
    // Heat's devnet bank funding two wallets in one transaction (devnet, 2026-11-02).
    const tx = fixture("parsed-bank-funding");
    expect(transfersIn(tx, BANK)).toEqual([
      { ordinal: 0, source: BANK, destination: "HBJqED5y8G1aPDrXM2JnfCs15eGx8zCAvSjcFS3b5DZf", asset: SOL, amount: 100_000_000n },
      { ordinal: 1, source: BANK, destination: "3cMSsJkKFbGugZRVhqkEksDWPAhrKpBHPvMrM8bjw2se", asset: SOL, amount: 500_000_000n },
    ]);
    // A wallet the bank funded is linked to the bank alone, never to the other wallet funded beside it.
    expect(transfersIn(tx, "HBJqED5y8G1aPDrXM2JnfCs15eGx8zCAvSjcFS3b5DZf")).toEqual([
      { ordinal: 0, source: BANK, destination: "HBJqED5y8G1aPDrXM2JnfCs15eGx8zCAvSjcFS3b5DZf", asset: SOL, amount: 100_000_000n },
    ]);
  });

  it("reads a token transfer from the sending account's authority to the receiving account's owner", () => {
    // A Fair Open's push: the launch's vault sending a depositor its coins (devnet, 2026-11-02).
    const tx = fixture("parsed-fair-open-push");
    const depositor = "3cMSsJkKFbGugZRVhqkEksDWPAhrKpBHPvMrM8bjw2se";
    expect(transfersIn(tx, depositor)).toEqual([
      { ordinal: expect.any(Number), source: "9HCp5hYXUpVqzX65cuwSkMXgvZNXVmpMCAuEomuR7Dos", destination: depositor, asset: "GhCBQxZoiGaLmQ7sge1ovhWyHWq6dT1Ai7ucgnbntWRd", amount: 75_859_231_919_046n },
    ]);
  });

  it("passes over a wallet wrapping its own SOL, into an account the transaction made and closed again", () => {
    // A quick buy: SOL wrapped into a new wrapped-SOL account, swapped, and the account closed (devnet, 2026-11-01).
    const tx = fixture("parsed-wrap-and-buy");
    const trader = "CtTS8az9D2mgkBa9SrQfi63nHZ5w9TgXLcguv7bbBid9";
    const found = transfersIn(tx, trader);
    expect(found.some((t) => t.asset === SOL)).toBe(false);
    // What is left is the swap itself, with the pool's authority on the other side.
    expect(found.map((t) => [t.source === trader ? "out" : "in", t.asset === WSOL ? "SOL" : "coin"]).sort()).toEqual([
      ["in", "coin"],
      ["out", "SOL"],
    ]);
    expect(new Set(found.map((t) => (t.source === trader ? t.destination : t.source)))).toEqual(new Set(["FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"]));
  });

  it("finds nothing in a failed transaction", () => {
    const tx = fixture("parsed-bank-funding");
    expect(transfersIn({ ...tx, meta: { ...tx.meta!, err: { InstructionError: [0, "Custom"] } } }, BANK)).toEqual([]);
  });
});

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());
beforeEach(async () => {
  await db.delete(transfers);
  await db.delete(fundingScans);
});

const CREATOR = "Cre8or1111111111111111111111111111111111111";
const DAY = 86_400;
const NOW = 1_800_000_000;

/** A wallet's history on a faked chain: each transaction the creator sending `lamports` to `to`, at `blockTime`. */
function chain(entries: { signature: string; blockTime: number; to: string; lamports: number }[]) {
  // Newest first, as the node lists them.
  const history = entries.slice().sort((a, b) => b.blockTime - a.blockTime);
  const unserved = new Set<string>();
  const fetched: string[] = [];
  const source: FundingSource = {
    async listSignatures(_account, { before, until, limit }) {
      let from = before ? history.findIndex((e) => e.signature === before) + 1 : 0;
      const to = until ? history.findIndex((e) => e.signature === until) : history.length;
      from = Math.max(from, 0);
      return history
        .slice(from, to < 0 ? history.length : to)
        .slice(0, limit)
        .map((e, i): DatedSignature => ({ signature: e.signature, slot: 1_000 + history.length - (from + i), failed: false, blockTime: e.blockTime }));
    },
    async fetchParsed(signature) {
      if (unserved.has(signature)) return null;
      fetched.push(signature);
      const e = history.find((h) => h.signature === signature)!;
      return {
        slot: 1,
        blockTime: e.blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [{ pubkey: CREATOR, signer: true }, { pubkey: e.to }],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system", parsed: { type: "transfer", info: { source: CREATOR, destination: e.to, lamports: e.lamports } } }],
          },
        },
        meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
      };
    },
  };
  return { source, unserved, fetched, history: entries };
}

const recorded = async () => (await db.select().from(transfers).orderBy(transfers.at)).map((t) => [t.destination, Number(t.amount)]);

describe("scanning a Creator wallet's history into the funding graph", () => {
  it("reads back to the floor on a first scan, then only what is newer, each transfer once", async () => {
    const c = chain([
      { signature: "old", blockTime: NOW - 9 * DAY, to: "Before", lamports: 1 },
      { signature: "a", blockTime: NOW - 2 * DAY, to: "Alice", lamports: 2 },
      { signature: "b", blockTime: NOW - DAY, to: "Bob", lamports: 3 },
    ]);
    const floor = new Date((NOW - 7 * DAY) * 1000);
    expect(await scanFunding(db, c.source, CREATOR, floor)).toEqual({ recorded: 2, read: 2, complete: true });
    expect(await recorded()).toEqual([["Alice", 2], ["Bob", 3]]);
    expect(c.fetched).toEqual(["a", "b"]);

    c.history.push({ signature: "c", blockTime: NOW, to: "Carol", lamports: 4 });
    const again = chain(c.history);
    expect(await scanFunding(db, again.source, CREATOR, floor)).toEqual({ recorded: 1, read: 1, complete: true });
    expect(again.fetched).toEqual(["c"]);
    expect(await recorded()).toEqual([["Alice", 2], ["Bob", 3], ["Carol", 4]]);
    // Nothing new: nothing fetched.
    const quiet = chain(c.history);
    expect(await scanFunding(db, quiet.source, CREATOR, floor)).toEqual({ recorded: 0, read: 0, complete: true });
    expect(quiet.fetched).toEqual([]);
  });

  it("reads further back only when a coin's window starts before what was read", async () => {
    const entries = [
      { signature: "old", blockTime: NOW - 9 * DAY, to: "Before", lamports: 1 },
      { signature: "a", blockTime: NOW - 2 * DAY, to: "Alice", lamports: 2 },
    ];
    await scanFunding(db, chain(entries).source, CREATOR, new Date((NOW - 7 * DAY) * 1000));
    const back = chain(entries);
    expect(await scanFunding(db, back.source, CREATOR, new Date((NOW - 10 * DAY) * 1000))).toEqual({ recorded: 1, read: 1, complete: true });
    expect(back.fetched).toEqual(["old"]);
    expect(await recorded()).toEqual([["Before", 1], ["Alice", 2]]);
    expect((await db.select().from(fundingScans))[0]!.coversFrom).toEqual(new Date((NOW - 10 * DAY) * 1000));
  });

  it("stops where the node does not serve a transaction yet, and goes on from there with no hole", async () => {
    const c = chain([
      { signature: "a", blockTime: NOW - 3 * DAY, to: "Alice", lamports: 2 },
      { signature: "b", blockTime: NOW - 2 * DAY, to: "Bob", lamports: 3 },
      { signature: "c", blockTime: NOW - DAY, to: "Carol", lamports: 4 },
    ]);
    c.unserved.add("b");
    const floor = new Date((NOW - 7 * DAY) * 1000);
    expect(await scanFunding(db, c.source, CREATOR, floor)).toEqual({ recorded: 1, read: 1, complete: false });
    expect(await recorded()).toEqual([["Alice", 2]]);
    c.unserved.clear();
    expect(await scanFunding(db, c.source, CREATOR, floor)).toEqual({ recorded: 2, read: 2, complete: true });
    expect(await recorded()).toEqual([["Alice", 2], ["Bob", 3], ["Carol", 4]]);
  });

  it("reads a busy wallet over several scans, each going on from where the last stopped", async () => {
    const entries = Array.from({ length: SCAN_READ_LIMIT + 5 }, (_, i) => ({ signature: `s${i}`, blockTime: NOW - DAY + i, to: `W${i}`, lamports: i + 1 }));
    const floor = new Date((NOW - 7 * DAY) * 1000);
    expect(await scanFunding(db, chain(entries).source, CREATOR, floor)).toEqual({ recorded: SCAN_READ_LIMIT, read: SCAN_READ_LIMIT, complete: false });
    const rest = chain(entries);
    expect(await scanFunding(db, rest.source, CREATOR, floor)).toEqual({ recorded: 5, read: 5, complete: true });
    expect(rest.fetched).toEqual(["s300", "s301", "s302", "s303", "s304"]);
    expect(await db.$count(transfers)).toBe(SCAN_READ_LIMIT + 5);
  });
});
