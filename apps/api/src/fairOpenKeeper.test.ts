// The keeper's steps for a Fair Open (./fairOpenKeeper), each run twice against a faked chain that moves as the real one
// would when a transaction lands: the second run of every step finds its work done and sends nothing (spec 10.2, "every
// step is safe to repeat"). The steps against the real chain are in tests/ui's full Fair Open.
import { getAddressEncoder, getBase64EncodedWireTransaction, partiallySignTransaction, type Address, type KeyPairSigner } from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, fairOpenLookupTableAddresses, seatAddress, Tier } from "@top-pad/chain";
import { PreparedLaunch } from "@top-pad/contract";
import { createDb, launches, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { config, type Bindings } from "./env";
import { closeLaunchNonce, failAndRefund, pushSeats, readSchedule, releaseTicker, sendOpen, uploadMetadata } from "./fairOpenKeeper";
import { app } from "./index";
import { decode, Fakes, fairOpenLaunch, fairOpenSeat, lookupTableAccount, MemoryBlobs, ORIGINS, testBindings, testContext, testKeypair } from "./test/fakes";

vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { testKeypair } = await import("./test/fakes");
  const [keeper, admission] = await Promise.all([testKeypair(), testKeypair()]);
  Object.assign(globalThis, { __testKeeper: keeper, __testAdmission: admission });
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, keeper: keeper.signer.address, admission: admission.signer.address } } } };
});
type TestKey = Awaited<ReturnType<typeof testKeypair>>;
const keeper = () => (globalThis as unknown as { __testKeeper: TestKey }).__testKeeper;
const admission = () => (globalThis as unknown as { __testAdmission: TestKey }).__testAdmission;

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const devnet = CLUSTERS.devnet!;
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

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
beforeEach(async () => {
  fakes = new Fakes();
  blobs = new MemoryBlobs();
  vi.stubGlobal("fetch", fakes.fetch);
  fakes.accounts.set(devnet.lookupTable!, lookupTableAccount(await fairOpenLookupTableAddresses(devnet)));
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const keeperKey = { get: async () => JSON.stringify(Array.from(keeper().secret)) };
const bindings = (): Bindings =>
  testBindings(url, { BLOBS: blobs, KEEPER_KEY: keeperKey, ADMISSION_KEY: { get: async () => JSON.stringify(Array.from(admission().secret)) } });
const cfg = () => config(bindings());
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);

let creatorId = 5000;
/** A Fair Open scheduled through the launch service, its whole ladder signed: what the keeper's Workflow starts from. */
async function scheduled(o: { atOpen?: boolean } = {}) {
  fakes.xUser = { id: `${creatorId++}`, username: "keeper_test", name: "Keeper Test" };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const linked = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  const cookie = linked.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
  const wallet = (await testKeypair()).signer;
  const form = new FormData();
  for (const [k, v] of Object.entries({ mode: "fair_open", name: "Kept", ticker: `K${Math.random().toString(36).slice(2, 7).toUpperCase()}`, wallet: wallet.address })) form.set(k, v);
  form.set("depositsOpenAt", `${nowSeconds() + 3600n}`);
  form.set("minRaise", "0");
  form.set("teaser", "");
  form.set("image", new File([PNG], "kept.png", { type: "image/png" }));
  const launch = PreparedLaunch.parse(await (await request("/launches", { method: "POST", body: form, headers: { origin: ORIGINS.web, cookie } })).json());
  if (launch.mode !== "fair_open") throw new Error("expected a Fair Open");
  const sign = async (wire: string, signer: KeyPairSigner) => getBase64EncodedWireTransaction(await partiallySignTransaction([signer.keyPair], decode(wire)));
  const rungs = o.atOpen ? null : await Promise.all(launch.rungs.map((r) => sign(r.transaction, wallet)));
  const res = await request(`/launches/${launch.id}/submit`, {
    method: "POST",
    body: JSON.stringify({ transaction: await sign(launch.transaction, wallet), rungs }),
    headers: { origin: ORIGINS.web, "content-type": "application/json", cookie },
  });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(launches).where(eq(launches.id, launch.id));
  return { launch: launch.launch as Address, nonce: launch.nonce as Address, wallet, row: row! };
}

/** Puts the launch account on chain, `ago` seconds into its window, with the seats `asks` counts. */
function onChain(s: { launch: Address; nonce: Address; wallet: KeyPairSigner }, ago: bigint, o: Omit<Parameters<typeof fairOpenLaunch>[0], "creator" | "nonce" | "depositsOpenAt"> = {}) {
  fakes.accounts.set(s.launch, fairOpenLaunch({ creator: s.wallet.address, nonce: s.nonce, depositsOpenAt: nowSeconds() - ago, ...o }));
}

describe("the keeper's steps, each run twice", { timeout: 30_000 }, () => {
  it("uploads the coin's metadata once", async () => {
    const s = await scheduled();
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toEqual({ uploaded: 2 });
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toEqual({ uploaded: 0 });
    expect(fakes.uploads).toHaveLength(2);
  });

  it("sends the rung the pot covers once, at the open, and measures how late it was", async () => {
    const s = await scheduled();
    await uploadMetadata(db, cfg(), blobs, s.launch);
    const asks: [number, Tier][] = [[60, Tier.Verified], [10, Tier.Unverified]];
    onChain(s, 601n, { asks });
    const opened = { mint: s.row.mint as Address, spend: 0n, spent: 0n, coins: 0n, othersLevel: 0n, unverifiedLevel: 0n, delivered: 0 };
    // The rung lands: the launch account records the open.
    fakes.onSend = () => onChain(s, 601n, { asks, opened });
    const before = fakes.sent.length;
    const first = await sendOpen(db, cfg(), keeperKey, s.launch);
    expect(first).toMatchObject({ outcome: "opened" });
    const sent = fakes.sent.slice(before);
    expect(sent).toHaveLength(1);
    // Our keeper sent the rung complete with the creator's, the keeper's and the mint key's signatures.
    expect(Object.values(sent[0]!.signatures).every((sig) => sig !== null)).toBe(true);
    const [row] = await db.select().from(launches).where(eq(launches.id, s.row.id));
    expect(row!.openSignature).toBe(first.outcome === "opened" ? first.signature : null);
    expect(row!.openSentAt).not.toBeNull();
    expect(first.outcome === "opened" && first.sentLateMs !== null && first.landedLateS !== null).toBe(true);

    expect(await sendOpen(db, cfg(), keeperKey, s.launch)).toMatchObject({ outcome: "opened", signature: row!.openSignature });
    expect(fakes.sent.length).toBe(before + 1);
  });

  it("sends nothing for a pot that cannot open, which then fails", async () => {
    const s = await scheduled();
    onChain(s, 601n, { asks: [[1, Tier.Unverified]] });
    const before = fakes.sent.length;
    expect(await sendOpen(db, cfg(), keeperKey, s.launch)).toEqual({ outcome: "cannot_open", failure: "below_lowest_rung" });
    expect(fakes.sent.length).toBe(before);
  });

  it("waits at the open for a creator who signs the rung then, and sends nothing until they have", async () => {
    const s = await scheduled({ atOpen: true });
    onChain(s, 601n, { asks: [[60, Tier.Verified]] });
    const before = fakes.sent.length;
    const open = sendOpen(db, cfg(), keeperKey, s.launch);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fakes.sent.length).toBe(before);
    // The launch fails meanwhile (as at the late time): the step returns without having sent anything.
    onChain(s, 601n, { asks: [[60, Tier.Verified]], failure: 2 });
    expect(await open).toEqual({ outcome: "cannot_open", failure: "late" });
    expect(fakes.sent.length).toBe(before);
  });

  it("pushes every seat owed, 7 to a transaction, and nothing when a rerun finds them delivered", async () => {
    const s = await scheduled();
    const asks: [number, Tier][] = Array.from({ length: 9 }, () => [10, Tier.Unverified]);
    const opened = { mint: s.row.mint as Address, spend: 900_000_000n, spent: 897_000_000n, coins: 1_000_000n, othersLevel: 100_000_000n, unverifiedLevel: 100_000_000n, delivered: 0 };
    onChain(s, 700n, { asks, opened });
    const seats = await Promise.all(
      Array.from({ length: 9 }, async (_, i) => {
        const wallet = i === 0 ? s.wallet.address : (await testKeypair()).signer.address;
        const person = crypto.getRandomValues(new Uint8Array(32));
        const seat = await seatAddress(s.launch, person);
        fakes.accounts.set(seat, fairOpenSeat({ launch: s.launch, wallet, person, tier: Tier.Unverified, deposit: 100_000_000n }));
        return { seat, wallet, person };
      }),
    );
    // A push lands: every seat it names, but the creator's, is delivered.
    fakes.onSend = (tx) => {
      for (const { seat, wallet, person } of seats) {
        if (wallet !== s.wallet.address && containsAddress(tx, seat)) {
          fakes.accounts.set(seat, fairOpenSeat({ launch: s.launch, wallet, person, tier: Tier.Unverified, deposit: 100_000_000n, delivered: { spent: 1n, coins: 1n, refund: 1n } }));
        }
      }
    };
    const before = fakes.sent.length;
    expect(await pushSeats(db, cfg(), keeperKey, s.launch)).toEqual({ transactions: 2, seats: 8, remaining: 0 });
    expect(fakes.sent.length).toBe(before + 2);
    expect((await db.select().from(launches).where(eq(launches.id, s.row.id)))[0]!.deliveredAt).not.toBeNull();
    expect(await pushSeats(db, cfg(), keeperKey, s.launch)).toEqual({ transactions: 0, seats: 0, remaining: 0 });
    expect(fakes.sent.length).toBe(before + 2);
  });

  it("marks a launch that cannot open failed, refunds every seat and closes it, and does nothing again", async () => {
    const s = await scheduled();
    onChain(s, 700n, { minRaise: 1_000_000_000n, asks: [[10, Tier.Unverified], [20, Tier.Scored]] });
    const seats = await Promise.all(
      [0, 1].map(async () => {
        const person = crypto.getRandomValues(new Uint8Array(32));
        const seat = await seatAddress(s.launch, person);
        fakes.accounts.set(seat, fairOpenSeat({ launch: s.launch, wallet: (await testKeypair()).signer.address, person, tier: Tier.Scored, deposit: 100_000_000n }));
        return seat;
      }),
    );
    let step = 0;
    fakes.onSend = () => {
      step++;
      if (step === 1) onChain(s, 700n, { minRaise: 1_000_000_000n, asks: [[10, Tier.Unverified], [20, Tier.Scored]], failure: 1 });
      if (step === 2) for (const seat of seats) fakes.accounts.delete(seat);
      if (step === 3) fakes.accounts.delete(s.launch);
    };
    expect(await failAndRefund(cfg(), keeperKey, s.launch)).toEqual({ marked: true, refunded: 2, closed: true });
    expect(step).toBe(3);
    expect(await failAndRefund(cfg(), keeperKey, s.launch)).toEqual({ marked: false, refunded: 0, closed: false });
    expect(step).toBe(3);
    expect((await readSchedule(db, cfg(), s.launch)).status).toBe("gone");
  });

  it("closes the nonce to the creator once, and releases the ticker once", async () => {
    const s = await scheduled();
    onChain(s, 700n, { failure: 0 });
    fakes.accounts.set(s.nonce, { ...fakes.accounts.get(s.nonce)!, lamports: 1_447_680n });
    fakes.onSend = () => fakes.accounts.set(s.nonce, { ...fakes.accounts.get(s.nonce)!, lamports: 0n });
    expect((await closeLaunchNonce(db, cfg(), keeperKey, s.launch)).closed).not.toBeNull();
    expect(await closeLaunchNonce(db, cfg(), keeperKey, s.launch)).toEqual({ closed: null });
    expect(await releaseTicker(db, s.launch)).toEqual({ released: true });
    expect(await releaseTicker(db, s.launch)).toEqual({ released: false });
  });
});

/** Whether a transaction names an address among its static accounts. */
function containsAddress(tx: ReturnType<typeof decode>, address: Address) {
  return Buffer.from(new Uint8Array(tx.messageBytes)).includes(Buffer.from(getAddressEncoder().encode(address)));
}
