import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, FEE_PROGRAM_ADDRESS, quoteAccount } from "@top-pad/chain";
import { CLAIM_WINDOW_FEES_DISCRIMINATOR, findCoinRecordPda } from "@top-pad/clients/fee";
import { coins, createDb, indexedTransactions, windowClaims, type Db } from "@top-pad/db";
import type { RawTransaction } from "@top-pad/indexer";
import { createTestDatabase } from "@top-pad/db/testing";
import { config, type Bindings } from "./env";
import { coinRecord, dbcPool, Fakes, testBindings, testKeypair } from "./test/fakes";
import { sendWindowClaim, startKeeper, sweepWindowClaims } from "./windowClaims";

// The keeper key the cluster records is swapped for a test key: the real one lives only in Secrets Store (spec 10.3).
vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { testKeypair } = await import("./test/fakes");
  const keeper = await testKeypair();
  (globalThis as { __testKeeper?: typeof keeper }).__testKeeper = keeper;
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, keeper: keeper.signer.address } } } };
});
const keeper = () => (globalThis as { __testKeeper?: Awaited<ReturnType<typeof testKeypair>> }).__testKeeper!;

let url: string;
let drop: () => Promise<void>;
let db: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
  ({ db, close: closeDb } = createDb(url));
});
afterAll(async () => {
  await closeDb();
  await drop();
});

