// The admission server (spec 6.3, 10.2), minimal for now: it knows a person by a linked X account (their own session, or
// the X account of the record whose Creator wallet they deposit from), which makes them Scored, and otherwise only by
// their wallet, Unverified. One-time verification and the linkage pipeline, which merges a person's wallets, come with
// the Depositor tiers ticket (#48). Each deposit carries its admission: our signature over the launch, the wallet, the
// person's pseudonym, the tier, the cap and an expiry, which the Fair Open program checks (spec 5.3).
//
// A person is a cluster id, `x:<X user id>` or `wallet:<address>`, and the chain sees only its pseudonym, a keyed hash of
// the cluster id salted with the launch, so it never links one person's wallets across launches. The `admissions` table
// fixes each wallet's person in a launch at its first admission, and each person's wallet: whatever is linked later, a
// wallet keeps its one seat and a person deposits through one wallet.
import {
  createKeyPairFromBytes,
  getAddressEncoder,
  getAddressFromPublicKey,
  getProgramDerivedAddress,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { and, eq, sql } from "drizzle-orm";
import { admissionMessage, FAIR_OPEN_PROGRAM_ADDRESS, signAdmission, Tier, tierCap, type Admission } from "@top-pad/chain";
import type { DepositorTier } from "@top-pad/contract";
import { admissions, creators, creatorWallets, type Db } from "@top-pad/db";
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

/** Who a wallet is, by what Heat knows of it now. */
export type Person = {
  cluster: string;
  tier: DepositorTier;
  via: "x" | "creator_wallet" | "none";
  handle: string | null;
};

/** An X account a person is known by: the record whose Creator wallet `wallet` is, or the session's own. */
async function xAccountOf(db: Db, wallet: Address, session: { id: string } | null) {
  const [byWallet] = await db
    .select({ xUserId: creators.xUserId, handle: creators.xHandle })
    .from(creatorWallets)
    .innerJoin(creators, eq(creators.id, creatorWallets.creatorId))
    .where(and(eq(creatorWallets.wallet, wallet), sql`${creatorWallets.endedAt} is null`));
  if (byWallet) return { ...byWallet, via: "creator_wallet" as const };
  if (!session) return null;
  const [bySession] = await db.select({ xUserId: creators.xUserId, handle: creators.xHandle }).from(creators).where(eq(creators.id, session.id));
  return bySession ? { ...bySession, via: "x" as const } : null;
}

/** The person a wallet is, and the tier that makes them: Scored by a linked X account, else Unverified. */
export async function personOf(db: Db, wallet: Address, session: { id: string } | null): Promise<Person> {
  const x = await xAccountOf(db, wallet, session);
  if (x) return { cluster: `x:${x.xUserId}`, tier: "scored", via: x.via, handle: x.handle };
  return { cluster: `wallet:${wallet}`, tier: "unverified", via: "none", handle: null };
}

/** A launch as admission needs it. */
export type AdmittingLaunch = { launch: Address; creator: Address; step: bigint };

/** A seat's wallet as the page shows it. */
const short = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

/** Wallets tied to the creator's cluster are refused, the Creator wallet itself excepted (spec 6.3). */
async function creatorsOwn(db: Db, launch: AdmittingLaunch, wallet: Address, person: Person): Promise<string | null> {
  if (wallet === launch.creator) return null;
  const creator = await personOf(db, launch.creator, null);
  return creator.cluster === person.cluster ? "This is the creator's own X account: the creator deposits from their Creator wallet alone." : null;
}

/** The person's admission through another wallet, if they have one. */
async function elsewhere(db: Db, launch: AdmittingLaunch, wallet: Address, person: Person) {
  const [row] = await db.select().from(admissions).where(and(eq(admissions.launch, launch.launch), eq(admissions.cluster, person.cluster)));
  return row && row.wallet !== wallet ? row : null;
}

const seatHeld = (wallet: string) => `You already hold this Fair Open's seat through ${short(wallet)}: one person, one seat, one wallet.`;

/** Why a person may not deposit in a launch from this wallet, if they may not, with nothing written. */
export async function refusalOf(
  db: Db,
  launch: AdmittingLaunch,
  wallet: Address,
  person: Person,
  seatExists: (seat: Address) => Promise<boolean>,
): Promise<string | null> {
  const own = await creatorsOwn(db, launch, wallet, person);
  if (own) return own;
  const other = await elsewhere(db, launch, wallet, person);
  return other && (await seatExists(await seatOf(launch.launch, unhex(other.pseudonym)))) ? seatHeld(other.wallet) : null;
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
  launch: AdmittingLaunch,
  wallet: Address,
  person: Person,
  now: bigint,
  seatExists: (seat: Address) => Promise<boolean>,
): Promise<Admitted> {
  const own = await creatorsOwn(db, launch, wallet, person);
  if (own) throw new AdmissionRefused(own);
  const other = await elsewhere(db, launch, wallet, person);
  if (other) {
    if (await seatExists(await seatOf(launch.launch, unhex(other.pseudonym)))) throw new AdmissionRefused(seatHeld(other.wallet));
    await db.delete(admissions).where(and(eq(admissions.launch, launch.launch), eq(admissions.wallet, other.wallet)));
  }
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
