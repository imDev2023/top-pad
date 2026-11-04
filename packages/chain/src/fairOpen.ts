// A Fair Open on chain (spec 2.1, 5.3): the Fair Open program's accounts, the admission our server signs for each
// deposit, the reference calculation of the allocation (spec 2.1 step 11), which the Fair Open page shows and the
// program's own must match to the lamport, and the instructions of the window and the failure path. Kit only, so the
// API, the keeper, the scripts and the tests build the same transactions. A launch in SOL holds its deposits in its vault
// as plain SOL; in any other quote its pot, a token account of the quote, holds them and every instruction that moves
// them names the pot, the quote, the quote's token program and the wallet's account of it (ADR 0007 decision 1).
import {
  address,
  fetchEncodedAccount,
  getAddressEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU64Encoder,
  getUtf8Encoder,
  signBytes,
  type Address,
  type Instruction,
  type Nonce,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { fetchNonce, getCreateAccountInstruction, getInitializeNonceAccountInstruction, getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { getInitializePoolParametersEncoder } from "@top-pad/clients/dbc";
import {
  DEPOSIT_STEP,
  findLaunchPda,
  findPotPda,
  findProgramConfigPda,
  findVaultPda,
  getCloseLaunchInstructionAsync,
  getCreateLaunchInstructionAsync,
  getDepositInstructionAsync,
  getMarkFailedInstruction,
  getWithdrawFailedInstructionAsync,
  getWithdrawInstructionAsync,
  LATE_OPEN_SECONDS,
  LaunchStatus,
  SCORED_CAP_STEPS,
  Tier,
  UNVERIFIED_CAP_STEPS,
  VERIFIED_CAP_STEPS,
  WINDOW_SECONDS,
  type Launch,
} from "@top-pad/clients/fair-open";
import { eventAuthorityAddress, TOKEN_PROGRAM_ADDRESS } from "./dbc";
import { FAIR_OPEN_PROGRAM_ADDRESS } from "./index";

export { DEPOSIT_STEP, LATE_OPEN_SECONDS, Tier, WINDOW_SECONDS };

/**
 * A launch's quote as its instructions name it (ADR 0007 decision 1): its mint and the mint's own token program, SPL
 * Token or Token-2022. Left out, or wrapped SOL, a launch is in SOL and names no token account of its quote.
 */
export type QuoteToken = { mint: Address; tokenProgram: Address };

/** SPL Token's wrapped SOL, as `WSOL_MINT` is: `./index` imports this module, so its constants are not yet set while
 * this one loads. */
const WSOL = address("So11111111111111111111111111111111111111112");

/** SOL as a quote: SPL Token's wrapped SOL. */
export const SOL_QUOTE: QuoteToken = { mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS };

/** Whether a launch in `quote` holds its deposits as plain SOL. */
export const inSol = (quote?: QuoteToken | null): boolean => !quote || quote.mint === WSOL;

/** A launch's quote read from the chain: the quote mint's owner is its token program. */
export async function fetchQuoteToken(rpc: Parameters<typeof fetchEncodedAccount>[0], mint: Address): Promise<QuoteToken> {
  if (mint === WSOL) return SOL_QUOTE;
  const account = await fetchEncodedAccount(rpc, mint, { commitment: "confirmed" });
  if (!account.exists) throw new Error(`the quote ${mint} has no mint account`);
  return { mint, tokenProgram: account.programAddress };
}

/** `owner`'s associated account of the quote, where the pot pays them and their deposits come from. */
export async function quoteTokenAccount(owner: Address, quote: QuoteToken): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint: quote.mint, tokenProgram: quote.tokenProgram });
  return account;
}

/** `owner`'s associated account of the quote, made with `payer`'s rent if it is missing; nothing if it exists. */
export async function quoteTokenAccountInstruction(payer: TransactionSigner, owner: Address, quote: QuoteToken): Promise<Instruction> {
  const account = await quoteTokenAccount(owner, quote);
  return getCreateAssociatedTokenIdempotentInstruction({ payer, ata: account, owner, mint: quote.mint, tokenProgram: quote.tokenProgram });
}

/**
 * What an instruction of a launch in a token quote names besides its own accounts: the launch's pot, the quote and its
 * token program. Nothing in SOL, which leaves the optional accounts out.
 */
export async function quoteAccountsOf(launch: Address, quote?: QuoteToken | null): Promise<{ pot?: Address; quoteMint?: Address; quoteTokenProgram?: Address }> {
  if (!quote || inSol(quote)) return {};
  const [pot] = await findPotPda({ launch });
  return { pot, quoteMint: quote.mint, quoteTokenProgram: quote.tokenProgram };
}

