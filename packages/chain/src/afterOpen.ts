// What follows a Fair Open's open once every seat has its coins (spec 2.1 steps 13 and 14): the Creator lock, which moves
// the creator's coins into a Jupiter Lock escrow; the Tax Share's collection once the Tax window ends; its pushes, which
// pay each seat and close it; and the launch closed. Anyone may send each of these, and Heat's keeper does, so the
// keeper, the scripts and the tests build the same transactions. Kit only. In a quote other than SOL every refund and Tax
// Share goes from the launch's pot to the wallet's associated account of the quote (ADR 0007 decision 1).
import { AccountRole, getProgramDerivedAddress, getAddressEncoder, getUtf8Encoder, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getCollectTaxShareInstructionAsync, getLockCreatorInstructionAsync, getPushTaxShareInstructionAsync } from "@top-pad/clients/fair-open";
import { findCoinRecordPda, findFeeConfigPda } from "@top-pad/clients/fee";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, eventAuthorityAddress, TOKEN_PROGRAM_ADDRESS } from "./dbc";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_CLAIMER_ADDRESS, FEE_PROGRAM_ADDRESS } from "./index";
import { quoteAccount, type ClaimablePool } from "./claims";
import { inSol, quoteAccountsOf, quoteTokenAccount, quoteTokenAccountInstruction, walletQuoteOf, type QuoteToken } from "./fairOpen";

/** Jupiter Lock (spec 5.3, ADR 0004), which holds the Creator lock. */
export const JUPITER_LOCK_PROGRAM_ADDRESS = "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn" as Address;
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
/** The Creator lock (spec 2.1 step 13, 12): nothing for 7 days after the open, all of it free 30 days after it. */
export const CREATOR_LOCK_CLIFF_SECONDS = 7n * 24n * 3600n;
export const CREATOR_LOCK_END_SECONDS = 30n * 24n * 3600n;

/**
 * The compute each may use, with room over what LiteSVM measured (2026-11-01, `programs/fair_open/tests/lock_and_tax.rs`):
 * the lock 107,499 units, the collection 135,109 (most of it the pass over the launch's counts that finds the open's
 * lamport dust), and a Tax Share push about 37,500 plus 2,000 a seat. The devnet figures are in spec 5.3.
 */
export const LOCK_CREATOR_COMPUTE_UNITS = 160_000;
export const COLLECT_TAX_SHARE_COMPUTE_UNITS = 200_000;
export const TAX_SHARE_COMPUTE_UNITS = { base: 45_000, seat: 4_000 } as const;
/**
 * Seats a Tax Share push pays and closes (spec 2.1 step 14): the most a transaction holds, each seat bringing two
 * addresses no lookup table can hold, the seat and its wallet; 14 come to 1,258 bytes against the 1,232-byte limit.
 */
export const TAX_SHARE_SEATS = 13;
/** In a token quote each seat brings a third address, its wallet's account of the quote: 8 fit (1,163 bytes). */
export const TAX_SHARE_SEATS_IN_TOKENS = 8;
export const taxShareSeats = (quote?: QuoteToken | null) => (inSol(quote) ? TAX_SHARE_SEATS : TAX_SHARE_SEATS_IN_TOKENS);

const priced = (computeUnitPrice: bigint) => (computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []);
const budget = (units: number, computeUnitPrice: bigint) => [getSetComputeUnitLimitInstruction({ units }), ...priced(computeUnitPrice)];
const bytes = getAddressEncoder();
const utf8 = getUtf8Encoder();

/** A launch's creator locker, the PDA that funds the Creator lock's escrow and sends it the creator's coins. */
export async function creatorLockerAddress(launch: Address): Promise<Address> {
  const [locker] = await getProgramDerivedAddress({ programAddress: FAIR_OPEN_PROGRAM_ADDRESS, seeds: [utf8.encode("creator_lock"), bytes.encode(launch)] });
  return locker;
}

/** The Creator lock's Jupiter Lock escrow for a launch: Lock's PDA of the launch's creator locker. */
export async function creatorLockEscrowAddress(launch: Address): Promise<Address> {
  const locker = await creatorLockerAddress(launch);
  const [escrow] = await getProgramDerivedAddress({ programAddress: JUPITER_LOCK_PROGRAM_ADDRESS, seeds: [utf8.encode("escrow"), bytes.encode(locker)] });
  return escrow;
}

/**
 * The Creator lock of a launch, which anyone may send once it has opened: the creator's seat, its coins and the escrow;
 * in a token quote the seat's refund goes to the creator's associated account of the quote.
 */
