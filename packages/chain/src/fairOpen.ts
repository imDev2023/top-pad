// A Fair Open on chain (spec 2.1, 5.3): the Fair Open program's accounts, the admission our server signs for each
// deposit, the reference calculation of the allocation (spec 2.1 step 11), which the Fair Open page shows and the
// program's own must match to the lamport, and the instructions of the window and the failure path. Kit only, so the
// API, the keeper, the scripts and the tests build the same transactions.
import {
  getAddressEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU64Encoder,
  getUtf8Encoder,
  signBytes,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getCreateAccountInstruction, getInitializeNonceAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getInitializePoolParametersEncoder } from "@top-pad/clients/dbc";
import {
  DEPOSIT_STEP,
  findLaunchPda,
  findProgramConfigPda,
  findVaultPda,
  getCloseLaunchInstructionAsync,
  getCreateLaunchInstructionAsync,
  getDepositInstructionAsync,
  getMarkFailedInstruction,
  getWithdrawFailedInstructionAsync,
  getWithdrawInstructionAsync,
  LATE_OPEN_SECONDS,
  SCORED_CAP_STEPS,
  Tier,
  UNVERIFIED_CAP_STEPS,
  VERIFIED_CAP_STEPS,
  WINDOW_SECONDS,
  type Launch,
} from "@top-pad/clients/fair-open";
import { eventAuthorityAddress } from "./dbc";
import { FAIR_OPEN_PROGRAM_ADDRESS } from "./index";

export { DEPOSIT_STEP, LATE_OPEN_SECONDS, Tier, WINDOW_SECONDS };

const addressBytes = getAddressEncoder();
const utf8 = getUtf8Encoder();

/** Each tier's cap per Fair Open in the quote's raw units, for a launch whose deposit step is `step` (spec 2.1 step 9). */
export function tierCap(tier: Tier, step: bigint = DEPOSIT_STEP): bigint {
  const steps = tier === Tier.Verified ? VERIFIED_CAP_STEPS : tier === Tier.Scored ? SCORED_CAP_STEPS : UNVERIFIED_CAP_STEPS;
  return steps * step;
}

/** The pot's cap for a Graduation Target: 20% of it, as `create_launch` reads it from the config (spec 12). */
export const potCapOf = (graduationTarget: bigint) => (graduationTarget * 20n) / 100n;

// --- Accounts ---------------------------------------------------------------------------------------------------------

/** A launch's account, at the PDA of its durable nonce, and its vault. */
export async function fairOpenAccounts(nonce: Address) {
  const [launch] = await findLaunchPda({ nonce });
  const [vault] = await findVaultPda({ launch });
  return { launch, vault };
}

/** A person's seat in a launch, at the PDA of the launch and their pseudonym. */
export async function seatAddress(launch: Address, person: ReadonlyUint8Array): Promise<Address> {
  const [seat] = await getProgramDerivedAddress({
    programAddress: FAIR_OPEN_PROGRAM_ADDRESS,
    seeds: [utf8.encode("seat"), addressBytes.encode(launch), person],
  });
  return seat;
}

/**
 * Where a seat's fields sit in its account, so a depositor with no Heat server finds theirs with one
 * `getProgramAccounts`: the discriminator, then the launch, then the wallet.
 */
export const SEAT_LAYOUT = { launchOffset: 8, walletOffset: 40 } as const;

// --- The admission ----------------------------------------------------------------------------------------------------

/** Solana's Ed25519 signature-verification precompile. */
export const ED25519_PROGRAM_ADDRESS = "Ed25519SigVerify111111111111111111111111111" as Address;
/** What an admission's message starts with (`admission::DOMAIN` in the program). */
export const ADMISSION_DOMAIN = "heat fair open admission v1";

/** Who our admission server admitted to a launch (spec 6.3): the program's `Admission`. */
export type Admission = {
  /** The person's pseudonym in this launch: a keyed hash of their cluster id, salted per launch. */
  person: ReadonlyUint8Array;
  tier: Tier;
  /** The most the person may have in the launch, in the quote's raw units. */
  cap: bigint;
  /** When the admission lapses, Unix seconds. */
  expiresAt: bigint;
};

/** The bytes our admission server signs for `wallet` in `launch`, as the program rebuilds them. */
export function admissionMessage(launch: Address, wallet: Address, a: Admission): Uint8Array {
  if (a.person.length !== 32) throw new Error("a person's pseudonym is 32 bytes");
  const parts = [
    utf8.encode(ADMISSION_DOMAIN),
    addressBytes.encode(launch),
    addressBytes.encode(wallet),
    a.person,
    new Uint8Array([a.tier]),
    getU64Encoder().encode(a.cap),
    getI64Encoder().encode(a.expiresAt),
  ];
  const message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    message.set(part, at);
    at += part.length;
  }
  return message;
}