const devnet = CLUSTERS.devnet!;
const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
let fakes: Fakes;
beforeEach(() => {
  fakes = new Fakes();
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const keeperKey = () => ({ get: async () => JSON.stringify(Array.from(keeper().secret)) });

/** A Heat coin on chain: its pool, opened at `activationPoint`, and its record. */
async function heatCoin(o: { windowClaimed: boolean; partnerQuoteFee?: bigint }) {
  const mint = random();
  const pool = random();
  const opened = 1_793_306_000n;
  fakes.accounts.set(pool, dbcPool({ config: devnet.configs!.instant, creator: random(), mint, baseVault: random(), quoteVault: random(), partnerQuoteFee: o.partnerQuoteFee ?? 15_000_000n, activationPoint: opened }));
  fakes.accounts.set((await findCoinRecordPda({ mint }))[0], coinRecord({ mint, pool, windowClaimed: o.windowClaimed }));
  return { mint, pool, windowEndsAt: Number(opened + 60n) * 1000 };
}

describe("the window claim", () => {
  it("is sent by the keeper, paying the coin's window to the treasury's quote account", async () => {
    const cfg = config(testBindings(url));
    const coin = await heatCoin({ windowClaimed: false });
    const sent = await sendWindowClaim(cfg, keeperKey(), coin.mint);
    expect(sent.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(sent.sentLateMs).toBeGreaterThan(0);

    expect(fakes.sent).toHaveLength(1);
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(fakes.sent[0]!.messageBytes));
    expect(message.feePayer.address).toBe(keeper().signer.address);
    const [claim] = message.instructions.filter((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS);
    expect([...claim!.data!.slice(0, 8)]).toEqual([...CLAIM_WINDOW_FEES_DISCRIMINATOR]);
    const named = (claim!.accounts ?? []).map((a) => a.address);
    expect(named).toEqual(expect.arrayContaining([coin.pool, coin.mint, await quoteAccount(devnet.keys!.treasury, devnet.quote.mint)]));
  });

  it("sends nothing once the coin's window claim has run, so a step tried again is safe", async () => {
    const coin = await heatCoin({ windowClaimed: true });
    expect(await sendWindowClaim(config(testBindings(url)), keeperKey(), coin.mint)).toEqual({ signature: null, sentLateMs: null });
    expect(fakes.sent).toEqual([]);
  });

  it("throws until the coin's record is on chain, and when the claim fails, so the step tries again", async () => {
    const cfg = config(testBindings(url));
    await expect(sendWindowClaim(cfg, keeperKey(), random())).rejects.toThrow("has no CoinRecord");
    const coin = await heatCoin({ windowClaimed: false });
    fakes.signatureStatus = "failed";
    await expect(sendWindowClaim(cfg, keeperKey(), coin.mint)).rejects.toThrow(/the window claim .* failed/);
  });

  it("is done when another keeper's claim of the coin landed first", async () => {
    const coin = await heatCoin({ windowClaimed: false });
    fakes.signatureStatus = "failed";
    fakes.failedWith = 6010;
    expect(await sendWindowClaim(config(testBindings(url)), keeperKey(), coin.mint)).toEqual({ signature: null, sentLateMs: null });
  });
});

/** A stand-in for the Workflow binding: the instances made, and what was asked of each. */
function workflows(existing: Record<string, string> = {}) {
  const created: string[] = [];
  const restarted: string[] = [];
  const binding = {
    create: async ({ id }: { id: string }) => {
      if (id in existing) throw new Error(`instance ${id} already exists`);
      created.push(id);
      return { id };
    },
    get: async (id: string) => {
      if (!(id in existing)) throw new Error(`no instance ${id}`);
      return { id, status: async () => ({ status: existing[id] }), restart: async () => void restarted.push(id) };
    },
  } as unknown as NonNullable<Bindings["INSTANT_LAUNCHES"]>;
  return { binding, created, restarted };
}

describe("the keeper's Workflow", () => {
  it("starts once per coin, and starts again only if it failed", async () => {
    const w = workflows({ running: "running", done: "complete", failed: "errored" });
    const env = testBindings(url, { INSTANT_LAUNCHES: w.binding });
    for (const mint of ["new", "running", "done", "failed"]) await startKeeper(env, mint);
    expect(w.created).toEqual(["new"]);
    expect(w.restarted).toEqual(["failed"]);
  });

  it("is started by the cron for every Instant launch whose window claim has not been seen", async () => {
    const add = async (o: { launchMode: "instant" | "fair_open"; minutesAgo: number; claimed?: boolean }) => {
      const mint: Address = random();
      const pool = random();
      await db.insert(coins).values({
        mint,
        pool,
        config: devnet.configs!.instant,
        launchMode: o.launchMode,
        creatorWallet: random(),
        name: "coin",
        ticker: "COIN",
        metadataUri: "https://turbo-gateway.com/coin",
        createdSignature: `created-${mint}`,
        createdSlot: 1,
        createdAt: new Date(Date.now() - o.minutesAgo * 60_000),
      });
      if (o.claimed) {
        const at = new Date();
        await db.insert(windowClaims).values({ pool, mint, heat: true, destination: random(), amount: 1n, windowEndedAt: at, claimedAt: at, signature: `window-${mint}`, slot: 2 });
      }
      return mint;
    };
    const missed = await add({ launchMode: "instant", minutesAgo: 10 });
    await add({ launchMode: "instant", minutesAgo: 10, claimed: true });
    await add({ launchMode: "instant", minutesAgo: 1 });
    await add({ launchMode: "fair_open", minutesAgo: 10 });
    const w = workflows();
    expect(await sweepWindowClaims(db, testBindings(url, { INSTANT_LAUNCHES: w.binding }))).toEqual({ due: 1, started: 1, recorded: 0 });
    expect(w.created).toEqual([missed]);
    await db.delete(coins);
    await db.delete(windowClaims);
  });

  it("records a window claim that ran but that the indexer missed, without starting the keeper again", async () => {
    // The devnet window claim of packages/indexer's fixture, indexed by code that did not yet decode claims.
    const window = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/window-claim.json"), "utf8"),
    ) as RawTransaction;
    const signature = window.transaction.signatures[0]!;
    const mint = address("BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593");
    const pool = address("D5Wtpu6jo7a63EEWXBhxWPQQmFafbLn4wxMH5CGh7FDP");
    const record = (await findCoinRecordPda({ mint }))[0];
    fakes.accounts.set(record, coinRecord({ mint, pool, windowClaimed: true }));
    fakes.history.set(record, [signature, "registered"]);
    fakes.transactions.set(signature, window);
    await db.insert(coins).values({
      mint,
      pool,
      config: devnet.configs!.instant,
      launchMode: "instant",
      creatorWallet: random(),
      name: "coin",
      ticker: "COIN",
      metadataUri: "https://turbo-gateway.com/coin",
      createdSignature: "registered",
      createdSlot: 1,
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    await db.insert(indexedTransactions).values({ signature, slot: window.slot });

    const w = workflows();
    expect(await sweepWindowClaims(db, testBindings(url, { INSTANT_LAUNCHES: w.binding }))).toEqual({ due: 1, started: 0, recorded: 1 });
    expect(w.created).toEqual([]);
    expect(await db.select().from(windowClaims)).toEqual([expect.objectContaining({ mint, pool, amount: 15_818_667n, signature })]);
    // Recorded, the coin is no longer due.
    expect(await sweepWindowClaims(db, testBindings(url, { INSTANT_LAUNCHES: w.binding }))).toEqual({ due: 0, started: 0, recorded: 0 });
  });
});
