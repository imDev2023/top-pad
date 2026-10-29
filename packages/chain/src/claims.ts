// The fee program's claims (spec 4, 5.2): the window claim, which Heat's keeper sends the moment a coin's Tax window
// ends, and the claims of Creator Earnings, which a creator's page puts in one transaction. Each names DBC's accounts for
// the pool and each payee's associated quote account, and DBC pays straight from the pool into them.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  isTransactionMessageWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import type { PoolState } from "@top-pad/clients/dbc";
import {
  findCoinRecordPda,
  findWindowClaimPda,
  getClaimFeesInstructionAsync,
  getClaimUnlistedWindowFeesInstructionAsync,
  getClaimWindowFeesInstructionAsync,
  TAX_WINDOW_SECONDS,
} from "@top-pad/clients/fee";
import { eventAuthorityAddress, TOKEN_PROGRAM_ADDRESS } from "./dbc";
import { FEE_CLAIMER_ADDRESS, FEE_PROGRAM_ADDRESS, WSOL_MINT } from "./index";

/** A pool on one of Heat's configs, as its claims need it. */
export type ClaimablePool = {
  pool: Address;
  config: Address;
  mint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  /** Whoever holds the pool's DBC creator role now: the one a claim pays the creator's half to. */
  creator: Address;
  /** The partner's quote fees, accrued and not yet claimed, in raw units. */
  partnerQuoteFee: bigint;
  /** When its Tax window ends, Unix seconds: its activation point plus the window. */
  windowEndsAt: bigint;
};

/** A pool's claimable state, from DBC's `VirtualPool` account and the quote its config trades against. */
export function claimablePool(pool: Address, state: PoolState, quoteMint: Address): ClaimablePool {
  return {
    pool,
    config: state.config,
    mint: state.baseMint,
    quoteMint,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    creator: state.creator,
    partnerQuoteFee: state.partnerQuoteFee,
    windowEndsAt: state.activationPoint + TAX_WINDOW_SECONDS,
  };
}

/** The creator's half of a claim of `partnerQuoteFee`, rounded down as the fee program rounds it; the rest is Heat's. */
export const creatorShare = (partnerQuoteFee: bigint) => partnerQuoteFee / 2n;

/**
 * The compute a claim may use. Each pays out through DBC by CPI, about 16,000 units a payout with DBC's own event:
 * measured on devnet against DBC 0.2.2 (2026-10-29, `tests/devnet/src/fee-claims.test.ts`), the window claim used 37,820
 * and a creator's claim of one pool 61,722.
 */
export const WINDOW_CLAIM_COMPUTE_UNITS = 60_000;
export const FEE_CLAIM_COMPUTE_UNITS = 90_000;
/** What a transaction's other instructions take: up to two quote accounts opened, about 20,000 each, and one closed. */
const ACCOUNT_COMPUTE_UNITS = 50_000;

/** `owner`'s associated account for the pool's quote, where its share is paid. */
export async function quoteAccount(owner: Address, quoteMint: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint: quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return account;
}

/**
 * What every claim names: DBC's accounts for the pool, the fee claimer's own quote account in DBC's coin slot, and the
 * fee program's event authority.
 */
async function dbcAccounts(p: ClaimablePool) {
  return {
    config: p.config,
    pool: p.pool,
    baseVault: p.baseVault,
    quoteVault: p.quoteVault,
    mint: p.mint,
    quoteMint: p.quoteMint,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    feeClaimerTokenAccount: await quoteAccount(FEE_CLAIMER_ADDRESS, p.quoteMint),
    eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
    program: FEE_PROGRAM_ADDRESS,
  };
}

const priced = (computeUnitPrice: bigint) => (computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []);

export type WindowClaim = {
  pool: ClaimablePool;
  /** Whether a `CoinRecord` lists the pool: a Heat coin's window claim, or else a pool made around Heat's flow's. */
  heat: boolean;
  treasury: Address;
  /** Pays the network fee, opens the quote accounts if missing, and for a pool around Heat's flow its `WindowClaim`. */
  payer: TransactionSigner;
  computeUnitPrice: bigint;
};