/** Signs an admission's message with the admission key's private half. */
export async function signAdmission(privateKey: Parameters<typeof signBytes>[0], message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await signBytes(privateKey, message));
}

/**
 * The Ed25519 precompile's instruction verifying one signature, with its public key, signature and message all in its
 * own data, as Solana's SDK builds one: the layout the program requires of the instruction right before a deposit.
 */
export function ed25519Instruction(signer: Address, signature: ReadonlyUint8Array, message: ReadonlyUint8Array): Instruction {
  if (signature.length !== 64) throw new Error("an ed25519 signature is 64 bytes");
  const [keyAt, signatureAt, messageAt] = [16, 48, 112];
  const data = new Uint8Array(messageAt + message.length);
  data.set([1, 0]);
  const u16 = getU16Encoder();
  [signatureAt, 0xffff, keyAt, 0xffff, messageAt, message.length, 0xffff].forEach((field, i) => data.set(u16.encode(field), 2 + 2 * i));
  data.set(addressBytes.encode(signer), keyAt);
  data.set(signature, signatureAt);
  data.set(message, messageAt);
  return { programAddress: ED25519_PROGRAM_ADDRESS, accounts: [], data };
}

// --- The sealed identity ----------------------------------------------------------------------------------------------

/**
 * The hash a coin's identity is sealed behind (spec 2.1 step 5): the SHA-256 of DBC's `initialize_virtual_pool`
 * parameters (name, ticker as `symbol`, metadata URI) exactly as the open's creation transaction serializes them, so the
 * program can check the coin it creates by hashing that instruction's own bytes.
 */
export async function identityHash(coin: { name: string; ticker: string; uri: string }): Promise<Uint8Array> {
  const params = getInitializePoolParametersEncoder().encode({ name: coin.name, symbol: coin.ticker, uri: coin.uri });
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(params)));
}

// --- The allocation (spec 2.1 step 11) ---------------------------------------------------------------------------------

/** A level and what the seats fill up to it. */
export type Level = {
  /** Every seat fills its ask or this much, whichever is less: the largest ask when every ask fits. */
  level: bigint;
  /** What the fills add up to. */
  filled: bigint;
  /** Whether some ask is larger than the level, and so was cut to it. */
  limited: boolean;
};

/** How a pot's deposits would buy if its window closed now. */
export type Allocation = {
  /** What the pot spends: every seat's fill added up, at most the pot's cap. */
  spend: bigint;
  /** The level every seat but an Unverified one fills up to. */
  others: Level;
  /** The level Unverified seats fill up to: everyone's, unless their asks would take more than a quarter of the spend. */
  unverified: Level;
};

/** How many seats ask each amount: `counts[k]` seats ask `(k + 1) * step`. */
type Counts = (k: number) => bigint;
const countsOf = (counts: readonly number[]): Counts => (k) => BigInt(counts[k] ?? 0);

const asked = (at: Counts, len: number, step: bigint) => {
  let sum = 0n;
  for (let k = 0; k < len; k++) sum += at(k) * BigInt(k + 1) * step;
  return sum;
};

const largest = (at: Counts, len: number, step: bigint) => {
  for (let k = len - 1; k >= 0; k--) if (at(k) > 0n) return BigInt(k + 1) * step;
  return 0n;
};

const filled = (at: Counts, len: number, step: bigint, level: bigint) => {
  let sum = 0n;
  for (let k = 0; k < len; k++) {
    const ask = BigInt(k + 1) * step;
    sum += at(k) * (ask < level ? ask : level);
  }
  return sum;
};