export async function lockCreatorInstructions(l: {
  launch: Address;
  creator: Address;
  seat: Address;
  mint: Address;
  pool: Address;
  computeUnitPrice: bigint;
  quote?: QuoteToken | null;
}): Promise<Instruction[]> {
  const tokens = { mint: l.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const escrow = await creatorLockEscrowAddress(l.launch);
  const lock = await getLockCreatorInstructionAsync({
    launch: l.launch,
    seat: l.seat,
    creator: l.creator,
    pool: l.pool,
    potCoins: (await findAssociatedTokenPda({ owner: l.launch, ...tokens }))[0],
    mint: l.mint,
    escrow,
    escrowCoins: (await findAssociatedTokenPda({ owner: escrow, ...tokens }))[0],
    lockEventAuthority: await eventAuthorityAddress(JUPITER_LOCK_PROGRAM_ADDRESS),
    ...(await quoteAccountsOf(l.launch, l.quote)),
    creatorQuote: await walletQuoteOf(l.creator, l.quote),
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
  });
  const units = LOCK_CREATOR_COMPUTE_UNITS + (inSol(l.quote) ? 0 : 20_000);
  return [...budget(units, l.computeUnitPrice), lock];
}

/**
 * The Tax Share's collection, which anyone may send once the coin's Tax window has ended: the fee program's window claim
 * pays the window's fees, less the pot's own fee, into the launch's pot, in SOL unwrapped into its vault in the same
 * instruction. In a token quote `payer` first makes the fee claimer's and the treasury's associated accounts of the quote
 * if either is missing: DBC names the fee claimer's in its claim, and the treasury's takes a Tax Share no seat may.
 */
export async function collectTaxShareInstructions(c: {
  launch: Address;
  pool: ClaimablePool;
  treasury: Address;
  computeUnitPrice: bigint;
  quote?: QuoteToken | null;
  payer?: TransactionSigner;
}): Promise<Instruction[]> {
  const p = c.pool;
  const quote = c.quote && !inSol(c.quote) ? c.quote : null;
  if (quote && !c.payer) throw new Error("the Tax Share's collection in a token quote needs a payer for the quote accounts it names");
  const accounts = quote
    ? [await quoteTokenAccountInstruction(c.payer!, FEE_CLAIMER_ADDRESS, quote), await quoteTokenAccountInstruction(c.payer!, c.treasury, quote)]
    : [];
  const collect = await getCollectTaxShareInstructionAsync({
    launch: c.launch,
    quoteMint: p.quoteMint,
    treasury: c.treasury,
    feeConfig: (await findFeeConfigPda())[0],
    coinRecord: (await findCoinRecordPda({ mint: p.mint }))[0],
    feeClaimer: FEE_CLAIMER_ADDRESS,
    feeClaimerTokenAccount: quote ? await quoteTokenAccount(FEE_CLAIMER_ADDRESS, quote) : await quoteAccount(FEE_CLAIMER_ADDRESS, p.quoteMint),
    poolAuthority: DBC_POOL_AUTHORITY,
    dbcConfig: p.config,
    pool: p.pool,
    baseVault: p.baseVault,
    quoteVault: p.quoteVault,
    mint: p.mint,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    dbcEventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    dbcProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    feeEventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
    feeProgram: FEE_PROGRAM_ADDRESS,
    ...(quote ? { tokenProgram: quote.tokenProgram, treasuryQuote: await quoteTokenAccount(c.treasury, quote) } : {}),
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
  });
  const units = COLLECT_TAX_SHARE_COMPUTE_UNITS + accounts.length * 25_000;
  return [...budget(units, c.computeUnitPrice), ...accounts, collect];
}

/** A seat to pay its Tax Share and close, with the wallet that gets both. */
export type TaxShareSeat = { seat: Address; wallet: Address };

/**
 * A push of up to `taxShareSeats(quote)` seats' Tax Share, which anyone may send once the Tax Share is collected; in a
 * token quote each seat brings its wallet's associated account of the quote, which its share goes to.
 */
export async function pushTaxShareInstructions(p: { launch: Address; seats: TaxShareSeat[]; computeUnitPrice: bigint; quote?: QuoteToken | null }): Promise<Instruction[]> {
  const push = await getPushTaxShareInstructionAsync({
    launch: p.launch,
    ...(await quoteAccountsOf(p.launch, p.quote)),
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
  });
  const seats: { address: Address; role: AccountRole }[] = [];
  for (const s of p.seats) {
    const quoteAccount = inSol(p.quote) ? [] : [await quoteTokenAccount(s.wallet, p.quote!)];
    seats.push(...[s.seat, s.wallet, ...quoteAccount].map((address) => ({ address, role: AccountRole.WRITABLE })));
  }
  // In a token quote each seat's share is a `TransferChecked`: about 9,000 units more a seat (LiteSVM, 2026-11-04).
  const perSeat = TAX_SHARE_COMPUTE_UNITS.seat + (inSol(p.quote) ? 0 : 12_000);
  const units = TAX_SHARE_COMPUTE_UNITS.base + perSeat * p.seats.length;
  return [...budget(units, p.computeUnitPrice), { ...push, accounts: [...push.accounts, ...seats] }];
}

/**
 * A seat's Tax Share, as the program pays it (spec 2.1 step 14): the Tax Share `total` in proportion to each seat's fill
 * among seats whose fills add up to `basis`, each seat paid getting what its fill adds to the total's share of the fills
 * paid so far, rounded down, so the shares add up to the total to the lamport.
 */
export function taxShareOf(total: bigint, basis: bigint, paid: bigint, fill: bigint): bigint {
  if (basis === 0n) return 0n;
  const upto = (fills: bigint) => (total * (fills < basis ? fills : basis)) / basis;
  return upto(paid + fill) - upto(paid);
}
