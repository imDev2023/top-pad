import { decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getU64Decoder, type KeyPairSigner, type Transaction } from "@solana/kit";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortRefusal, CohortStatus } from "@top-pad/contract";
import { cohortTaps, createDb, creators, creatorWallets, jobRuns, operatorAlerts, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import { settleTaps } from "./cohort";
import { config } from "./env";
import { Fakes, ORIGINS, testBindings, testContext, type XUser } from "./test/fakes";
import { signInWallet } from "./test/signIn";

// The tap key the cluster records is swapped for a test key: the real one lives only in Secrets Store (spec 10.3). The
// factory makes it with Kit alone, since importing ./test/fakes here, which imports @top-pad/chain, deadlocks the mock.
vi.mock("@top-pad/chain", async (importOriginal) => {
  const chain = await importOriginal<typeof import("@top-pad/chain")>();
  const { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } = await import("@solana/kit");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(getAddressEncoder().encode(signer.address), 32);
  (globalThis as { __testTap?: TestTap }).__testTap = { signer, secret };
  const devnet = chain.CLUSTERS.devnet!;
  return { ...chain, CLUSTERS: { ...chain.CLUSTERS, devnet: { ...devnet, keys: { ...devnet.keys!, tap: signer.address } } } };
});
type TestTap = { signer: KeyPairSigner; secret: Uint8Array };
const tap = () => (globalThis as { __testTap?: TestTap }).__testTap!;

const SOL = 1_000_000_000n;
const FLOOR = 3n * SOL;
const SYSTEM = "11111111111111111111111111111111";

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
/** The tap's balance as the fake chain holds it; each transfer sent takes its lamports and a fee off it. */
const tapHolds = (lamports: bigint) => fakes.accounts.set(tap().signer.address, { owner: SYSTEM, data: new Uint8Array(), lamports });
const tapBalance = () => fakes.accounts.get(tap().signer.address)!.lamports!;
beforeEach(() => {
  fakes = new Fakes();
  tapHolds(10n * SOL);
  fakes.onSend = (tx) => {
    const { lamports } = transfer(tx);
    tapHolds(tapBalance() - lamports - 5_000n);
  };
  vi.stubGlobal("fetch", fakes.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());
const bindings = () => testBindings(url, { TAP_KEY: JSON.stringify(Array.from(tap().secret)), TAP_FLOAT_MIN_LAMPORTS: FLOOR.toString() });
const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings(), ctx);
const post = (path: string, session?: string) => request(path, { method: "POST", headers: { origin: ORIGINS.web, ...(session ? { cookie: session } : {}) } });
const status = async (session: string) => CohortStatus.parse(await (await request("/cohort", { headers: { cookie: session } })).json());

/** What a sent transaction moves: its fee payer, and the System transfer's destination and lamports. */
function transfer(tx: Transaction) {
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  expect(message.instructions).toHaveLength(1);
  const [ix] = message.instructions;
  expect(ix!.programAddress).toBe(SYSTEM);
  const data = ix!.data!;
  expect(new DataView(data.buffer, data.byteOffset).getUint32(0, true)).toBe(2);
  return { payer: message.feePayer.address, to: ix!.accounts![1]!.address, lamports: getU64Decoder().decode(data, 4) };
}

let xId = 5_000;
/** A browser signed in with a new wallet, and with an X account linked when `x` is given. */
async function member(x?: Partial<XUser>): Promise<{ signer: KeyPairSigner; session: string }> {
  const signer = await generateKeyPairSigner();
  const session = await signInWallet(request, signer);
  if (x) {
    xId += 1;
    fakes.xUser = { id: `${xId}`, username: `cohort_${xId}`, name: `Cohort ${xId}`, ...x };
    const start = await request("/auth/x/start?return=/cohort", { headers: { cookie: session } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await request(`/auth/x/callback?state=${state}&code=the-code`, { headers: { cookie: `heat_x_state=${state}; ${session}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("x=linked");
  }
  return { signer, session };
}

describe("the cohort tap", () => {
  it("gives a member who linked X 1 SOL once, and refuses the second tap", async () => {
    const { signer, session } = await member({});
    const res = await post("/cohort/tap", session);
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = CohortStatus.parse(await res.json());
    expect(answer).toMatchObject({ member: true, creatorWallet: signer.address, tap: { wallet: signer.address, lamports: SOL.toString(), status: "sent" } });

    expect(fakes.sent).toHaveLength(1);
    expect(transfer(fakes.sent[0]!)).toEqual({ payer: tap().signer.address, to: signer.address, lamports: SOL });
    const [row] = await db.select().from(cohortTaps).where(eq(cohortTaps.wallet, signer.address));
    expect(row).toMatchObject({ status: "sent", lamports: SOL, signature: answer.tap!.signature });

    const again = await post("/cohort/tap", session);
    expect(again.status).toBe(409);
    expect(CohortRefusal.parse(await again.json())).toMatchObject({ code: "claimed", tap: { signature: answer.tap!.signature } });
    expect(fakes.sent).toHaveLength(1);
    expect(await status(session)).toMatchObject({ member: true, tap: { status: "sent" } });
  });

  it("gives a wallet without a linked X account nothing, though it may join the cohort", async () => {
    const { session } = await member();
    const res = await post("/cohort/tap", session);
    expect(res.status).toBe(403);
    expect(CohortRefusal.parse(await res.json()).code).toBe("x_required");
    expect(fakes.sent).toHaveLength(0);
    expect(await db.select().from(cohortTaps)).not.toContainEqual(expect.objectContaining({ xHandle: null }));
    expect(await status(session)).toMatchObject({ member: false, xHandle: null, tap: null });

    const joined = await post("/cohort/join", session);
    expect(joined.status).toBe(200);
    expect(CohortStatus.parse(await joined.json())).toMatchObject({ member: true, tap: null, tapOpen: true });
    expect((await post("/cohort/join", session)).status).toBe(200);
    expect(fakes.sent).toHaveLength(0);
  });

  it("refuses a signed-out browser", async () => {
    expect(await (await request("/cohort")).json()).toBeNull();
    const res = await post("/cohort/tap");
    expect(res.status).toBe(401);
    expect(CohortRefusal.parse(await res.json()).code).toBe("signed_out");
    expect((await post("/cohort/join")).status).toBe(401);
  });

  it("frees the claim when the transfer fails on chain, and pays on the next tap", async () => {
    const { signer, session } = await member({});
    fakes.signatureStatus = "failed";
    const failed = await post("/cohort/tap", session);
    expect(failed.status).toBe(502);
    expect(CohortRefusal.parse(await failed.json()).code).toBe("tap_failed");
    expect((await db.select().from(cohortTaps).where(eq(cohortTaps.wallet, signer.address))).map((r) => r.status)).toEqual(["failed"]);

    fakes.signatureStatus = "confirmed";
    const paid = await post("/cohort/tap", session);
    expect(paid.status, await paid.clone().text()).toBe(200);
    expect((await db.select().from(cohortTaps).where(eq(cohortTaps.wallet, signer.address))).map((r) => r.status).sort()).toEqual(["failed", "sent"]);
  });

  it("raises its low-balance alert while it can still pay, before it runs dry", async () => {
    await db.delete(operatorAlerts);
    tapHolds(4n * SOL + SOL / 2n);
    const open = () => db.select().from(operatorAlerts).where(eq(operatorAlerts.kind, "tap_low_balance"));

    expect((await post("/cohort/tap", (await member({})).session)).status).toBe(200);
    expect(await open()).toEqual([]);

    // 2.5 SOL left after the second: below the 3 SOL floor, with two members still to pay.
    expect((await post("/cohort/tap", (await member({})).session)).status).toBe(200);
    const [alert] = await open();
    expect(alert).toMatchObject({ subject: tap().signer.address, resolvedAt: null });
    // The tap's own reading is recorded as it leaves, for the operator's page.
    const [reading] = await db.select().from(jobRuns).where(eq(jobRuns.job, "cohort-tap-float")).orderBy(desc(jobRuns.finishedAt)).limit(1);
    expect(reading).toMatchObject({ status: "succeeded", summary: { float: { lamports: "2499990000", low: true, claimsLeft: 2 } } });
    expect(alert!.message).toContain("holds 2.500 SOL, below its 3.000 SOL floor: 2 more members can be paid");

    expect((await post("/cohort/tap", (await member({})).session)).status).toBe(200);
    expect((await post("/cohort/tap", (await member({})).session)).status).toBe(200);
    // About 0.5 SOL left: too little to pay anyone, and the claim is not taken.
    const { signer, session } = await member({});
    const dry = await post("/cohort/tap", session);
    expect(dry.status).toBe(503);
    expect(CohortRefusal.parse(await dry.json()).code).toBe("tap_empty");
    expect(await db.select().from(cohortTaps).where(eq(cohortTaps.wallet, signer.address))).toEqual([]);
    expect(await status(session)).toMatchObject({ tapOpen: false, tap: null });
    expect((await open())[0]!.message).toContain("0 more members can be paid");

    // Topped up, the cron's check resolves it.
    tapHolds(20n * SOL);
    const run = await settleTaps(db, config(bindings()), bindings());
    expect(run).toMatchObject({ float: { low: false, claimsLeft: 19 } });
    expect((await open())[0]!.resolvedAt).not.toBeNull();
  });

  it("settles a transfer still in flight from its signature: landed, or expired unlanded and freed", async () => {
    const landed = await member({});
    fakes.signatureStatus = "none";
    // A tap whose request ended before its transfer confirmed: written and sent, not yet settled.
    const signature = (n: number) => `${n}`.padStart(88, "1");
    const pending = async (who: KeyPairSigner, n: number, lastValidBlockHeight: bigint) => {
      const [record] = await db
        .select({ id: creators.id, xUserId: creators.xUserId, xHandle: creators.xHandle })
        .from(creatorWallets)
        .innerJoin(creators, eq(creators.id, creatorWallets.creatorId))
        .where(and(eq(creatorWallets.wallet, who.address), isNull(creatorWallets.endedAt)));
      await db.insert(cohortTaps).values({ creatorId: record!.id, xUserId: record!.xUserId!, xHandle: record!.xHandle!, wallet: who.address, lamports: SOL, signature: signature(n), lastValidBlockHeight });
    };
    await pending(landed.signer, 1, 2_000n);
    const expired = await member({});
    await pending(expired.signer, 2, 100n);

    expect(await settleTaps(db, config(bindings()), bindings())).toMatchObject({ sent: 0, failed: 1, waiting: 1 });
    const statusOf = async (who: KeyPairSigner) => (await db.select().from(cohortTaps).where(eq(cohortTaps.wallet, who.address)))[0]!;
    expect(await statusOf(expired.signer)).toMatchObject({ status: "failed", error: "expired unlanded" });
    expect(await statusOf(landed.signer)).toMatchObject({ status: "sending" });

    fakes.signatureStatus = "confirmed";
    expect(await settleTaps(db, config(bindings()), bindings())).toMatchObject({ sent: 1, failed: 0, waiting: 0 });
    expect(await statusOf(landed.signer)).toMatchObject({ status: "sent" });
    // The expired one's member may tap again.
    expect((await post("/cohort/tap", expired.session)).status).toBe(200);
  });
});
