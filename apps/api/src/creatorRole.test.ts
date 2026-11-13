import { decompileTransactionMessage, getAddressDecoder, getBase58Decoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, WSOL_MINT } from "@top-pad/chain";
import { TRANSFER_POOL_CREATOR_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { CreatorRoleOutcome, PreparedCreatorRole } from "@top-pad/contract";
import { coins, createDb, pools, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import type { Bindings } from "./env";
import { app } from "./index";
import { dbcPool, decode, Fakes, ORIGINS, testBindings, testContext } from "./test/fakes";

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
let indexedNow: string[];
beforeEach(() => {
  fakes = new Fakes();
  indexedNow = [];
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const indexer = {
  idFromName: () => "indexer",
  get: () => ({ indexNow: async (signatures: string[]) => void indexedNow.push(...signatures) }),
} as unknown as Bindings["INDEXER"];
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { origin: ORIGINS.web, "content-type": "application/json" }, body: JSON.stringify(body) }, testBindings(url, { INDEXER: indexer }), ctx);

/** A Heat coin whose DBC creator role `holder` holds on chain. */
async function coin(holder: Address) {
  const [mint, pool] = [random(), random()];
  const config = devnet.configs!.instant;
  fakes.accounts.set(pool, dbcPool({ config, creator: holder, mint, baseVault: random(), quoteVault: random(), partnerQuoteFee: 0n, activationPoint: 1n }));
  const at = new Date();
  await db.insert(pools).values({
    pool,
    mint,
    config,
    creator: holder,
    quoteMint: WSOL_MINT,
    graduationTarget: 1n,
    startSqrtPrice: "1",
    name: "Role",
    ticker: "ROLE",
    uri: "https://turbo-gateway.com/x",
    activatedAt: at,
    createdSignature: "created",
    createdSlot: 1,
    createdAt: at,
    sqrtPrice: "1",
    quoteReserve: 0n,
  });
  await db.insert(coins).values({
    mint,
    pool,
    config,
    launchMode: "instant",
    creatorWallet: holder,
    name: "Role",
    ticker: "ROLE",
    metadataUri: "https://turbo-gateway.com/x",
    createdSignature: `created-${mint}`,
    createdSlot: 1,
    createdAt: at,
  });
  return { mint, pool, config };
}

describe("handing a coin's creator role over from the site", () => {
  it("builds DBC's transfer_pool_creator for the wallet holding the role, and only for it", async () => {
    const [holder, heir] = [random(), random()];
    const { mint, pool, config } = await coin(holder);

    const stranger = await post(`/coins/${mint}/creator-role`, { holder: heir, to: random() });
    expect(stranger.status).toBe(409);
    expect((await post(`/coins/${mint}/creator-role`, { holder, to: holder })).status).toBe(400);
    expect((await post(`/coins/${random()}/creator-role`, { holder, to: heir })).status).toBe(404);

    const res = await post(`/coins/${mint}/creator-role`, { holder, to: heir });
    expect(res.status, await res.clone().text()).toBe(200);
    const { transaction } = PreparedCreatorRole.parse(await res.json());
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(transaction).messageBytes));
    expect(message.feePayer.address).toBe(holder);
    const transfer = message.instructions.find((ix) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)!;
    expect([...transfer.data!.slice(0, 8)]).toEqual([...TRANSFER_POOL_CREATOR_DISCRIMINATOR]);
    expect(transfer.accounts!.slice(0, 4).map((a) => a.address)).toEqual([pool, config, holder, heir]);
  });

  it("settles the sent hand-over against the chain and indexes it at once", async () => {
    const signature = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
    const res = await post(`/coins/${random()}/creator-role/sent`, { signature });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(CreatorRoleOutcome.parse(await res.json())).toMatchObject({ status: "landed", error: null });
    expect(indexedNow).toEqual([signature]);
  });
});
