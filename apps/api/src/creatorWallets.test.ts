import { generateKeyPairSigner, getBase58Encoder, getPublicKeyFromAddress, signBytes, verifySignature, type KeyPairSigner, type SignatureBytes } from "@solana/kit";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatorRecord, HandoverOffers, Me, WalletChange, WalletChangeMessage, WalletChangeRefusal } from "@top-pad/contract";
import { createDb, creatorWallets, sessions, walletChanges, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { completeRotations, ROTATION_COOLDOWN_MS } from "./creatorWallets";
import { app } from "./index";
import { Fakes, ORIGINS, testBindings, testContext } from "./test/fakes";

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
beforeEach(() => {
  fakes = new Fakes();
  fakes.xUser = { id: `${Math.floor(Math.random() * 1e12)}`, username: `creator_${Math.floor(Math.random() * 1e9)}`, name: "A Creator" };
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const request = (path: string, init: RequestInit = {}) => app.request(path, init, testBindings(url), ctx);
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith("heat_session="))
    ?.split(";")[0]!
    .split("=")
    .slice(1)
    .join("=");
const post = (path: string, body: unknown, session?: string) =>
  request(path, {
    method: "POST",
    headers: { origin: ORIGINS.web, "content-type": "application/json", ...(session ? { cookie: `heat_session=${session}` } : {}) },
    body: JSON.stringify(body),
  });
const sign = async (signer: KeyPairSigner, text: string) => Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(text))).toString("base64");
const verifies = async (wallet: string, message: string, base58: string) =>
  verifySignature(await getPublicKeyFromAddress(wallet as never), getBase58Encoder().encode(base58) as SignatureBytes, new TextEncoder().encode(message));

/** Signs `signer` in with its wallet, as the web app does; the browser's session. */
async function signIn(signer: KeyPairSigner, session?: string) {
  const asked = await post("/auth/wallet/message", { wallet: signer.address });
  const { message } = (await asked.json()) as { message: string };
  const res = await post("/auth/wallet", { wallet: signer.address, message, signature: await sign(signer, message) }, session);
  expect(res.status, await res.clone().text()).toBe(200);
  return cookieOf(res)!;
}