/** `owner`'s associated account of a token quote, which an instruction names for them; none in SOL. */
export async function walletQuoteOf(owner: Address, quote?: QuoteToken | null): Promise<Address | undefined> {
  return !quote || inSol(quote) ? undefined : quoteTokenAccount(owner, quote);
}

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

/**
 * What a seat's deposit buys with when the pot opens on `rung`: its fill scaled down to the rung pro rata, rounded up to
 * the lamport (spec 12), so the lamports the rounding gathers go to the launch's Tax Share and stay with depositors. The
 * rest of the deposit is refunded.
 */
export function spentOf(a: Allocation, rung: bigint, tier: Tier, deposit: bigint): bigint {
  const fill = fillOf(a, tier, deposit);
  if (a.spend === 0n || fill === 0n) return 0n;
  return (fill * rung + a.spend - 1n) / a.spend;
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
  /** The coin and its pool exist and the pot bought; seats get their coins and refund. */
  | { phase: "opened" }
  /** The window has closed and the pot can open; it fails if the open has not run by `lateAt`. */
  | { phase: "due"; lateAt: bigint }
  /** Anyone may mark it failed now, for this reason. */
  | { phase: "failing"; failure: "below_lowest_rung" | "min_raise_missed" | "late" }
  | { phase: "failed"; failure: "below_lowest_rung" | "min_raise_missed" | "late" };

const FAILURES = ["below_lowest_rung", "min_raise_missed", "late"] as const;

/** A launch's phase at `now` (Unix seconds), from its account. */
export function fairOpenPhase(launch: Launch, now: bigint): FairOpenPhase {
  if (launch.status === LaunchStatus.Opened) return { phase: "opened" };
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
 * `create_launch` 35,406 after the nonce's creation. In a token quote each moves the quote by a token program's CPI as
 * well, `inTokens` more (2026-11-04, `programs/fair_open/tests/token_quotes.rs`): `create_launch` 64,825 units in an
 * xStock (it makes the pot), a deposit taking a seat 47,356 and 52,876 in USDC, a withdrawal 38,868 to 41,371, a refund
 * 38,248 to 40,773 and `close_launch` 19,812 to 29,462.
 */
export const FAIR_OPEN_COMPUTE_UNITS = {
  createLaunch: 60_000,
  deposit: 70_000,
  withdraw: 50_000,
  markFailed: 110_000,
  withdrawFailed: 50_000,
  closeLaunch: 40_000,
  inTokens: 40_000,
} as const;

/** `units` for a launch in `quote`: `inTokens` more in a token quote. */
const unitsIn = (units: number, quote?: QuoteToken | null) => units + (inSol(quote) ? 0 : FAIR_OPEN_COMPUTE_UNITS.inTokens);

/** The size of a durable nonce account. */
export const NONCE_ACCOUNT_SPACE = 80n;

const priced = (computeUnitPrice: bigint) => (computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []);
const budget = (units: number, computeUnitPrice: bigint) => [getSetComputeUnitLimitInstruction({ units }), ...priced(computeUnitPrice)];

const programAccounts = async () => ({ eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS), program: FAIR_OPEN_PROGRAM_ADDRESS });

/** What `create_launch` takes, whoever made the launch's durable nonce. */
type LaunchTerms = {
  /** The Creator wallet: signs, and pays the rent of the launch, its vault and the open's accounts (spec 2.1 step 7). */
  creator: TransactionSigner;
  /** Heat's keeper, which co-signs and holds the nonce. */
  keeper: TransactionSigner;
  /** The quote's Fair Open config, as its `QuoteSettings` names it (ADR 0007 decision 4). */
  dbcConfig: Address;
  /** The quote's mint, whose `QuoteSettings` the program reads the config and step from. */
  quoteMint: Address;
  /** The quote mint's own token program, SPL Token unless given; in a quote other than SOL the launch's pot, a token
   * account of the quote, is made under it at scheduling (ADR 0007 decision 1). */
  quoteTokenProgram?: Address;
  /** Heat's SOL Fair Open config, which the program config names and every quote's config is shaped as. */
  referenceConfig: Address;
  depositsOpenAt: bigint;
  minRaise: bigint;
  identityHash: ReadonlyUint8Array;
  computeUnitPrice: bigint;
};

export type FairOpenSchedule = LaunchTerms & {
  /** A new key for the launch's durable nonce account, which the creator pays for in the same transaction. */
  nonce: TransactionSigner;
  /** The rent of a nonce account, from `getMinimumBalanceForRentExemption(80)`. */
  nonceRent: bigint;
};

async function createLaunchInstruction(t: LaunchTerms, nonce: Address): Promise<Instruction> {
  const { launch, vault } = await fairOpenAccounts(nonce);
  const quote = { mint: t.quoteMint, tokenProgram: t.quoteTokenProgram ?? TOKEN_PROGRAM_ADDRESS };
  const { pot, quoteTokenProgram } = await quoteAccountsOf(launch, quote);
  return getCreateLaunchInstructionAsync({
    programConfig: (await findProgramConfigPda())[0],
    creator: t.creator,
    keeper: t.keeper,
    quoteMint: t.quoteMint,
    dbcConfig: t.dbcConfig,
    referenceConfig: t.referenceConfig,
    nonce,
    launch,
    vault,
    pot,
    quoteTokenProgram,
    ...(await programAccounts()),
    depositsOpenAt: t.depositsOpenAt,
    minRaise: t.minRaise,
    identityHash: t.identityHash,
  });
}

/** A durable nonce account made by `payer`, whose value only `authority` can advance. */
export function nonceAccountInstructions(n: { payer: TransactionSigner; nonce: TransactionSigner; authority: Address; rent: bigint }): Instruction[] {
  return [
    getCreateAccountInstruction({ payer: n.payer, newAccount: n.nonce, lamports: n.rent, space: NONCE_ACCOUNT_SPACE, programAddress: SYSTEM_PROGRAM_ADDRESS }),
    getInitializeNonceAccountInstruction({ nonceAccount: n.nonce.address, nonceAuthority: n.authority }),
  ];
}

/** A durable nonce's current value, which a transaction signed on it must name. */
export async function fetchNonceValue(rpc: Parameters<typeof fetchNonce>[0], nonce: Address, config?: Parameters<typeof fetchNonce>[2]): Promise<Nonce> {
  const { data } = await fetchNonce(rpc, nonce, { commitment: "confirmed", ...config });
  return data.blockhash as string as Nonce;
}

/** Scheduling a Fair Open in one go, as the scripts and tests do: its durable nonce created and handed to the keeper, then `create_launch`. */
export async function createLaunchInstructions(s: FairOpenSchedule): Promise<Instruction[]> {
  return [
    ...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.createLaunch, { mint: s.quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }), s.computeUnitPrice),
    ...nonceAccountInstructions({ payer: s.creator, nonce: s.nonce, authority: s.keeper.address, rent: s.nonceRent }),
    await createLaunchInstruction(s, s.nonce.address),
  ];
}

