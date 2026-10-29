import {
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  partiallySignTransaction,
  verifySignature,
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDataItem } from "@top-pad/arweave";
import { CLUSTERS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS } from "@top-pad/chain";
import { parseInitializeVirtualPoolWithSplTokenInstruction } from "@top-pad/clients/dbc";
import { FEE_PROGRAM_ADDRESS, parseRegisterCoinInstruction } from "@top-pad/clients/fee";
import { LaunchRefusal, LaunchStatus, Me, PreparedLaunch } from "@top-pad/contract";
import { coins, createDb, creatorWallets, launches, protectedCoins, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { candidateKeys, FOLD_VERSION } from "@top-pad/vamp-shield";
import { app } from "./index";
import { decode, Fakes, MemoryBlobs, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";

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

/** A 1x1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

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

let fakes: Fakes;
let blobs: MemoryBlobs;
beforeEach(() => {
  fakes = new Fakes();
  blobs = new MemoryBlobs();
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const bindings = () => testBindings(url, { BLOBS: blobs, KEEPER_KEY: { get: async () => JSON.stringify(Array.from(keeper().secret)) } });
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);

/** Links an X account and returns its session cookie. */
async function linkX(user: { id: string; username: string }) {
  fakes.xUser = { ...user, name: user.username };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  const session = res.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
  return session;
}

type Coin = { name?: string; ticker?: string; wallet: Address; image?: Blob | null };

function prepare(cookie: string, coin: Coin, headers: Record<string, string> = { origin: ORIGINS.web }) {
  const form = new FormData();
  form.set("mode", "instant");
  form.set("name", coin.name ?? "Lumen");
  form.set("ticker", coin.ticker ?? "LUMEN");
  form.set("wallet", coin.wallet);
  if (coin.image !== null) form.set("image", coin.image ?? new File([PNG], "lumen.png", { type: "image/png" }));
  return request("/launches", { method: "POST", body: form, headers: { ...headers, cookie } });
}

async function signAsWallet(prepared: PreparedLaunch, wallet: KeyPairSigner) {
  return getBase64EncodedWireTransaction(await partiallySignTransaction([wallet.keyPair], decode(prepared.transaction)));
}

const submit = (cookie: string, id: string, transaction: string) =>
  request(`/launches/${id}/submit`, { method: "POST", body: JSON.stringify({ transaction }), headers: { origin: ORIGINS.web, cookie, "content-type": "application/json" } });

async function prepared(res: Response) {
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return PreparedLaunch.parse(await res.json());
}

async function refusal(res: Response) {
  return { status: res.status, ...LaunchRefusal.parse(await res.json()) };
}

const instructionsOf = (tx: Transaction) => decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)).instructions;