/** Links the stand-in's X account to the browser holding `session`. */
async function linkX(session: string) {
  const start = await request("/auth/x/start?return=/creator");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}; heat_session=${session}` } });
  expect(new URL(res.headers.get("location")!).searchParams.get("x")).toBe("linked");
}

const me = async (session: string) => Me.parse(await (await request("/me", { headers: { cookie: `heat_session=${session}` } })).json());
const recordOf = async (key: string) => CreatorRecord.parse(await (await request(`/creators/${key}`)).json());
const current = async (creatorId: string) =>
  (await db.select().from(creatorWallets).where(and(eq(creatorWallets.creatorId, creatorId), isNull(creatorWallets.endedAt))))[0];
const recordIdOf = async (wallet: string) => (await db.select().from(creatorWallets).where(and(eq(creatorWallets.wallet, wallet), isNull(creatorWallets.endedAt))))[0]?.creatorId;

/** The current Creator wallet `from` offers its record to `to`: the offer, as the API shows it. */
async function offer(from: KeyPairSigner, to: string) {
  const asked = await post("/creators/handover/message", { from: from.address, to });
  expect(asked.status, await asked.clone().text()).toBe(200);
  const { message, wallet } = WalletChangeMessage.parse(await asked.json());
  expect(wallet).toBe(from.address);
  const res = await post("/creators/handover", { wallet: from.address, message, signature: await sign(from, message) });
  expect(res.status, await res.clone().text()).toBe(201);
  return WalletChange.parse(await res.json());
}

describe("handing over a Creator wallet", () => {
  it("is offered by the old wallet and taken by the new one, both signatures over one message on the record", async () => {
    const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const session = await signIn(a);
    const record = (await recordIdOf(a.address))!;

    const offered = await offer(a, b.address);
    expect(offered).toMatchObject({ kind: "handover", status: "pending", from: a.address, to: b.address, toSignature: null });
    expect(offered.message).toContain(`Record: ${record}\nFrom: ${a.address}\nTo: ${b.address}\n`);
    expect(await verifies(a.address, offered.message, offered.fromSignature!)).toBe(true);
    // Offered for a day; nothing has changed yet.
    expect(Date.parse(offered.expiresAt!) - Date.parse(offered.requestedAt)).toBeGreaterThan(23.9 * 3600_000);
    expect((await current(record))!.wallet).toBe(a.address);
    const offers = HandoverOffers.parse(await (await request(`/creators/offers/${b.address}`)).json());
    expect(offers.offers).toEqual([{ change: offered, record: { id: record, handle: null, wallet: a.address } }]);

    const res = await post(`/creators/changes/${offered.id}/accept`, { signature: await sign(b, offered.message) });
    expect(res.status, await res.clone().text()).toBe(200);
    const taken = WalletChange.parse(await res.json());
    expect(taken).toMatchObject({ status: "completed", toSignature: expect.any(String) });
    expect(await verifies(b.address, offered.message, taken.toSignature!)).toBe(true);

    // B is the record's Creator wallet now, by the handover; A no longer is, and signs in as a new record.
    const now = await current(record);
    expect(now).toMatchObject({ wallet: b.address, via: "handover", proof: taken.toSignature, proofMessage: offered.message, changeId: offered.id });
    expect(await me(session)).toMatchObject({ creatorWallet: b.address });
    const shown = await recordOf(record);
    expect(shown.wallets.map((w) => [w.wallet, w.via, w.until === null])).toEqual([
      [a.address, "sign_in", false],
      [b.address, "handover", true],
    ]);
    expect(shown.changes).toEqual([taken]);
    expect((await recordOf(a.address)).summary.id).toBe(record);
    expect(await recordOf(b.address)).toEqual({ ...shown, servedAt: expect.any(String) });
    await signIn(b);
    expect(await recordIdOf(b.address)).toBe(record);
    await signIn(a);
    expect(await recordIdOf(a.address)).not.toBe(record);
    expect(HandoverOffers.parse(await (await request(`/creators/offers/${b.address}`)).json()).offers).toEqual([]);
  });

  it("refuses a wallet that is another record's, a wrong signer, a replay, and a message of another purpose", async () => {
    const [a, b, c] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    await signIn(a);
    await signIn(b);
    const taken = await post("/creators/handover/message", { from: a.address, to: b.address });
    expect(taken.status).toBe(409);
    expect(WalletChangeRefusal.parse(await taken.json()).code).toBe("wallet_taken");
    const stranger = await post("/creators/handover/message", { from: c.address, to: a.address });
    expect(WalletChangeRefusal.parse(await stranger.json()).code).toBe("not_the_creator_wallet");

    const { message } = WalletChangeMessage.parse(await (await post("/creators/handover/message", { from: a.address, to: c.address })).json());
    // Signed by the wrong wallet, or claimed for another: refused, and the message is still good.
    expect((await post("/creators/handover", { wallet: a.address, message, signature: await sign(c, message) })).status).toBe(400);
    expect((await post("/creators/handover", { wallet: c.address, message, signature: await sign(c, message) })).status).toBe(400);
    // A handover's message never signs a browser in.
    const asSignIn = await post("/auth/wallet", { wallet: a.address, message, signature: await sign(a, message) });
    expect(asSignIn.status).toBe(401);
    const signature = await sign(a, message);
    expect((await post("/creators/handover", { wallet: a.address, message, signature })).status).toBe(201);
    expect((await post("/creators/handover", { wallet: a.address, message, signature })).status).toBe(401);

    // One pending change at a time; the new wallet's signature must be its own over the very message.
    const pending = await post("/creators/handover/message", { from: a.address, to: (await generateKeyPairSigner()).address });
    expect(WalletChangeRefusal.parse(await pending.json()).code).toBe("pending");
    const [change] = await db.select().from(walletChanges).where(eq(walletChanges.fromWallet, a.address));
    expect((await post(`/creators/changes/${change!.id}/accept`, { signature: await sign(a, change!.message) })).status).toBe(400);
    expect((await post(`/creators/changes/${change!.id}/accept`, { signature: await sign(c, `${change!.message} `) })).status).toBe(400);
    // A sign-in message never offers a handover.
    const signInMessage = ((await (await post("/auth/wallet/message", { wallet: a.address })).json()) as { message: string }).message;
    expect((await post("/creators/handover", { wallet: a.address, message: signInMessage, signature: await sign(a, signInMessage) })).status).toBe(401);
  });

  it("lapses untaken after a day, and a lapsed offer is never taken", async () => {
    const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    await signIn(a);
    const offered = await offer(a, b.address);
    await db.update(walletChanges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(walletChanges.id, offered.id));
    const late = await post(`/creators/changes/${offered.id}/accept`, { signature: await sign(b, offered.message) });
    expect(late.status).toBe(409);
    expect(WalletChangeRefusal.parse(await late.json()).code).toBe("expired");
    expect((await recordOf(a.address)).changes[0]).toMatchObject({ id: offered.id, status: "expired" });
    // The old wallet may offer again.
    await offer(a, b.address);
  });

  it("is cancelled by the Creator wallet before the new wallet takes it", async () => {
    const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    await signIn(a);
    const offered = await offer(a, b.address);
    const asked = WalletChangeMessage.parse(await (await post(`/creators/changes/${offered.id}/cancel/message`, {})).json());
    expect(asked.wallet).toBe(a.address);
    const res = await post(`/creators/changes/${offered.id}/cancel`, { wallet: a.address, message: asked.message, signature: await sign(a, asked.message) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(WalletChange.parse(await res.json())).toMatchObject({ status: "cancelled", cancelMessage: asked.message });
    expect((await post(`/creators/changes/${offered.id}/accept`, { signature: await sign(b, offered.message) })).status).toBe(409);
  });
});

describe("rotating a lost Creator wallet through X", () => {
  /** A record signed in with `a` that linked X: its id and session, authorized at X just now. */
  async function linkedRecord(a: KeyPairSigner) {
    const session = await signIn(a);
    await linkX(session);
    return { session, record: (await recordIdOf(a.address))! };
  }

  /** The new wallet `to` signs the rotation the browser holding `session` asks for. */
  async function rotate(session: string, to: KeyPairSigner) {
    const asked = await post("/creators/rotation/message", { to: to.address }, session);
    expect(asked.status, await asked.clone().text()).toBe(200);
    const { message, wallet } = WalletChangeMessage.parse(await asked.json());
    expect(wallet).toBe(to.address);
    const res = await post("/creators/rotation", { wallet: to.address, message, signature: await sign(to, message) }, session);
    expect(res.status, await res.clone().text()).toBe(201);
    return WalletChange.parse(await res.json());
  }

  it("waits out its public 7-day cooldown, then takes effect (a shortened clock)", async () => {
    const [a, d] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const { session, record } = await linkedRecord(a);
    const rotation = await rotate(session, d);
    expect(rotation).toMatchObject({ kind: "rotation", status: "pending", from: a.address, to: d.address, xHandle: fakes.xUser.username, fromSignature: null });
    expect(rotation.message).toContain(`X account: @${fakes.xUser.username}\nFrom: ${a.address}\nTo: ${d.address}\n`);
    expect(await verifies(d.address, rotation.message, rotation.toSignature!)).toBe(true);
    const effective = Date.parse(rotation.requestedAt) + ROTATION_COOLDOWN_MS;
    expect(Date.parse(rotation.effectiveAt!)).toBe(effective);
    // Public from the start, on the record.
    expect((await recordOf(record)).changes).toEqual([rotation]);

    // A second before the 7 days end nothing moves; at the end, the new wallet is the record's.
    expect(await completeRotations(db, new Date(effective - 1000))).toEqual({ completed: 0, voided: 0 });
    expect((await current(record))!.wallet).toBe(a.address);
    expect(await completeRotations(db, new Date(effective))).toEqual({ completed: 1, voided: 0 });
    expect(await current(record)).toMatchObject({ wallet: d.address, via: "rotation", proof: rotation.toSignature, proofMessage: rotation.message, changeId: rotation.id });
    expect((await recordOf(record)).changes[0]).toMatchObject({ id: rotation.id, status: "completed" });
    expect(await completeRotations(db, new Date(effective + ROTATION_COOLDOWN_MS))).toEqual({ completed: 0, voided: 0 });
  });

  it("never takes effect once the current Creator wallet cancels it", async () => {
    const [a, d] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const { session, record } = await linkedRecord(a);
    const rotation = await rotate(session, d);
    const asked = WalletChangeMessage.parse(await (await post(`/creators/changes/${rotation.id}/cancel/message`, {})).json());
    expect(asked.wallet).toBe(a.address);
    expect(asked.message).toContain(`Change: ${rotation.id}\nCancel the rotation of the Creator wallet ${a.address} to ${d.address}.\n`);
    // Only the current Creator wallet's signature cancels it.
    expect((await post(`/creators/changes/${rotation.id}/cancel`, { wallet: d.address, message: asked.message, signature: await sign(d, asked.message) })).status).toBe(400);
    const res = await post(`/creators/changes/${rotation.id}/cancel`, { wallet: a.address, message: asked.message, signature: await sign(a, asked.message) });
    expect(res.status, await res.clone().text()).toBe(200);
    const cancelled = WalletChange.parse(await res.json());
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await verifies(a.address, asked.message, cancelled.cancelSignature!)).toBe(true);
    expect(await completeRotations(db, new Date(Date.now() + 2 * ROTATION_COOLDOWN_MS))).toEqual({ completed: 0, voided: 0 });
    expect((await current(record))!.wallet).toBe(a.address);
  });

  it("is void when its new wallet becomes another record's Creator wallet first", async () => {
    const [a, d] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const { session, record } = await linkedRecord(a);
    const rotation = await rotate(session, d);
    await signIn(d);
    expect(await completeRotations(db, new Date(Date.parse(rotation.effectiveAt!)), record)).toEqual({ completed: 0, voided: 1 });
    expect((await current(record))!.wallet).toBe(a.address);
  });

  it("needs a record that linked X, authorized at X in the last 15 minutes", async () => {
    const [a, b, d] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    expect(WalletChangeRefusal.parse(await (await post("/creators/rotation/message", { to: d.address })).json()).code).toBe("not_signed_in");
    const noX = await signIn(b);
    expect(WalletChangeRefusal.parse(await (await post("/creators/rotation/message", { to: d.address }, noX)).json()).code).toBe("no_x");
    const { session } = await linkedRecord(a);
    await db.update(sessions).set({ xAt: new Date(Date.now() - 16 * 60_000) });
    const stale = await post("/creators/rotation/message", { to: d.address }, session);
    expect(stale.status).toBe(403);
    expect(WalletChangeRefusal.parse(await stale.json()).code).toBe("x_not_recent");
    // Authorizing the record's X account again counts.
    await linkX(session);
    expect((await post("/creators/rotation/message", { to: d.address }, session)).status).toBe(200);
  });

  it("is asked for by a browser X signed in, the lost wallet nowhere near it", async () => {
    const a = await generateKeyPairSigner();
    const d = await generateKeyPairSigner();
    const { record } = await linkedRecord(a);
    // Another browser, signed in by X alone.
    const start = await request("/auth/x/start?return=/creator");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}` } });
    const session = cookieOf(res)!;
    expect((await me(session)).creatorWallet).toBe(a.address);
    const rotation = await rotate(session, d);
    expect(rotation.from).toBe(a.address);
    expect(await completeRotations(db, new Date(Date.parse(rotation.effectiveAt!)), record)).toEqual({ completed: 1, voided: 0 });
    expect((await current(record))!.wallet).toBe(d.address);
  });
});
