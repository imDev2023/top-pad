import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import { CLAIM_FEES_DISCRIMINATOR, findCoinRecordPda } from "@top-pad/clients/fee";
import { ClaimOutcome, CreatorEarnings, PreparedClaim } from "@top-pad/contract";
import { coins, createDb, feeClaims, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { RawTransaction } from "@top-pad/indexer";
import { app } from "./index";
import { coinRecord, dbcPool, decode, Fakes, ORIGINS, testBindings, testContext } from "./test/fakes";
import type { Bindings } from "./env";

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
const WALLET = random();

let fakes: Fakes;
let indexedNow: string[];
beforeEach(async () => {
  fakes = new Fakes();
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
  await db.delete(coins);
  await db.delete(feeClaims);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = {
  idFromName: () => "indexer",
  get: () => ({ indexNow: async (signatures: string[]) => void indexedNow.push(...signatures) }),
} as unknown as Bindings["INDEXER"];
const request = (path: string, init: RequestInit = {}) => app.request(path, init, testBindings(url, { INDEXER: indexer }), ctx);
const post = (path: string, body: unknown) =>
  request(path, { method: "POST", headers: { origin: ORIGINS.web, "content-type": "application/json" }, body: JSON.stringify(body) });

/** A pool on Heat's Instant config with its creator role held by `creator`, and its coin, listed or not. */
async function coin(o: { creator: Address; partnerQuoteFee: bigint; record: "window claimed" | "window open" | "none"; name: string }) {
  const mint = random();
  const pool = random();
  fakes.accounts.set(pool, dbcPool({ config: devnet.configs!.instant, creator: o.creator, mint, baseVault: random(), quoteVault: random(), partnerQuoteFee: o.partnerQuoteFee, activationPoint: 1_793_306_000n }));
  if (o.record !== "none") {
    fakes.accounts.set((await findCoinRecordPda({ mint }))[0], coinRecord({ mint, pool, windowClaimed: o.record === "window claimed" }));
    await db.insert(coins).values({
      mint,
      pool,
      config: devnet.configs!.instant,
      launchMode: "instant",
      creatorWallet: o.creator,
      name: o.name,
      ticker: o.name.toUpperCase(),
      metadataUri: `https://turbo-gateway.com/${o.name}`,
      imageUri: `https://turbo-gateway.com/${o.name}.png`,
      createdSignature: `created-${mint}`,
      createdSlot: 1,
      createdAt: new Date(),
    });
  }
  return { mint, pool };
}

describe("a wallet's Creator Earnings", () => {
  it("lists every Heat coin whose creator role it holds, with half of each one's partner fees once its window claim has run", async () => {
    const claimed = await coin({ creator: WALLET, partnerQuoteFee: 1_001n, record: "window claimed", name: "ember" });
    const open = await coin({ creator: WALLET, partnerQuoteFee: 9_000n, record: "window open", name: "spark" });
    await coin({ creator: WALLET, partnerQuoteFee: 777n, record: "none", name: "around" });
    await coin({ creator: random(), partnerQuoteFee: 5_000n, record: "window claimed", name: "theirs" });
    await db.insert(feeClaims).values({ signature: "earlier", eventIndex: 0, slot: 1, at: new Date(), pool: claimed.pool, mint: claimed.mint, creator: WALLET, creatorAmount: 300n, treasuryAmount: 300n });

    const res = await request(`/earnings/${WALLET}`);
    expect(res.status).toBe(200);
    const earnings = CreatorEarnings.parse(await res.json());
    expect(earnings.coins).toEqual([
      expect.objectContaining({ mint: claimed.mint, name: "ember", partnerFees: "1001", waiting: "500", windowClaimed: true, claimed: "300" }),
      // Until its window claim has run, what the pool holds may be its Tax window's, which never reaches the creator.
      expect.objectContaining({ mint: open.mint, partnerFees: "0", waiting: "0", windowClaimed: false, claimed: "0" }),
    ]);
    expect([earnings.waiting, earnings.claimed]).toEqual(["500", "300"]);
  });

  it("refuses an address that is not one", async () => {
    expect((await request("/earnings/not-a-wallet")).status).toBe(400);
  });
});

describe("a creator's claim", () => {
  it("pays exactly what the page showed, in a transaction the wallet signs and pays for", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 4_600n, record: "window claimed", name: "ember" });
    // The page showed 4,000 of partner fees; 600 more accrued before the claim.
    const res = await post(`/earnings/${WALLET}/claim`, { claims: [{ mint: ember.mint, partnerFees: "4000" }] });
    expect(res.status).toBe(200);
    const prepared = PreparedClaim.parse(await res.json());
    expect(prepared).toMatchObject({ pays: "2000", coins: [{ mint: ember.mint, pays: "2000" }] });
    expect(prepared.transactions).toHaveLength(1);

    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(prepared.transactions[0]!).messageBytes));
    expect(message.feePayer.address).toBe(WALLET);
    const claims = message.instructions.filter((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS);
    expect(claims).toHaveLength(1);
    const data = claims[0]!.data!;
    expect([...data.slice(0, 8)]).toEqual([...CLAIM_FEES_DISCRIMINATOR]);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(8, true)).toBe(4_000n);
  });

  it("is refused when the figure is gone, the window claim has not run, or the coin is not the wallet's or not Heat's", async () => {
    const ember = await coin({ creator: WALLET, partnerQuoteFee: 1_000n, record: "window claimed", name: "ember" });
    const open = await coin({ creator: WALLET, partnerQuoteFee: 9_000n, record: "window open", name: "spark" });
    const around = await coin({ creator: WALLET, partnerQuoteFee: 777n, record: "none", name: "around" });
    const theirs = await coin({ creator: random(), partnerQuoteFee: 5_000n, record: "window claimed", name: "theirs" });
    for (const [mint, partnerFees] of [
      [ember.mint, "2000"],
      [ember.mint, "1"],
      [open.mint, "9000"],
      [around.mint, "777"],
      [theirs.mint, "5000"],
    ] as const) {
      const res = await post(`/earnings/${WALLET}/claim`, { claims: [{ mint, partnerFees }] });
      expect(res.status, `${mint} ${partnerFees}`).toBe(409);
    }
    expect((await post(`/earnings/${WALLET}/claim`, { claims: [] })).status).toBe(400);
  });

  it("reports what a sent claim paid, from the fee program's own event, and indexes it at once", async () => {
    // The creator's first claim on devnet (packages/indexer's fixture): 400,000 lamports to the creator role holder.
    const landed = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/indexer/src/fixtures/creator-claim.json"), "utf8"),
    ) as RawTransaction;
    const signature = landed.transaction.signatures[0]!;
    fakes.transactions.set(signature, landed);
    const res = await post("/earnings/claims", { signatures: [signature] });
    expect(res.status).toBe(200);
    const outcome = ClaimOutcome.parse(await res.json());
    expect(outcome).toMatchObject({
      paid: "400000",
      coins: [{ mint: address("BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593"), paid: "400000" }],
      transactions: [{ signature, status: "landed", error: null }],
    });
    await settle();
    expect(indexedNow).toEqual([signature]);
  });

  it("says when a sent claim failed on chain", async () => {
    fakes.signatureStatus = "failed";
    const signature = "5".repeat(87);
    const outcome = ClaimOutcome.parse(await (await post("/earnings/claims", { signatures: [signature] })).json());
    expect(outcome.transactions[0]).toMatchObject({ status: "failed" });
    expect(outcome.paid).toBe("0");
  });
});