/**
 * Scheduling a Fair Open on a durable nonce our keeper made beforehand, as the launch service does, so the creator can
 * sign the ladder on its value in the same approval as this (ADR 0005): the creator pays the keeper back the nonce's
 * rent, which comes back to the creator when the keeper closes the nonce, then `create_launch`.
 */
export async function scheduleInstructions(s: LaunchTerms & { nonce: Address; nonceRent: bigint }): Promise<Instruction[]> {
  return [
    ...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.createLaunch, { mint: s.quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }), s.computeUnitPrice),
    getTransferSolInstruction({ source: s.creator, destination: s.keeper.address, amount: s.nonceRent }),
    await createLaunchInstruction(s, s.nonce),
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
  /** The launch's quote; SOL when left out. In any other quote the deposit comes from the wallet's associated account. */
  quote?: QuoteToken | null;
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
    ...(await quoteAccountsOf(d.launch, d.quote)),
    depositorQuote: await walletQuoteOf(d.wallet.address, d.quote),
    ...(await programAccounts()),
    amount: d.amount,
    person: d.admission.person,
    tier: d.admission.tier,
    cap: d.admission.cap,
    expiresAt: d.admission.expiresAt,
  });
  return [...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.deposit, d.quote), d.computeUnitPrice), ed25519Instruction(d.admissionSigner, d.signature, message), deposit];
}

export type FairOpenWithdrawal = { launch: Address; seat: Address; wallet: TransactionSigner; amount: bigint; computeUnitPrice: bigint; quote?: QuoteToken | null };

/**
 * Taking back part or all of a deposit while the window is open. In a quote other than SOL it goes to the wallet's
 * associated account of the quote, made first if the wallet has closed it.
 */