/** A window claim's transaction: the treasury's and the fee claimer's quote accounts opened if missing, then the claim. */
export async function windowClaimInstructions(w: WindowClaim): Promise<Instruction[]> {
  const { pool, treasury, payer } = w;
  const accounts = { ...(await dbcAccounts(pool)), treasuryTokenAccount: await quoteAccount(treasury, pool.quoteMint) };
  const claim = w.heat ? await getClaimWindowFeesInstructionAsync(accounts) : await getClaimUnlistedWindowFeesInstructionAsync({ ...accounts, payer });
  return [
    getSetComputeUnitLimitInstruction({ units: WINDOW_CLAIM_COMPUTE_UNITS + ACCOUNT_COMPUTE_UNITS }),
    ...priced(w.computeUnitPrice),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: treasury, mint: pool.quoteMint }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: FEE_CLAIMER_ADDRESS, mint: pool.quoteMint }),
    claim,
  ];
}

/** One pool's claim of Creator Earnings: up to `maxAmount` of its partner fees, of which half is the creator's. */
export type FeeClaim = { pool: ClaimablePool; heat: boolean; maxAmount: bigint };

export type CreatorClaim = {
  /** The creator role holder of every pool claimed, who signs and pays the network fee. */
  creator: TransactionSigner;
  claims: FeeClaim[];
  treasury: Address;
  computeUnitPrice: bigint;
};

/**
 * A creator's claim of their Creator Earnings across pools that share a quote: their quote account opened if missing,
 * one `claim_fees` per pool, then, when the quote is wrapped SOL, the account closed so the earnings arrive as SOL.
 */
export async function creatorClaimInstructions(c: CreatorClaim): Promise<Instruction[]> {
  const { creator, claims, treasury } = c;
  const quoteMint = claims[0]?.pool.quoteMint;
  if (!quoteMint) throw new Error("a creator's claim needs at least one pool");
  if (claims.some((x) => x.pool.quoteMint !== quoteMint)) throw new Error("a creator's claim pays one quote");
  if (claims.some((x) => x.pool.creator !== creator.address)) throw new Error("a creator claims only pools whose creator role they hold");
  const creatorTokenAccount = await quoteAccount(creator.address, quoteMint);
  const treasuryTokenAccount = await quoteAccount(treasury, quoteMint);
  const instructions: Instruction[] = [];
  for (const claim of claims) {
    const window = claim.heat ? (await findCoinRecordPda({ mint: claim.pool.mint }))[0] : (await findWindowClaimPda({ pool: claim.pool.pool }))[0];
    instructions.push(
      await getClaimFeesInstructionAsync({ ...(await dbcAccounts(claim.pool)), window, creatorTokenAccount, treasuryTokenAccount, maxAmount: claim.maxAmount }),
    );
  }
  const unwrap = quoteMint === WSOL_MINT;
  return [
    getSetComputeUnitLimitInstruction({ units: claims.length * FEE_CLAIM_COMPUTE_UNITS + ACCOUNT_COMPUTE_UNITS }),
    ...priced(c.computeUnitPrice),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: creator, owner: creator.address, mint: quoteMint }),
    ...instructions,
    ...(unwrap ? [getCloseAccountInstruction({ account: creatorTokenAccount, destination: creator.address, owner: creator })] : []),
  ];
}

/** A transaction message on a recent blockhash, `payer` paying. */
function message(payer: TransactionSigner, instructions: Instruction[], lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** A window claim's transaction message, its payer paying. */
export async function windowClaimMessage(w: WindowClaim, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
  return message(w.payer, await windowClaimInstructions(w), lifetime);
}

/**
 * A creator's claim as the fewest transactions that hold it: each claim names five accounts of its own pool, so a
 * transaction holds only a few pools (`claims.test.ts` says how many). Each is complete on its own, so a creator signs
 * them all at once and any that lands pays its pools exactly.
 */
export async function creatorClaimMessages(c: CreatorClaim, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
  const build = async (claims: FeeClaim[]) => message(c.creator, await creatorClaimInstructions({ ...c, claims }), lifetime);
  const batches: FeeClaim[][] = [];
  let batch: FeeClaim[] = [];
  for (const claim of c.claims) {
    if (batch.length && !isTransactionMessageWithinSizeLimit(await build([...batch, claim]))) {
      batches.push(batch);
      batch = [];
    }
    batch.push(claim);
  }
  if (batch.length) batches.push(batch);
  return Promise.all(batches.map(build));
}