/** The largest level at which the seats' fills add up to at most `budget`: `allocation::level_within` in the program. */
function levelWithin(at: Counts, len: number, step: bigint, budget: bigint): Level {
  let below = 0n;
  let above = 0n;
  for (let k = 0; k < len; k++) above += at(k);
  for (let k = 0; k < len; k++) {
    const ask = BigInt(k + 1) * step;
    if (below + above * ask > budget) {
      const level = (budget - below) / above;
      return { level, filled: below + above * level, limited: true };
    }
    below += at(k) * ask;
    above -= at(k);
  }
  return { level: largest(at, len, step), filled: below, limited: false };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * The allocation of a pot whose Scored and Verified seats ask `counts` and Unverified seats `unverifiedCounts` (counted
 * per step), spending at most `cap`: `allocation::allocate` in the program, line for line.
 */
export function allocate(counts: readonly number[], unverifiedCounts: readonly number[], step: bigint, cap: bigint): Allocation {
  const others = countsOf(counts);
  const unverified = countsOf(unverifiedCounts);
  const [n, u] = [counts.length, unverifiedCounts.length];
  const both: Counts = (k) => others(k) + unverified(k);
  const one = levelWithin(both, Math.max(n, u), step, cap);
  const unverifiedFilled = filled(unverified, u, step, one.level);
  const othersFilled = one.filled - unverifiedFilled;
  if (3n * unverifiedFilled <= othersFilled) {
    const level = (at: Counts, len: number): Level => ({
      level: one.level,
      filled: filled(at, len, step, one.level),
      limited: largest(at, len, step) > one.level,
    });
    return { spend: one.filled, others: level(others, n), unverified: level(unverified, u) };
  }
  const othersLevel = levelWithin(others, n, step, min(asked(others, n, step), cap - cap / 4n));
  const unverifiedLevel = levelWithin(unverified, u, step, min(cap - othersLevel.filled, othersLevel.filled / 3n));
  return { spend: othersLevel.filled + unverifiedLevel.filled, others: othersLevel, unverified: unverifiedLevel };
}

/** What a seat of `tier` asking `deposit` fills under an allocation: its ask or its tier's level, whichever is less. */
export function fillOf(a: Allocation, tier: Tier, deposit: bigint): bigint {
  const level = tier === Tier.Unverified ? a.unverified.level : a.others.level;
  return deposit < level ? deposit : level;
}

/** The ladder's 64 rungs, largest first: the pot's cap, then each 95% of the one before, rounded down (spec 2.1 step 6). */
export function rungs(cap: bigint): bigint[] {
  const all = [cap];
  while (all.length < 64) all.push((all.at(-1)! * 19n) / 20n);
  return all;
}

export const lowestRung = (cap: bigint) => rungs(cap).at(-1)!;

/** The rung the open spends for a pot that would spend `spend`: the largest at or below it, or null if none is. */
export const rungAtOrBelow = (cap: bigint, spend: bigint) => rungs(cap).find((rung) => rung <= spend) ?? null;

/** Where a launch stands, by the chain's clock, as `mark_failed` and the open judge it (spec 2.1 step 15). */
export type FairOpenPhase =
  | { phase: "scheduled" }
  | { phase: "window" }
  /** The window has closed and the pot can open; it fails if the open has not run by `lateAt`. */
  | { phase: "due"; lateAt: bigint }
  /** Anyone may mark it failed now, for this reason. */
  | { phase: "failing"; failure: "below_lowest_rung" | "min_raise_missed" | "late" }
  | { phase: "failed"; failure: "below_lowest_rung" | "min_raise_missed" | "late" };

const FAILURES = ["below_lowest_rung", "min_raise_missed", "late"] as const;

/** A launch's phase at `now` (Unix seconds), from its account. */
export function fairOpenPhase(launch: Launch, now: bigint): FairOpenPhase {
  if (launch.failure.__option === "Some") return { phase: "failed", failure: FAILURES[launch.failure.value]! };
  if (now < launch.depositsOpenAt) return { phase: "scheduled" };
  if (now < launch.opensAt) return { phase: "window" };
  const { spend } = allocate(launch.counts, launch.unverifiedCounts, launch.step, launch.potCap);
  if (spend < launch.lowestRung) return { phase: "failing", failure: "below_lowest_rung" };
  if (spend < launch.minRaise) return { phase: "failing", failure: "min_raise_missed" };
  const lateAt = launch.opensAt + LATE_OPEN_SECONDS;
  return now >= lateAt ? { phase: "failing", failure: "late" } : { phase: "due", lateAt };
}

// --- Instructions -----------------------------------------------------------------------------------------------------

/**
 * The compute each transaction may use, from the program's LiteSVM tests: a deposit that takes a seat used 41,686 units
 * and a top-up 34,368, a withdrawal about 28,400, `mark_failed` 74,047 (it computes the allocation) and a refund 27,919;
 * `create_launch` 35,406 after the nonce's creation.
 */
export const FAIR_OPEN_COMPUTE_UNITS = {
  createLaunch: 60_000,
  deposit: 70_000,
  withdraw: 50_000,
  markFailed: 110_000,
  withdrawFailed: 50_000,
  closeLaunch: 40_000,
} as const;

/** The size of a durable nonce account. */
export const NONCE_ACCOUNT_SPACE = 80n;

const priced = (computeUnitPrice: bigint) => (computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []);
const budget = (units: number, computeUnitPrice: bigint) => [getSetComputeUnitLimitInstruction({ units }), ...priced(computeUnitPrice)];

const programAccounts = async () => ({ eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS), program: FAIR_OPEN_PROGRAM_ADDRESS });