describe("an Instant launch", () => {
  it("is prepared as DBC's pool creation on the Instant config and the coin's registration, signed only by the mint", async () => {
    const cookie = await linkX({ id: "2001", username: "lumen_lab" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { wallet: wallet.address }));
    expect(launch.cost).toBe((fakes.balance - fakes.balanceAfter).toString());

    const tx = decode(launch.transaction);
    const instructions = instructionsOf(tx);
    const createPool = instructions.find((i) => i.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)!;
    const register = instructions.find((i) => i.programAddress === FEE_PROGRAM_ADDRESS)!;
    const pool = parseInitializeVirtualPoolWithSplTokenInstruction(createPool as never);
    expect(pool.accounts.config.address).toBe(CLUSTERS.devnet!.configs!.instant);
    expect(pool.accounts.creator.address).toBe(wallet.address);
    expect(pool.accounts.payer.address).toBe(wallet.address);
    expect(pool.accounts.baseMint.address).toBe(launch.mint);
    expect(pool.accounts.pool.address).toBe(launch.pool);
    expect(pool.data.params).toMatchObject({ name: "Lumen", symbol: "LUMEN" });
    const coin = parseRegisterCoinInstruction(register as never);
    expect(coin.accounts.launchKey.address).toBe(keeper().signer.address);
    expect(coin.accounts.payer.address).toBe(wallet.address);
    expect(coin.accounts.pool.address).toBe(launch.pool);

    // Only the mint has signed; the Creator wallet signs next, and the launch key last, at submit.
    const signatures = tx.signatures as Record<string, SignatureBytes | null>;
    expect(Object.keys(signatures)).toEqual([wallet.address, launch.mint, keeper().signer.address]);
    expect(signatures[wallet.address]).toBeNull();
    expect(signatures[keeper().signer.address]).toBeNull();
    expect(await verifySignature(await getPublicKeyFromAddress(launch.mint as Address), signatures[launch.mint]!, tx.messageBytes)).toBe(true);

    // The URI is the signed metadata item's, which names the signed image item and the creator's X.
    const [stored] = await db.select().from(launches).where(eq(launches.id, launch.id));
    expect(pool.data.params.uri).toBe(stored!.metadataUri);
    const metadata = await parseDataItem(blobs.objects.get(`launches/${launch.id}/metadata`)!);
    const image = await parseDataItem(blobs.objects.get(`launches/${launch.id}/image`)!);
    expect(metadata.valid && image.valid).toBe(true);
    expect(stored!.metadataUri).toBe(`${ORIGINS.gateway}/${metadata.id}`);
    expect(JSON.parse(new TextDecoder().decode(metadata.data))).toMatchObject({
      name: "Lumen",
      symbol: "LUMEN",
      image: `${ORIGINS.gateway}/${image.id}`,
      twitter: "https://x.com/lumen_lab",
    });
    expect(image.data).toEqual(PNG);
    expect(image.tags).toContainEqual({ name: "Content-Type", value: "image/png" });
  });

  it("is co-signed by the launch key and sent once the Creator wallet has signed, and binds that wallet to the record", async () => {
    const cookie = await linkX({ id: "2002", username: "kettle" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { name: "Kettle", ticker: "KETTLE", wallet: wallet.address }));
    const signedByWallet = await signAsWallet(launch, wallet);

    const res = await submit(cookie, launch.id, signedByWallet);
    expect(res.status).toBe(200);
    const status = LaunchStatus.parse(await res.json());
    expect(status).toMatchObject({ status: "landed", mint: launch.mint, pool: launch.pool, error: null });

    // Both items went up before the transaction, image first; the transaction went out with every signature valid.
    const [metadataRow] = await db.select().from(launches).where(eq(launches.id, launch.id));
    expect(fakes.uploads).toHaveLength(2);
    expect(`${ORIGINS.gateway}/${fakes.uploads[1]}`).toBe(metadataRow!.metadataUri);
    const sent = fakes.sent[0]!;
    expect(sent.messageBytes).toEqual(decode(launch.transaction).messageBytes);
    for (const [address, signature] of Object.entries(sent.signatures)) {
      expect(await verifySignature(await getPublicKeyFromAddress(address as Address), signature!, sent.messageBytes), address).toBe(true);
    }
    expect(status.signature).toBe(getBase58Decoder().decode(sent.signatures[wallet.address]!));

    const [coin] = await db.select().from(coins).where(eq(coins.mint, launch.mint));
    expect(coin).toMatchObject({ pool: launch.pool, launchMode: "instant", creatorWallet: wallet.address, name: "Kettle", ticker: "KETTLE", createdSlot: 4_242 });
    const [bound] = await db.select().from(creatorWallets).where(eq(creatorWallets.wallet, wallet.address));
    expect(bound).toMatchObject({ via: "first_launch", proof: status.signature, endedAt: null });
    const me = Me.parse(await (await request("/me", { headers: { cookie } })).json());
    expect(me).toMatchObject({ creatorWallet: wallet.address, launches: 1 });
  });

  it("is refused for a wallet other than the record's Creator wallet, the reason shown", async () => {
    const cookie = await linkX({ id: "2003", username: "otter" });
    const first = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "OTTER", wallet: first.address }));
    expect((await submit(cookie, launch.id, await signAsWallet(launch, first))).status).toBe(200);

    const other = (await testKeypair()).signer;
    const refused = await refusal(await prepare(cookie, { ticker: "OTTER2", wallet: other.address }));
    expect(refused).toMatchObject({ status: 403, code: "not_the_creator_wallet" });
    expect(refused.error).toContain(`${first.address.slice(0, 4)}…${first.address.slice(-4)}`);
  });

  it("is refused for a wallet that is another X account's Creator wallet", async () => {
    const owner = await linkX({ id: "2004", username: "owner" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(owner, { ticker: "OWNED", wallet: wallet.address }));
    expect((await submit(owner, launch.id, await signAsWallet(launch, wallet))).status).toBe(200);

    const someoneElse = await linkX({ id: "2005", username: "someone_else" });
    expect(await refusal(await prepare(someoneElse, { ticker: "TAKEN", wallet: wallet.address }))).toMatchObject({ status: 409, code: "wallet_taken" });
  });

  it("is refused for a ticker outside A to Z and 0 to 9, the reason shown", async () => {
    const cookie = await linkX({ id: "2006", username: "dash" });
    const refused = await refusal(await prepare(cookie, { ticker: "LU-MEN", wallet: (await testKeypair()).signer.address }));
    expect(refused).toMatchObject({ status: 422, code: "vamp_shield" });
    expect(refused.verdict?.verdicts.ticker.status).toBe("refused");
    expect(refused.error).toBe(refused.verdict?.verdicts.ticker.reason);
  });

  it("is refused for a name mixing Latin and Cyrillic, the reason shown", async () => {
    const cookie = await linkX({ id: "2007", username: "mixer" });
    // "Lumen" with a Cyrillic "е" (U+0435).
    const refused = await refusal(await prepare(cookie, { name: "Lum\u{435}n", ticker: "LUMEN", wallet: (await testKeypair()).signer.address }));
    expect(refused).toMatchObject({ status: 422, code: "vamp_shield" });
    expect(refused.verdict?.verdicts.name.reason).toMatch(/Cyrillic/);
  });

  it("is refused for a copy of a Protected coin's ticker, naming the coin", async () => {
    const keys = candidateKeys("PEPE", "Pepe");
    await db.insert(protectedCoins).values({
      mint: "PePe111111111111111111111111111111111111111",
      ticker: "PEPE",
      name: "Pepe",
      source: "coingecko_top",
      tickerStrict: keys.ticker.strict,
      tickerLoose: keys.ticker.loose,
      tickerCore: keys.ticker.core,
      nameStrict: keys.name.strict,
      nameLoose: keys.name.loose,
      nameCore: keys.name.core,
      foldVersion: FOLD_VERSION,
    });
    const cookie = await linkX({ id: "2008", username: "copier" });
    // Leetspeak and an authenticity word fold to the same core key.
    const refused = await refusal(await prepare(cookie, { name: "Frog", ticker: "P3PE2", wallet: (await testKeypair()).signer.address }));
    expect(refused).toMatchObject({ status: 422, code: "vamp_shield" });
    expect(refused.verdict?.verdicts.ticker.match?.ticker).toBe("PEPE");

    // The live check says the same as the creator types.
    const live = await request("/vamp-shield/check", { method: "POST", body: JSON.stringify({ ticker: "pepe", name: "Something else" }), headers: { origin: ORIGINS.web, "content-type": "application/json" } });
    expect(await live.json()).toMatchObject({ ticker: "PEPE", clear: false, verdicts: { ticker: { status: "refused" }, name: { status: "clear" } } });
  });

  it("is refused without a usable image", async () => {
    const cookie = await linkX({ id: "2009", username: "picture" });
    const wallet = (await testKeypair()).signer.address;
    expect(await refusal(await prepare(cookie, { wallet, image: null }))).toMatchObject({ status: 422, code: "image" });
    expect(await refusal(await prepare(cookie, { wallet, image: new File(["not an image"], "x.png") }))).toMatchObject({ status: 422, code: "image" });
    const huge = new Uint8Array(200_000);
    huge.set(PNG);
    const big = await refusal(await prepare(cookie, { wallet, image: new File([huge], "big.png") }));
    expect(big).toMatchObject({ status: 422, code: "image" });
    expect(big.error).toMatch(/96 KB/);
  });

  it("is refused before signing when the wallet cannot cover the rent", async () => {
    const cookie = await linkX({ id: "2010", username: "broke" });
    fakes.simulationError = { InstructionError: [2, { Custom: 1 }] };
    const refused = await refusal(await prepare(cookie, { wallet: (await testKeypair()).signer.address }));
    expect(refused).toMatchObject({ status: 422, code: "simulation_failed" });
    expect(refused.error).toMatch(/cannot cover the launch/);
  });

  it("needs a linked X account, and a request from the web app", async () => {
    const wallet = (await testKeypair()).signer.address;
    expect(await refusal(await prepare("heat_session=none", { wallet }))).toMatchObject({ status: 401, code: "not_linked" });
    const cookie = await linkX({ id: "2011", username: "elsewhere" });
    expect((await prepare(cookie, { wallet }, {})).status).toBe(403);
  });

  it("refuses a submitted transaction that is not the prepared one, or lacks the Creator wallet's signature", async () => {
    const cookie = await linkX({ id: "2012", username: "tamper" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "TAMPER", wallet: wallet.address }));

    const unsigned = getBase64EncodedWireTransaction(decode(launch.transaction));
    expect(await refusal(await submit(cookie, launch.id, unsigned))).toMatchObject({ status: 400, code: "signature_invalid" });

    const other = await prepared(await prepare(cookie, { ticker: "OTHER", wallet: wallet.address }));
    expect(await refusal(await submit(cookie, launch.id, await signAsWallet(other, wallet)))).toMatchObject({ status: 400, code: "transaction_changed" });
    expect(fakes.sent).toHaveLength(0);
  });

  it("is refused once its blockhash can no longer land", async () => {
    const cookie = await linkX({ id: "2013", username: "late" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "LATE", wallet: wallet.address }));
    fakes.blockHeight = fakes.lastValidBlockHeight + 1n;
    expect(await refusal(await submit(cookie, launch.id, await signAsWallet(launch, wallet)))).toMatchObject({ status: 410, code: "expired" });
    expect(fakes.sent).toHaveLength(0);
  });

  it("can be submitted again when Arweave failed, and is sent only once the metadata is up", async () => {
    const cookie = await linkX({ id: "2014", username: "retry" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "RETRY", wallet: wallet.address }));
    const signed = await signAsWallet(launch, wallet);
    fakes.turboFails = true;
    expect(await refusal(await submit(cookie, launch.id, signed))).toMatchObject({ status: 502, code: "metadata_upload_failed" });
    expect(fakes.sent).toHaveLength(0);
    fakes.turboFails = false;
    const res = await submit(cookie, launch.id, signed);
    expect(LaunchStatus.parse(await res.json()).status).toBe("landed");
    expect(fakes.sent).toHaveLength(1);
  });

  it("reports a creation transaction that failed on chain", async () => {
    const cookie = await linkX({ id: "2015", username: "failing" });
    const wallet = (await testKeypair()).signer;
    const launch = await prepared(await prepare(cookie, { ticker: "FAILS", wallet: wallet.address }));
    fakes.signatureStatus = "failed";
    const status = LaunchStatus.parse(await (await submit(cookie, launch.id, await signAsWallet(launch, wallet))).json());
    expect(status.status).toBe("failed");
    expect(status.error).toContain("6005");
    expect(await db.select().from(coins).where(eq(coins.mint, launch.mint))).toHaveLength(0);
  });
});
