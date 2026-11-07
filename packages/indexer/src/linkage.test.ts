import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, walletFundings, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { DatedSignature, FundingSource, ParsedTransaction } from "./funding";
import { BUSY_HISTORY, firstFunding, FundingUnreadable, traceFunding } from "./linkage";

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
  await db.delete(walletFundings);
});

const SYSTEM = "11111111111111111111111111111111";
const NOW = 1_800_000_000_000;

/**
 * A faked chain of plain SOL transfers: each wallet's history, newest first as the node lists it, and every transfer a
 * transaction. `pad` gives a wallet that much more history, which a busy wallet has.
 */
class Chain {
  private history = new Map<string, DatedSignature[]>();
  private txs = new Map<string, ParsedTransaction>();
  readonly unserved = new Set<string>();
  readonly listed: string[] = [];
  readonly fetched: string[] = [];
  private n = 0;

  send(from: string, to: string, lamports: number) {
    const signature = `tx${++this.n}`;
    const at = 1_700_000_000 + this.n;
    for (const wallet of [from, to]) this.list(wallet).unshift({ signature, slot: this.n, failed: false, blockTime: at });
    this.txs.set(signature, {
      slot: this.n,
      blockTime: at,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: from, signer: true }, { pubkey: to }],
          instructions: [{ programId: SYSTEM, program: "system", parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }],
        },
      },
      meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
    });
    return signature;
  }

  /** Funds `to` from `from` through `hops` single-use wallets, each forwarding all but a fee. */
  through(from: string, to: string, hops: number, lamports = 1_000_000_000) {
    let at = from;
    for (let i = 0; i < hops; i++) {
      const hop = `${to}-hop${i}`;
      this.send(at, hop, lamports - i * 5_000);
      at = hop;
    }
    this.send(at, to, lamports - hops * 5_000);
  }

  pad(wallet: string, count: number) {
    for (let i = 0; i < count; i++) this.list(wallet).unshift({ signature: `${wallet}-busy${i}`, slot: 0, failed: false, blockTime: null });
  }

  private list(wallet: string) {
    if (!this.history.has(wallet)) this.history.set(wallet, []);
    return this.history.get(wallet)!;
  }

  readonly source: FundingSource = {
    listSignatures: async (account, { limit }) => {
      this.listed.push(account);
      return (this.history.get(account) ?? []).slice(0, limit);
    },
    fetchParsed: async (signature) => {
      if (this.unserved.has(signature)) return null;
      this.fetched.push(signature);
      return this.txs.get(signature) ?? null;
    },
  };
}

const NO_HUBS = new Set<string>();