export type FairOpenSchedule = {
  /** The Creator wallet: signs, and pays the rent of the launch, its vault and its nonce (spec 2.1 step 7). */
  creator: TransactionSigner;
  /** Heat's keeper, which co-signs and holds the nonce. */
  keeper: TransactionSigner;
  /** A new key for the launch's durable nonce account. */
  nonce: TransactionSigner;
  /** The rent of a nonce account, from `getMinimumBalanceForRentExemption(80)`. */
  nonceRent: bigint;
  dbcConfig: Address;
  depositsOpenAt: bigint;
  minRaise: bigint;
  identityHash: ReadonlyUint8Array;
  computeUnitPrice: bigint;
};

/** Scheduling a Fair Open: its durable nonce created and handed to the keeper, then `create_launch`. */
export async function createLaunchInstructions(s: FairOpenSchedule): Promise<Instruction[]> {
  const { launch, vault } = await fairOpenAccounts(s.nonce.address);
  return [
    ...budget(FAIR_OPEN_COMPUTE_UNITS.createLaunch, s.computeUnitPrice),
    getCreateAccountInstruction({
      payer: s.creator,
      newAccount: s.nonce,
      lamports: s.nonceRent,
      space: NONCE_ACCOUNT_SPACE,
      programAddress: SYSTEM_PROGRAM_ADDRESS,
    }),
    getInitializeNonceAccountInstruction({ nonceAccount: s.nonce.address, nonceAuthority: s.keeper.address }),
    await getCreateLaunchInstructionAsync({
      programConfig: (await findProgramConfigPda())[0],
      creator: s.creator,
      keeper: s.keeper,
      dbcConfig: s.dbcConfig,
      nonce: s.nonce.address,
      launch,
      vault,
      ...(await programAccounts()),
      depositsOpenAt: s.depositsOpenAt,
      minRaise: s.minRaise,
      identityHash: s.identityHash,
    }),
  ];
}

export type FairOpenDeposit = {
  launch: Address;
  wallet: TransactionSigner;
  amount: bigint;
  admission: Admission;
  /** Our admission server's key and its signature over the admission's message. */
  admissionSigner: Address;
  signature: ReadonlyUint8Array;
  computeUnitPrice: bigint;
};

/** A deposit: the admission's precompile instruction, right before the deposit itself. */
export async function depositInstructions(d: FairOpenDeposit): Promise<Instruction[]> {
  const message = admissionMessage(d.launch, d.wallet.address, d.admission);
  const [vault] = await findVaultPda({ launch: d.launch });
  const deposit = await getDepositInstructionAsync({
    launch: d.launch,
    vault,
    seat: await seatAddress(d.launch, d.admission.person),
    depositor: d.wallet,
    ...(await programAccounts()),
    amount: d.amount,
    person: d.admission.person,
    tier: d.admission.tier,
    cap: d.admission.cap,
    expiresAt: d.admission.expiresAt,
  });
  return [...budget(FAIR_OPEN_COMPUTE_UNITS.deposit, d.computeUnitPrice), ed25519Instruction(d.admissionSigner, d.signature, message), deposit];
}

export type FairOpenWithdrawal = { launch: Address; seat: Address; wallet: TransactionSigner; amount: bigint; computeUnitPrice: bigint };

/** Taking back part or all of a deposit while the window is open. */
export async function withdrawInstructions(w: FairOpenWithdrawal): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ launch: w.launch });
  return [
    ...budget(FAIR_OPEN_COMPUTE_UNITS.withdraw, w.computeUnitPrice),
    await getWithdrawInstructionAsync({ launch: w.launch, vault, seat: w.seat, wallet: w.wallet, ...(await programAccounts()), amount: w.amount }),
  ];
}

/** Marking a launch failed, which anyone may send once it cannot open. */
export async function markFailedInstructions(m: { launch: Address; computeUnitPrice: bigint }): Promise<Instruction[]> {
  return [...budget(FAIR_OPEN_COMPUTE_UNITS.markFailed, m.computeUnitPrice), getMarkFailedInstruction({ launch: m.launch, ...(await programAccounts()) })];
}

/** A failed launch's seat returned to its wallet: anyone may send it, `payer` paying the fee. */
export async function withdrawFailedInstructions(r: { launch: Address; seat: Address; wallet: Address; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ launch: r.launch });
  const refund = await getWithdrawFailedInstructionAsync({ launch: r.launch, vault, seat: r.seat, wallet: r.wallet, ...(await programAccounts()) });
  return [...budget(FAIR_OPEN_COMPUTE_UNITS.withdrawFailed, r.computeUnitPrice), refund];
}

/** A failed launch closed once every seat is back, its rent and its vault's returned to the creator. */
export async function closeLaunchInstructions(c: { launch: Address; creator: Address; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ launch: c.launch });
  const close = await getCloseLaunchInstructionAsync({ launch: c.launch, vault, creator: c.creator, ...(await programAccounts()) });
  return [...budget(FAIR_OPEN_COMPUTE_UNITS.closeLaunch, c.computeUnitPrice), close];
}