export async function withdrawInstructions(w: FairOpenWithdrawal): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ launch: w.launch });
  const quoteAccounts = { ...(await quoteAccountsOf(w.launch, w.quote)), walletQuote: await walletQuoteOf(w.wallet.address, w.quote) };
  return [
    ...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.withdraw, w.quote), w.computeUnitPrice),
    ...(inSol(w.quote) ? [] : [await quoteTokenAccountInstruction(w.wallet, w.wallet.address, w.quote!)]),
    await getWithdrawInstructionAsync({ launch: w.launch, vault, seat: w.seat, wallet: w.wallet, ...quoteAccounts, ...(await programAccounts()), amount: w.amount }),
  ];
}

type Refund = { launch: Address; seat: Address; wallet: Address; quote?: QuoteToken | null };

async function withdrawFailedInstruction(r: Refund): Promise<Instruction> {
  const [vault] = await findVaultPda({ launch: r.launch });
  const quoteAccounts = { ...(await quoteAccountsOf(r.launch, r.quote)), walletQuote: await walletQuoteOf(r.wallet, r.quote) };
  return getWithdrawFailedInstructionAsync({ launch: r.launch, vault, seat: r.seat, wallet: r.wallet, ...quoteAccounts, ...(await programAccounts()) });
}

/**
 * Marking a launch failed, which anyone may send once it cannot open; with `refund`, the sender's own seat comes back in
 * the same transaction.
 */
export async function markFailedInstructions(m: {
  launch: Address;
  refund?: Omit<Refund, "launch" | "quote">;
  computeUnitPrice: bigint;
  quote?: QuoteToken | null;
}): Promise<Instruction[]> {
  const units = FAIR_OPEN_COMPUTE_UNITS.markFailed + (m.refund ? unitsIn(FAIR_OPEN_COMPUTE_UNITS.withdrawFailed, m.quote) : 0);
  const refund = m.refund ? [await withdrawFailedInstruction({ launch: m.launch, ...m.refund, quote: m.quote })] : [];
  return [...budget(units, m.computeUnitPrice), getMarkFailedInstruction({ launch: m.launch, ...(await programAccounts()) }), ...refund];
}

/**
 * A failed launch's seat returned to its wallet: anyone may send it, the sender paying the fee. In a quote other than SOL
 * the deposit goes to the wallet's associated account of the quote, which must exist.
 */
export async function withdrawFailedInstructions(r: Refund & { computeUnitPrice: bigint }): Promise<Instruction[]> {
  return [...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.withdrawFailed, r.quote), r.computeUnitPrice), await withdrawFailedInstruction(r)];
}

/**
 * Seats a refunds transaction returns through Heat's shared lookup table: each takes its seat and its wallet, so 8 fit
 * with room to spare (10 would); in a token quote each brings the wallet's account of the quote too, and 6 fit with room
 * to spare (7 would, 2026-11-04).
 */
export const REFUND_SEATS = 8;
export const REFUND_SEATS_IN_TOKENS = 6;
export const refundSeats = (quote?: QuoteToken | null) => (inSol(quote) ? REFUND_SEATS : REFUND_SEATS_IN_TOKENS);

/** Several seats of a failed launch returned to their wallets in one transaction, which anyone may send. */
export async function refundsInstructions(r: {
  launch: Address;
  seats: Omit<Refund, "launch" | "quote">[];
  computeUnitPrice: bigint;
  quote?: QuoteToken | null;
}): Promise<Instruction[]> {
  const refunds = await Promise.all(r.seats.map((seat) => withdrawFailedInstruction({ launch: r.launch, ...seat, quote: r.quote })));
  return [...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.withdrawFailed, r.quote) * r.seats.length, r.computeUnitPrice), ...refunds];
}

/**
 * A launch closed once it is done, its rent and its vault's returned to the creator; in a quote other than SOL its pot
 * closes too, anything sent to it besides the deposits going to the creator's associated account of the quote.
 */
export async function closeLaunchInstructions(c: { launch: Address; creator: Address; computeUnitPrice: bigint; quote?: QuoteToken | null }): Promise<Instruction[]> {
  const [vault] = await findVaultPda({ launch: c.launch });
  const quoteAccounts = { ...(await quoteAccountsOf(c.launch, c.quote)), creatorQuote: await walletQuoteOf(c.creator, c.quote) };
  const close = await getCloseLaunchInstructionAsync({ launch: c.launch, vault, creator: c.creator, ...quoteAccounts, ...(await programAccounts()) });
  return [...budget(unitsIn(FAIR_OPEN_COMPUTE_UNITS.closeLaunch, c.quote), c.computeUnitPrice), close];
}
