// The keeper's steps for a Fair Open (./fairOpenKeeper), each run twice against a faked chain that moves as the real one
// would when a transaction lands: the second run of every step finds its work done and sends nothing (spec 10.2, "every
// step is safe to repeat"). The steps against the real chain are in tests/ui's full Fair Open.
import { getAddressEncoder, getBase64EncodedWireTransaction, partiallySignTransaction, type Address, type KeyPairSigner } from "@solana/kit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS, DEVNET_USDC, fairOpenLookupTableAddresses, quoteTokenAccount, seatAddress, Tier } from "@top-pad/chain";
import { PreparedLaunch } from "@top-pad/contract";
import { createDb, launches, metadataItems, protectedCoins, protectedImages, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { config, type Bindings } from "./env";
import { closeLaunchNonce, failAndRefund, finishTicker, pushSeats, readSchedule, sendOpen, SERVE_WITHIN_MS, uploadMetadata } from "./fairOpenKeeper";
import { app } from "./index";
import { findPotPda } from "@top-pad/clients/fair-open";
import { decode, Fakes, fairOpenLaunch, fairOpenSeat, lookupTableAccount, MemoryBlobs, ORIGINS, seedQuoteSettings, testBindings, testContext, testKeypair } from "./test/fakes";

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
  await seedQuoteSettings(fakes, devnet);
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
async function scheduled(o: { atOpen?: boolean; name?: string } = {}) {
  fakes.xUser = { id: `${creatorId++}`, username: "keeper_test", name: "Keeper Test" };
  const start = await request("/auth/x/start");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const linked = await request(`/auth/x/callback?state=${state}&code=c`, { headers: { cookie: `heat_x_state=${state}` } });
  const cookie = linked.headers.getSetCookie().find((c) => c.startsWith("heat_session="))!.split(";")[0]!;
  const wallet = (await testKeypair()).signer;
  const form = new FormData();
  for (const [k, v] of Object.entries({ mode: "fair_open", name: o.name ?? "Kept", ticker: `K${Math.random().toString(36).slice(2, 7).toUpperCase()}`, wallet: wallet.address })) form.set(k, v);
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

/** A console argument as a log line would show it. */
function logged(a: unknown): string {
  if (a instanceof Error) return `${a.message} ${a.stack}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a, (_, v: unknown) => (typeof v === "bigint" ? `${v}` : v));
  } catch {
    return String(a);
  }
}

/** Asks that fill a pot past its lowest rung, so it can open: 0.7 SOL. */
const OPENS: [number, Tier][] = [[60, Tier.Verified], [10, Tier.Unverified]];

describe("the keeper's steps, each run twice", { timeout: 30_000 }, () => {
  it("uploads the coin's metadata once, for a pot that can open, and records when the gateway served it", async () => {
    const s = await scheduled();
    onChain(s, 585n, { asks: OPENS });
    const first = await uploadMetadata(db, cfg(), blobs, s.launch);
    expect(first).toMatchObject({ uploaded: 2, held: null });
    expect(first.servedAfterMs.image).toBeGreaterThanOrEqual(0);
    expect(first.servedAfterMs.metadata).toBeLessThan(SERVE_WITHIN_MS);
    const items = await db.select().from(metadataItems).where(eq(metadataItems.launchId, s.row.id));
    expect(items.every((i) => i.uploadedAt !== null && i.servedAt !== null && i.servedAt >= i.uploadedAt)).toBe(true);
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toEqual({ ...first, uploaded: 0 });
    expect(fakes.uploads).toHaveLength(2);
  });

  it("keeps the coin's items back while its pot cannot open, and for good once it has failed", async () => {
    const s = await scheduled();
    onChain(s, 585n, { asks: [[1, Tier.Unverified]] });
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toMatchObject({ uploaded: 0, held: "cannot_open" });
    onChain(s, 601n, { asks: OPENS, failure: 1 });
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toMatchObject({ uploaded: 0, held: "failed" });
    // Its account closed after a failure: no coin was ever created, so no pool either.
    fakes.accounts.delete(s.launch);
    expect(await uploadMetadata(db, cfg(), blobs, s.launch)).toMatchObject({ uploaded: 0, held: "failed" });
    expect(fakes.uploads).toHaveLength(0);
  });

  it("uploads at the open, before the rung, a pot that filled in the window's last seconds", async () => {
    const s = await scheduled();
    onChain(s, 601n, { asks: OPENS });
    const opened = { mint: s.row.mint as Address, spend: 0n, spent: 0n, coins: 0n, othersLevel: 0n, unverifiedLevel: 0n, delivered: 0 };
    let uploadedFirst: number | null = null;
    fakes.onSend = () => {
      uploadedFirst = fakes.uploads.length;
      onChain(s, 601n, { asks: OPENS, opened });
    };
    expect(await sendOpen(db, cfg(), blobs, keeperKey, s.launch)).toMatchObject({ outcome: "opened" });
    expect(uploadedFirst).toBe(2);
    const items = await db.select().from(metadataItems).where(eq(metadataItems.launchId, s.row.id));
    expect(items.every((i) => i.servedAt !== null)).toBe(true);
  });

  it("names nothing of the sealed coin in its logs, from scheduling to the open, even when Turbo fails", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(logged).join(" "))),
    );
    try {
      const s = await scheduled({ name: "Wombat Hidden" });
      const ids = (await db.select().from(metadataItems).where(eq(metadataItems.launchId, s.row.id))).map((i) => i.arweaveId);
      // Turbo answers with the item's own id in its error: the keeper's errors leave it out.
      fakes.turboFails = true;
      fakes.turboFailure = (id) => `upstream unavailable for ${id}`;
      onChain(s, 585n, { asks: OPENS });
      await expect(uploadMetadata(db, cfg(), blobs, s.launch)).rejects.toThrow(/the image: upload failed with 503/);
      onChain(s, 601n, { asks: OPENS });
      const opened = { mint: s.row.mint as Address, spend: 0n, spent: 0n, coins: 0n, othersLevel: 0n, unverifiedLevel: 0n, delivered: 0 };
      fakes.onSend = () => onChain(s, 601n, { asks: OPENS, opened });
      expect(await sendOpen(db, cfg(), blobs, keeperKey, s.launch)).toMatchObject({ outcome: "opened" });
      expect(logs.some((l) => l.includes("did not go up at the open"))).toBe(true);
      for (const secret of ["Wombat Hidden", s.row.ticker, s.row.mint, s.row.metadataUri, s.row.imageUri, ...ids]) {
        for (const line of logs) expect(line).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("sends the rung the pot covers once, at the open, and measures how late it was", async () => {
    const s = await scheduled();
    onChain(s, 585n, { asks: OPENS });
    await uploadMetadata(db, cfg(), blobs, s.launch);
    const asks = OPENS;
    onChain(s, 601n, { asks });
    const opened = { mint: s.row.mint as Address, spend: 0n, spent: 0n, coins: 0n, othersLevel: 0n, unverifiedLevel: 0n, delivered: 0 };
    // The rung lands: the launch account records the open.
    fakes.onSend = () => onChain(s, 601n, { asks, opened });
    const before = fakes.sent.length;
    const first = await sendOpen(db, cfg(), blobs, keeperKey, s.launch);
    expect(first).toMatchObject({ outcome: "opened" });
    const sent = fakes.sent.slice(before);
    expect(sent).toHaveLength(1);
    // Our keeper sent the rung complete with the creator's, the keeper's and the mint key's signatures.
    expect(Object.values(sent[0]!.signatures).every((sig) => sig !== null)).toBe(true);
    const [row] = await db.select().from(launches).where(eq(launches.id, s.row.id));
    expect(row!.openSignature).toBe(first.outcome === "opened" ? first.signature : null);
    expect(row!.openSentAt).not.toBeNull();
    expect(first.outcome === "opened" && first.sentLateMs !== null && first.landedLateS !== null).toBe(true);

    expect(await sendOpen(db, cfg(), blobs, keeperKey, s.launch)).toMatchObject({ outcome: "opened", signature: row!.openSignature });
    expect(fakes.sent.length).toBe(before + 1);
  });

  it("sends nothing for a pot that cannot open, which then fails", async () => {
    const s = await scheduled();
    onChain(s, 601n, { asks: [[1, Tier.Unverified]] });
    const before = fakes.sent.length;
    expect(await sendOpen(db, cfg(), blobs, keeperKey, s.launch)).toEqual({ outcome: "cannot_open", failure: "below_lowest_rung" });
    expect(fakes.sent.length).toBe(before);
  });

  it("waits at the open for a creator who signs the rung then, and sends nothing until they have", async () => {
    const s = await scheduled({ atOpen: true });
    onChain(s, 601n, { asks: [[60, Tier.Verified]] });
    const before = fakes.sent.length;
    const open = sendOpen(db, cfg(), blobs, keeperKey, s.launch);
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

  it("refunds a failed launch in USDC into each wallet's account of it, making a missing one first", async () => {
    const s = await scheduled();
    const asks: [number, Tier][] = [[10, Tier.Unverified], [20, Tier.Scored]];
    const quote = { mint: DEVNET_USDC, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address };
    onChain(s, 700n, { minRaise: 1_000_000_000n, asks, quoteMint: quote.mint });
    // Circle's devnet USDC, an SPL Token mint: what tells the keeper the quote's token program.
    fakes.accounts.set(quote.mint, { owner: quote.tokenProgram, data: new Uint8Array(82) });
    const wallets = await Promise.all([0, 1].map(async () => (await testKeypair()).signer.address));
    const seats = await Promise.all(
      wallets.map(async (wallet) => {
        const person = crypto.getRandomValues(new Uint8Array(32));
        const seat = await seatAddress(s.launch, person);
        fakes.accounts.set(seat, fairOpenSeat({ launch: s.launch, wallet, person, tier: Tier.Scored, deposit: 100_000_000n }));
        return seat;
      }),
    );
    // The first wallet still holds the account of USDC it deposited from; the second has closed its.
    const accounts = await Promise.all(wallets.map((wallet) => quoteTokenAccount(wallet, quote)));
    fakes.accounts.set(accounts[0]!, { owner: quote.tokenProgram, data: new Uint8Array(165) });
    const before = fakes.sent.length;
    let step = 0;
    fakes.onSend = () => {
      step++;
      if (step === 1) onChain(s, 700n, { minRaise: 1_000_000_000n, asks, quoteMint: quote.mint, failure: 1 });
      if (step === 2) fakes.accounts.set(accounts[1]!, { owner: quote.tokenProgram, data: new Uint8Array(165) });
      if (step === 3) for (const seat of seats) fakes.accounts.delete(seat);
      if (step === 4) fakes.accounts.delete(s.launch);
    };
    expect(await failAndRefund(cfg(), keeperKey, s.launch)).toEqual({ marked: true, refunded: 2, closed: true });
    const [, made, refunds, close] = fakes.sent.slice(before);
    // The missing account of USDC made first, then both refunds paying into the wallets' accounts of it, out of the pot.
    expect(containsAddress(made!, accounts[1]!) && !containsAddress(made!, accounts[0]!)).toBe(true);
    const [pot] = await findPotPda({ launch: s.launch });
    for (const address of [...accounts, pot]) expect(containsAddress(refunds!, address)).toBe(true);
    expect(containsAddress(close!, pot)).toBe(true);
    expect(step).toBe(4);
  });

  it("closes the nonce to the creator once, and releases a failed launch's ticker once", async () => {
    const s = await scheduled();
    onChain(s, 700n, { failure: 0 });
    fakes.accounts.set(s.nonce, { ...fakes.accounts.get(s.nonce)!, lamports: 1_447_680n });
    fakes.onSend = () => fakes.accounts.set(s.nonce, { ...fakes.accounts.get(s.nonce)!, lamports: 0n });
    expect((await closeLaunchNonce(db, cfg(), keeperKey, s.launch)).closed).not.toBeNull();
    expect(await closeLaunchNonce(db, cfg(), keeperKey, s.launch)).toEqual({ closed: null });
    expect(s.row.tickerKey).not.toBeNull();
    expect(await finishTicker(db, s.launch)).toEqual({ protected: false, released: true });
    expect(await finishTicker(db, s.launch)).toEqual({ protected: false, released: false });
    const [row] = await db.select().from(launches).where(eq(launches.id, s.row.id));
    expect(row!.tickerKey).toBeNull();
    expect(row!.keeperDoneAt).not.toBeNull();
    expect(await db.select().from(protectedCoins).where(eq(protectedCoins.mint, s.row.mint))).toEqual([]);
  });

  it("keeps an opened launch's ticker key, protects its coin, and its image's signatures come from its own check", async () => {
    const s = await scheduled({ name: "Kept Open" });
    await db.update(launches).set({ openLandedAt: new Date() }).where(eq(launches.id, s.row.id));
    expect(await finishTicker(db, s.launch)).toEqual({ protected: true, released: false });
    expect(await finishTicker(db, s.launch)).toEqual({ protected: true, released: false });
    const [row] = await db.select().from(launches).where(eq(launches.id, s.row.id));
    expect(row!.tickerKey).toBe(s.row.tickerKey);
    expect(row!.keeperDoneAt).not.toBeNull();
    const [kept] = await db.select().from(protectedCoins).where(eq(protectedCoins.mint, s.row.mint));
    expect(kept).toMatchObject({ source: "heat", ticker: s.row.ticker, name: "Kept Open", imageUrl: s.row.imageUri, protectedUntil: null });
    const [image] = await db.select().from(protectedImages).where(eq(protectedImages.url, s.row.imageUri));
    expect(image).toMatchObject({ status: "done", sha256: s.row.imageSha256 });
    expect(image!.sscd).toHaveLength(512);
  });
});

/** Whether a transaction names an address among its static accounts. */
function containsAddress(tx: ReturnType<typeof decode>, address: Address) {
  return Buffer.from(new Uint8Array(tx.messageBytes)).includes(Buffer.from(getAddressEncoder().encode(address)));
}
