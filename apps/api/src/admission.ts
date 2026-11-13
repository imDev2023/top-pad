// The admission server (spec 6.3, 10.2). A person verifies once on Heat (`verify.ts`): a wallet that signed for a linked
// X account, or the Creator wallet of a record with a linked X account, is Scored in every Fair Open; the Verified tier's
// providers come with #95; any other wallet is Unverified, a Creator wallet whose record linked no X included (ADR 0008). The linkage pipeline (`@top-pad/indexer`'s `traceFunding`) ties a person's other
// wallets to them by where their SOL came from, through hop wallets, so they share one seat; and a wallet tied to the
// creator's cluster, other than the Creator wallet itself, is refused. Each deposit carries its admission: our signature
// over the launch, the wallet, the person's pseudonym, the tier, the cap and an expiry, which the Fair Open program
// checks (spec 5.3).
//
// A person is a cluster id: `x:<X user id>`, or `wallet:<address>` of the wallet their SOL came from (their funding
// root), which is the wallet itself when nothing ties it to another. The chain sees only its pseudonym, a keyed hash of
// the cluster id salted with the launch, so it never links one person's wallets across launches. The `admissions` table
// fixes each wallet's person in a launch at its first admission, and each person's wallet: whatever is linked later, a
// wallet keeps its one seat and a person deposits through one wallet. Every refusal and merge is kept for the operator
// queue (`admission_reviews`, spec 6.6).
import {
  createKeyPairFromBytes,
  getAddressEncoder,
  getAddressFromPublicKey,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { admissionMessage, FAIR_OPEN_PROGRAM_ADDRESS, signAdmission, Tier, tierCap, type Admission, type HeatCluster } from "@top-pad/chain";
import type { DepositorTier } from "@top-pad/contract";
import { admissionReviews, admissions, creators, creatorWallets, linkageHubs, walletClearances, walletVerifications, type Db } from "@top-pad/db";
import { FundingUnreadable, traceFunding, type FundingSource, type FundingTrace } from "@top-pad/indexer";
import type { SecretBinding } from "./env";

/** How long an admission may be used: long enough for a wallet's approval, short enough that a tier never lingers. */
export const ADMISSION_SECONDS = 120n;

export type AdmissionKey = {
  address: Address;
  privateKey: CryptoKey;
  /** The key the pseudonyms are hashed with, derived from the admission key so one secret holds both. */
  pseudonymKey: CryptoKey;
};

const encoder = new TextEncoder();

/** Reads the admission key from its binding, and refuses one that is not the key the cluster's ProgramConfig names. */
export async function loadAdmissionKey(binding: SecretBinding, expected: Address): Promise<AdmissionKey> {
  let secret: Uint8Array;
  try {
    secret = Uint8Array.from(JSON.parse(await binding.get()) as number[]);
  } catch {
    throw new Error("the admission key binding does not hold a keypair array");
  }
  if (secret.length !== 64) throw new Error("the admission key binding does not hold a 64-byte keypair");
  const keyPair = await createKeyPairFromBytes(secret);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  if (address !== expected) throw new Error(`the bound admission key is ${address}, not ${expected}`);
  // HMAC-SHA-256 of a fixed label under the key's seed, so the pseudonym key is the admission key's alone.
  const seed = await crypto.subtle.importKey("raw", secret.slice(0, 32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", seed, encoder.encode("heat person pseudonym key v1"));
  const pseudonymKey = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { address, privateKey: keyPair.privateKey, pseudonymKey };
}

/** A person's pseudonym in a launch: HMAC-SHA-256 of the launch and their cluster id. */
export async function pseudonymOf(key: AdmissionKey, launch: Address, cluster: string): Promise<Uint8Array> {
  const message = new Uint8Array([...getAddressEncoder().encode(launch), ...encoder.encode(cluster)]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key.pseudonymKey, message));
}

/** A person's seat in a launch, at the PDA of the launch and their pseudonym. */
export async function seatOf(launch: Address, person: ReadonlyUint8Array): Promise<Address> {
  const [seat] = await getProgramDerivedAddress({
    programAddress: FAIR_OPEN_PROGRAM_ADDRESS,
    seeds: ["seat", getAddressEncoder().encode(launch), person],
  });
  return seat;
}

const TIERS: DepositorTier[] = ["unverified", "scored", "verified"];
export const tierOf = (tier: DepositorTier) => TIERS.indexOf(tier) as Tier;
export const tierName = (tier: Tier) => TIERS[tier]!;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => Uint8Array.from(text.match(/../g)!.map((b) => parseInt(b, 16)));

/** What the linkage pipeline reads with: the chain, and the hubs it never ties anyone through. */
export type Linkage = { source: FundingSource; hubs: ReadonlySet<string> };

/** The hubs: Heat's own keys, the cluster's shared funding sources, and the operator's `linkage_hubs`. */
export async function linkageOf(db: Db, heat: HeatCluster, source: FundingSource): Promise<Linkage> {
  const named = await db.select({ address: linkageHubs.address }).from(linkageHubs);
  const keys = heat.keys ? [heat.keys.treasury, heat.keys.keeper, heat.keys.admission, heat.keys.quoteManager] : [];
  return { source, hubs: new Set<string>([...keys, ...heat.linkageHubs, ...named.map((h) => h.address)]) };
}

/** A wallet's funding trace, or `FundingUnreadable` when the chain cannot be read for it now, whatever the reason. */
async function traceOf(db: Db, linkage: Linkage, wallet: string): Promise<FundingTrace> {
  try {
    return await traceFunding(db, linkage.source, wallet, linkage.hubs);
  } catch (e) {
    if (!(e instanceof FundingUnreadable)) console.warn(`reading ${wallet}'s funding failed`, e);
    throw e instanceof FundingUnreadable ? e : new FundingUnreadable(String(e));
  }
}

/** What a wallet sees when its funding cannot be read now: nothing is concluded from a chain Heat could not read. */
export const UNREADABLE = "Heat could not read where this wallet's SOL came from just now. Try again in a moment.";

/** Who a wallet is, by what Heat knows of it now. */
export type Person = {
  cluster: string;
  tier: DepositorTier;
  /** Its own verified X account, the Creator wallet of a record, another wallet's person by its funding, or none. */
  via: "x" | "creator_wallet" | "linked" | "none";
  handle: string | null;
  /** Where its SOL came from. */
  trace: FundingTrace;
  /** When the linkage pipeline put it in another wallet's person: why, as the wallet is told. */
  linked: string | null;
  /** Whether an operator cleared it for this Fair Open: then nothing ties it to the creator or merges it (spec 6.3). */
  cleared: boolean;
};

type XAccount = { xUserId: string; handle: string; via: "x" | "creator_wallet" };

/** A record's linked X account, when it has one: a record that linked none gives no tier. */
const linked = <T extends { xUserId: string | null; handle: string | null }>(row: T | undefined) =>
  row?.xUserId && row.handle ? { ...row, xUserId: row.xUserId, handle: row.handle } : null;

/** The X account a wallet was verified for: as the Creator wallet of a record that linked X, or by signing for it once. */
async function xAccountOf(db: Db, wallet: string): Promise<XAccount | null> {
  const [byRecord] = await db
    .select({ xUserId: creators.xUserId, handle: creators.xHandle })
    .from(creatorWallets)
    .innerJoin(creators, eq(creators.id, creatorWallets.creatorId))
    .where(and(eq(creatorWallets.wallet, wallet), sql`${creatorWallets.endedAt} is null`, isNotNull(creators.xUserId)));
  const own = linked(byRecord);
  if (own) return { ...own, via: "creator_wallet" };
  const [verified] = await db
    .select({ xUserId: creators.xUserId, handle: creators.xHandle })
    .from(walletVerifications)
    .innerJoin(creators, eq(creators.id, walletVerifications.creatorId))
    .where(and(eq(walletVerifications.wallet, wallet), isNotNull(creators.xUserId)));
  const signed = linked(verified);
  return signed ? { ...signed, via: "x" } : null;
}

/** The X account of a verified wallet whose SOL came from `root`, if there is one: wallets with one root are one person. */
async function xAccountByRoot(db: Db, root: string, except: string) {
  const [row] = await db
    .select({ xUserId: creators.xUserId, handle: creators.xHandle, wallet: walletVerifications.wallet })
    .from(walletVerifications)
    .innerJoin(creators, eq(creators.id, walletVerifications.creatorId))
    .where(and(eq(walletVerifications.root, root), isNotNull(walletVerifications.root), ne(walletVerifications.wallet, except), isNotNull(creators.xUserId)))
    .orderBy(walletVerifications.createdAt)
    .limit(1);
  return linked(row);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How SOL got from `trace`'s wallet up to `to`, one of its funders: directly, or through the wallets between. */
function route(trace: FundingTrace, to: string) {
  const steps = trace.chain.findIndex((s) => s.funder === to);
  const between = steps < 0 ? trace.funders.indexOf(to) : steps;
  if (between <= 0) return "directly";
  const hops = trace.chain.slice(0, between).every((s) => s.passThrough);
  return `through ${plural(between, hops ? "pass-through wallet" : "wallet", hops ? "pass-through wallets" : "wallets")} in between`;
}

/** Why a wallet joins its root's person, in the words it is shown. */
function linkedText(trace: FundingTrace, handle: string | null) {
  const whose = handle ? `@${handle}'s person, as a wallet verified for that X account was` : `one person with every wallet funded from it`;
  return `Heat counts this wallet as ${whose}: its SOL came from ${short(trace.root)}, ${route(trace, trace.root)}. They share one seat in each Fair Open.`;
}

/**
 * Whether an operator cleared the wallet (`wallet_clearances`, from the operator app, #54) before this Fair Open's
 * deposits opened: a clearance counts for future Fair Opens only (spec 6.3), so one already taking deposits keeps the
 * refusal or merge it gave.
 */
async function clearedFor(db: Db, wallet: string, depositsOpenAt: bigint): Promise<boolean> {
  const [row] = await db
    .select({ wallet: walletClearances.wallet })
    .from(walletClearances)
    .where(and(eq(walletClearances.wallet, wallet), lt(walletClearances.clearedAt, new Date(Number(depositsOpenAt) * 1000))));
  return row !== undefined;
}

/**
 * The person a wallet is in a Fair Open, and the tier that makes them: Scored by a verified X account, its own or that
 * of the wallets its SOL came from with it; else Unverified, as the person of the wallet its SOL came from. A wallet an
 * operator cleared before the Fair Open's deposits opened is its own person whatever funded it. Throws
 * `FundingUnreadable`.
 */
export async function personOf(db: Db, linkage: Linkage, wallet: Address, launch: { depositsOpenAt: bigint }): Promise<Person> {
  const trace = await traceOf(db, linkage, wallet);
  const own = await xAccountOf(db, wallet);
  const cleared = await clearedFor(db, wallet, launch.depositsOpenAt);
  if (own) return { cluster: `x:${own.xUserId}`, tier: "scored", via: own.via, handle: own.handle, trace, linked: null, cleared };
  if (cleared) return { cluster: `wallet:${wallet}`, tier: "unverified", via: "none", handle: null, trace, linked: null, cleared };
  const rooted = trace.root !== wallet ? ((await xAccountOf(db, trace.root)) ?? (await xAccountByRoot(db, trace.root, wallet))) : await xAccountByRoot(db, wallet, wallet);
  if (rooted) return { cluster: `x:${rooted.xUserId}`, tier: "scored", via: "linked", handle: rooted.handle, trace, linked: linkedText(trace, rooted.handle), cleared };
  if (trace.root !== wallet) return { cluster: `wallet:${trace.root}`, tier: "unverified", via: "linked", handle: null, trace, linked: linkedText(trace, null), cleared };
  return { cluster: `wallet:${wallet}`, tier: "unverified", via: "none", handle: null, trace, linked: null, cleared };
}

/** A launch as admission needs it; `depositsOpenAt` in unix seconds. */
export type AdmittingLaunch = { launch: Address; creator: Address; step: bigint; depositsOpenAt: bigint };

/** A seat's wallet as the page shows it. */
const short = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

const STILL_BUY = "You can still buy the coin once it opens.";

/** A refusal or merge as the operator queue keeps it; `own` for a person's own second wallet, which it does not. */
type Review = { kind: "refused" | "merged"; reason: string; evidence: Record<string, unknown>; own?: true };

async function record(db: Db, launch: AdmittingLaunch, wallet: Address, person: Person, { own, ...review }: Review) {
  if (own) return;
  await db
    .insert(admissionReviews)
    .values({ launch: launch.launch, wallet, cluster: person.cluster, ...review })
    .onConflictDoNothing();
}

/**
 * Wallets tied to the creator's cluster are refused, the Creator wallet itself excepted (spec 6.3): one the Creator
 * wallet's SOL reached, one whose SOL reached the Creator wallet, one whose SOL came from where the Creator wallet's did,
 * or one of the creator's own person.
 */
async function creatorTie(db: Db, linkage: Linkage, launch: AdmittingLaunch, wallet: Address, person: Person): Promise<Review | null> {
  if (wallet === launch.creator) return null;
  const creator = await personOf(db, linkage, launch.creator, launch);
  const tie = (why: string) => ({
    kind: "refused" as const,
    reason: `${why} Wallets tied to the creator cannot deposit in their Fair Open. ${STILL_BUY}`,
    evidence: { wallet: person.trace, creator: creator.trace },
  });
  const ownX = person.cluster === creator.cluster && person.via !== "linked";
  // A clearance lifts what the linkage pipeline concluded, never a wallet verified for the creator's own X account.
  if (person.cleared) return ownX ? tie("This wallet is verified for the creator's own X account: the creator deposits from their Creator wallet alone.") : null;
  // A hub funds everyone, the creator included, and ties nobody: on devnet, Heat's bank is often the creator too.
  if (person.trace.funders.includes(launch.creator) && !linkage.hubs.has(launch.creator)) return tie(`The Creator wallet funded this wallet, ${route(person.trace, launch.creator)}.`);
  if (creator.trace.funders.includes(wallet) && !linkage.hubs.has(wallet)) return tie(`This wallet funded the Creator wallet, ${route(creator.trace, wallet)}.`);
  if (creator.trace.root !== launch.creator && person.trace.root === creator.trace.root) {
    return tie(`This wallet's SOL came from ${short(creator.trace.root)}, as the Creator wallet's did.`);
  }
  if (person.cluster === creator.cluster) {
    return person.via === "linked"
      ? tie(`Heat counts this wallet as the creator's own person: its SOL came from ${short(person.trace.root)}, as one of theirs did.`)
      : tie("This wallet is verified for the creator's own X account: the creator deposits from their Creator wallet alone.");
  }
  return null;
}

/** The person's admission through another wallet, if they have one. */
async function elsewhere(db: Db, launch: AdmittingLaunch, wallet: Address, person: Person) {
  const [row] = await db.select().from(admissions).where(and(eq(admissions.launch, launch.launch), eq(admissions.cluster, person.cluster)));
  return row && row.wallet !== wallet ? row : null;
}

/** The refusal of a wallet whose person holds the seat through another wallet: a merge, when the pipeline made it one. */
async function seatHeld(db: Db, linkage: Linkage, wallet: Address, person: Person, other: string): Promise<Review> {
  const theirX = await xAccountOf(db, other);
  if (person.via !== "linked" && theirX && `x:${theirX.xUserId}` === person.cluster) {
    // Both wallets verified for the person's own X account: no linkage involved.
    return { kind: "refused", reason: `You already hold this Fair Open's seat through ${short(other)}: one person, one seat, one wallet.`, evidence: {}, own: true };
  }
  const theirs = await traceOf(db, linkage, other);
  const why = theirs.funders.includes(wallet)
    ? `this wallet funded ${short(other)}, ${route(theirs, wallet)}`
    : person.trace.funders.includes(other)
      ? `${short(other)} funded this wallet, ${route(person.trace, other)}`
      : theirs.root === person.trace.root
        ? `both got their SOL from ${short(person.trace.root)}, this wallet ${route(person.trace, person.trace.root)}`
        : `${short(other)} is counted as ${person.handle ? `@${person.handle}'s` : "this person's"} by where its SOL came from`;
  return {
    kind: "merged",
    reason: `Heat counts this wallet as one person with ${short(other)}: ${why}. ${short(other)} holds this Fair Open's seat: one person, one seat, one wallet. ${STILL_BUY}`,
    evidence: { wallet: person.trace, holder: theirs },
  };
}

/**
 * Why a person may not deposit in a launch from this wallet, if they may not, kept for the operator queue; and, when it
 * may, why the pipeline merged it into another wallet's person, if it did.
 */
export async function refusalOf(
  db: Db,
  linkage: Linkage,
  launch: AdmittingLaunch,
  wallet: Address,
  person: Person,
  seatExists: (seat: Address) => Promise<boolean>,
): Promise<string | null> {
  const refused = (await creatorTie(db, linkage, launch, wallet, person)) ?? (await heldElsewhere(db, linkage, launch, wallet, person, seatExists));
  if (refused) await record(db, launch, wallet, person, refused);
  return refused?.reason ?? null;
}

async function heldElsewhere(db: Db, linkage: Linkage, launch: AdmittingLaunch, wallet: Address, person: Person, seatExists: (seat: Address) => Promise<boolean>) {
  const other = await elsewhere(db, launch, wallet, person);
  return other && (await seatExists(await seatOf(launch.launch, unhex(other.pseudonym)))) ? seatHeld(db, linkage, wallet, person, other.wallet) : null;
}

export type Admitted = { admission: Admission; signature: Uint8Array; seat: Address; tier: DepositorTier };

/**
 * Admits a wallet to a launch, fixing its person on its first admission, and signs the admission. A wallet's person
 * never changes once fixed, though linking X raises its tier and joins its X account to it; a person whose other wallet
 * holds no seat any more moves to this one. Throws `AdmissionRefused` with the reason the page shows.
 */
export async function admit(
  db: Db,
  key: AdmissionKey,
  linkage: Linkage,
  launch: AdmittingLaunch,
  wallet: Address,
  person: Person,
  now: bigint,
  seatExists: (seat: Address) => Promise<boolean>,
): Promise<Admitted> {
  const refuse = async (review: Review) => {
    await record(db, launch, wallet, person, review);
    return new AdmissionRefused(review.reason);
  };
  const tie = await creatorTie(db, linkage, launch, wallet, person);
  if (tie) throw await refuse(tie);
  const other = await elsewhere(db, launch, wallet, person);
  if (other) {
    if (await seatExists(await seatOf(launch.launch, unhex(other.pseudonym)))) throw await refuse(await seatHeld(db, linkage, wallet, person, other.wallet));
    await db.delete(admissions).where(and(eq(admissions.launch, launch.launch), eq(admissions.wallet, other.wallet)));
  }
  if (person.linked) await record(db, launch, wallet, person, { kind: "merged", reason: person.linked, evidence: { wallet: person.trace } });
  const fresh = hex(await pseudonymOf(key, launch.launch, person.cluster));
  // One statement, so two admissions racing for the same wallet settle in the database: a wallet keeps the pseudonym of
  // its first admission, takes the higher tier, and a wallet known only as itself takes on an X account linked since.
  // Two racing for the same person meet the unique index on the launch and cluster, and the second is refused.
  const [pinned] = await db
    .insert(admissions)
    .values({ launch: launch.launch, wallet, cluster: person.cluster, pseudonym: fresh, tier: person.tier })
    .onConflictDoUpdate({
      target: [admissions.launch, admissions.wallet],
      set: {
        tier: sql`case when array_position(array['unverified','scored','verified'], excluded.tier) > array_position(array['unverified','scored','verified'], ${admissions.tier}) then excluded.tier else ${admissions.tier} end`,
        cluster: sql`case when ${admissions.cluster} like 'wallet:%' and excluded.cluster like 'x:%' then excluded.cluster else ${admissions.cluster} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning()
    .catch((e: { code?: string; cause?: { code?: string } }) => {
      if ((e.cause?.code ?? e.code) === "23505") throw new AdmissionRefused("Another wallet of yours was admitted at the same moment: one person, one seat, one wallet.");
      throw e;
    });
  const tier = tierOf(pinned!.tier);
  const admission: Admission = { person: unhex(pinned!.pseudonym), tier, cap: tierCap(tier, launch.step), expiresAt: now + ADMISSION_SECONDS };
  const signature = await signAdmission(key.privateKey, admissionMessage(launch.launch, wallet, admission));
  return { admission, signature, seat: await seatOf(launch.launch, admission.person), tier: pinned!.tier };
}

export class AdmissionRefused extends Error {}