describe("the linkage pipeline", () => {
  it("ties five wallets funded from one source, directly and through hop wallets, to that source", async () => {
    const c = new Chain();
    // The source was funded by a busy wallet, an exchange's or a faucet's, which ties nobody.
    c.pad("Exchange", BUSY_HISTORY);
    c.send("Exchange", "Source", 6_000_000_000);
    c.send("Source", "W1", 1_000_000_000);
    c.send("Source", "W2", 1_000_000_000);
    c.through("Source", "W3", 1);
    c.through("Source", "W4", 2);
    c.through("Source", "W5", 3);

    const traces = await Promise.all(["W1", "W2", "W3", "W4", "W5"].map((w) => traceFunding(db, c.source, w, NO_HUBS, NOW)));
    expect(traces.map((t) => t.root)).toEqual(["Source", "Source", "Source", "Source", "Source"]);
    // W5's chain runs through its three hops, each a pass-through, to the source; the exchange stops it.
    const w5 = traces[4]!;
    expect(w5.chain.map((s) => [s.wallet, s.funder, s.passThrough])).toEqual([
      ["W5", "W5-hop2", true],
      ["W5-hop2", "W5-hop1", true],
      ["W5-hop1", "W5-hop0", true],
      ["W5-hop0", "Source", false],
    ]);
    expect(w5.chain[0]).toMatchObject({ amount: "999985000", signature: expect.stringMatching(/^tx\d+$/) });
    expect(w5.funders).toEqual(["W5-hop2", "W5-hop1", "W5-hop0", "Source", "Exchange"]);
    // The source is its own root, so it is the same person as the wallets it funded.
    expect((await traceFunding(db, c.source, "Source", NO_HUBS, NOW)).root).toBe("Source");
  });

  it("never ties two wallets through a hub: a busy wallet, or one named as a hub", async () => {
    const c = new Chain();
    c.pad("Exchange", BUSY_HISTORY);
    c.send("Exchange", "Alice", 1);
    c.send("Exchange", "Bob", 1);
    c.send("Faucet", "Carol", 1);
    c.send("Faucet", "Dave", 1);
    for (const wallet of ["Alice", "Bob"]) expect(await traceFunding(db, c.source, wallet, NO_HUBS, NOW)).toMatchObject({ root: wallet, chain: [], funders: ["Exchange"] });
    const hubs = new Set(["Faucet"]);
    for (const wallet of ["Carol", "Dave"]) expect(await traceFunding(db, c.source, wallet, hubs, NOW)).toMatchObject({ root: wallet, chain: [], funders: ["Faucet"] });
    // Unnamed, the faucet with its two transfers is an ordinary wallet, and ties them.
    expect((await traceFunding(db, c.source, "Carol", NO_HUBS, NOW)).root).toBe("Faucet");
  });

  it("reads a busy wallet's own funding no further: it is its own root", async () => {
    const c = new Chain();
    c.send("Source", "Trader", 1);
    c.pad("Trader", BUSY_HISTORY);
    expect(await traceFunding(db, c.source, "Trader", NO_HUBS, NOW)).toEqual({ wallet: "Trader", root: "Trader", chain: [], funders: [] });
    expect(c.fetched).toEqual([]);
  });

  it("reads a first funding once, and an unfunded wallet again after a minute", async () => {
    const c = new Chain();
    c.pad("Exchange", BUSY_HISTORY);
    c.send("Exchange", "Source", 2);
    c.send("Source", "W1", 1);
    await traceFunding(db, c.source, "W1", NO_HUBS, NOW);
    await traceFunding(db, c.source, "W1", NO_HUBS, NOW + 3_600_000);
    await traceFunding(db, c.source, "W1", NO_HUBS, NOW + 48 * 3_600_000);
    expect(c.fetched).toEqual(["tx2", "tx1"]);
    // A day on, how busy it is was listed again, its funding kept.
    expect(c.listed.filter((w) => w === "W1")).toHaveLength(2);

    expect(await firstFunding(db, c.source, "Fresh", NOW)).toMatchObject({ funder: null, history: 0 });
    c.send("Source", "Fresh", 7);
    expect(await firstFunding(db, c.source, "Fresh", NOW + 30_000)).toMatchObject({ funder: null });
    expect(await firstFunding(db, c.source, "Fresh", NOW + 61_000)).toMatchObject({ funder: "Source", amount: 7n });
  });

  it("concludes nothing when the node does not serve a transaction yet", async () => {
    const c = new Chain();
    const signature = c.send("Source", "W1", 1);
    c.unserved.add(signature);
    await expect(traceFunding(db, c.source, "W1", NO_HUBS, NOW)).rejects.toBeInstanceOf(FundingUnreadable);
    expect(await db.select().from(walletFundings)).toEqual([]);
    c.unserved.clear();
    expect((await traceFunding(db, c.source, "W1", NO_HUBS, NOW)).root).toBe("Source");
  });

  it("stops at a loop", async () => {
    const c = new Chain();
    c.send("A", "B", 1);
    c.send("B", "A", 1);
    // A's first funding is from B and B's from A: the chain climbs once and stops.
    const trace = await traceFunding(db, c.source, "A", NO_HUBS, NOW);
    expect(trace.chain.map((s) => s.funder)).toEqual(["B"]);
    expect(trace.root).toBe("B");
  });
});
