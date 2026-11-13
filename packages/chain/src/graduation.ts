// Graduation (spec 2.3, 3.4): a coin whose curve holds its Graduation Target migrates into a DAMM v2 pool, which Heat's
// keeper does since anyone may; DBC creates the pool on Meteora's customizable DAMM v2 config with both halves of its
// liquidity permanently locked, the creator's position NFT to the creator and Heat's to the fee program's `fee_claimer`
// PDA. Then the fee program splits the partner's surplus and burns the leftover, and claims Heat's LP fees to the
// treasury whenever anyone asks, while the creator claims theirs from Meteora directly. A graduated coin trades on its
// DAMM v2 pool, and these are the addresses and instructions for all of it.
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import {
  CP_AMM_PROGRAM_ADDRESS,
  findPositionNftAccountPda,
  findPositionPda,
  getClaimPositionFeeInstruction,
  getSwap2Instruction as getDammSwap2Instruction,
} from "@top-pad/clients/damm-v2";
import { findMigrationMetadataPda, getMigrationDammV2Instruction, type PoolState } from "@top-pad/clients/dbc";
import { getBurnLeftoverInstruction, getClaimLpFeesInstructionAsync, getClaimSurplusInstructionAsync } from "@top-pad/clients/fee";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, eventAuthorityAddress, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "./dbc";
import type { QuoteToken } from "./fairOpen";
import { FEE_CLAIMER_ADDRESS, FEE_PROGRAM_ADDRESS } from "./index";

export const DAMM_V2_PROGRAM_ADDRESS = CP_AMM_PROGRAM_ADDRESS;
/** DAMM v2's pool authority, owner of every pool's vaults. */
export const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC" as Address;
/** DBC's pool authority, which creates the graduated pool and owns both positions until it hands them on. */
export const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;

/**
 * Meteora's DAMM v2 config for a DBC migration with `MigrationFeeOption::Customizable`, which Heat's configs use so the
 * graduated pool takes the market-cap fee schedule (spec 3.2, 3.4): DBC requires its `pool_creator_authority` to be DBC's
 * pool authority. It is the last of the DBC SDK's `DAMM_V2_MIGRATION_FEE_ADDRESS` (2.0.0), the same on devnet and
 * mainnet; on devnet it is owned by DAMM v2 (read 2026-11-02).
 */
export const DAMM_V2_MIGRATION_CONFIG = "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck" as Address;

/**
 * The compute a migration may use: DBC's migration creates the DAMM v2 pool and two positions, locks both and hands them
 * on, all by CPI. The DBC SDK sets 600,000 (`MIGRATE_DAMM_V2_COMPUTE_UNITS`); measured on devnet in
 * `tests/devnet/src/graduation.test.ts`.
 */
export const MIGRATION_COMPUTE_UNITS = 600_000;
/** What one of the fee program's Graduation claims may use, with the associated accounts it opens. */
export const GRADUATION_CLAIM_COMPUTE_UNITS = 120_000;

const utf8 = getUtf8Encoder();
const addressBytes = getAddressEncoder();

/** The larger and the smaller of two addresses by their bytes, the order a pool's seeds put its two mints in. */
function ordered(a: Address, b: Address): [Uint8Array, Uint8Array] {
  const x = addressBytes.encode(a) as Uint8Array;
  const y = addressBytes.encode(b) as Uint8Array;
  for (let i = 0; i < 32; i++) {
    if (x[i] !== y[i]) return x[i]! > y[i]! ? [x, y] : [y, x];
  }
  return [x, y];
}

/** A DAMM v2 pool on a config: one per config and pair of mints. */
export async function dammV2PoolAddress(config: Address, mintA: Address, mintB: Address): Promise<Address> {
  const [larger, smaller] = ordered(mintA, mintB);
  const [pool] = await getProgramDerivedAddress({
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    seeds: [utf8.encode("pool"), addressBytes.encode(config), larger, smaller],
  });
  return pool;
}

/** Where a coin's graduated pool is, whoever migrates it: the coin is its token A and the quote its token B. */
export const graduatedPoolAddress = (mint: Address, quoteMint: Address) => dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIG, mint, quoteMint);

/** A DAMM v2 pool's vault of one of its mints. */
export async function dammV2VaultAddress(pool: Address, mint: Address): Promise<Address> {
  const [vault] = await getProgramDerivedAddress({
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    seeds: [utf8.encode("token_vault"), addressBytes.encode(mint), addressBytes.encode(pool)],
  });
  return vault;
}

/** A DAMM v2 position and its NFT account, both found from the NFT's mint. */
export async function positionAddresses(nftMint: Address): Promise<{ position: Address; nftAccount: Address }> {
  const [[position], [nftAccount]] = await Promise.all([findPositionPda({ positionNftMint: nftMint }), findPositionNftAccountPda({ positionNftMint: nftMint })]);
  return { position, nftAccount };
}

/** A pool whose curve is complete, as its migration needs it. */
export type Graduating = {
  pool: Address;
  config: Address;
  mint: Address;
  quoteMint: Address;
  /** The quote's token program: SPL Token, or Token-2022 for an xStock, the graduated pool's token B too. */
  quoteTokenProgram: Address;
  baseVault: Address;
  quoteVault: Address;
};

/** A pool's state as DBC holds it, for its migration. */
export const graduating = (pool: Address, state: PoolState, quote: QuoteToken): Graduating => ({
  pool,
  config: state.config,
  mint: state.baseMint,
  quoteMint: quote.mint,
  quoteTokenProgram: quote.tokenProgram,
  baseVault: state.baseVault,
  quoteVault: state.quoteVault,
});

/** DBC's `MigrationProgress`: a complete curve waits at `LockedVesting` (no locked vesting on Heat's configs), then `CreatedPool`. */
export const MIGRATION_PROGRESS = { preBondingCurve: 0, postBondingCurve: 1, lockedVesting: 2, createdPool: 3 } as const;

export type Migration = {
  pool: Graduating;
  /** Pays the graduated pool's rent and the network fee: Heat's keeper. */
  payer: TransactionSigner;
  /** New keys for the two positions' NFT mints, which sign the migration that creates them. */
  firstPositionNft: TransactionSigner;
  secondPositionNft: TransactionSigner;
  computeUnitPrice: bigint;
};

/**
 * A migration's instructions: DBC's `migration_damm_v2`, which anyone may send once the curve is complete, creating the
 * graduated pool at the coin's price with both positions permanently locked, the larger half first (the creator's,
 * when the two are equal) and each handed to its owner, the creator role holder and the configs' fee claimer.
 */
export async function migrationInstructions(m: Migration): Promise<Instruction[]> {
  const p = m.pool;
  const dammPool = await graduatedPoolAddress(p.mint, p.quoteMint);
  const first = await positionAddresses(m.firstPositionNft.address);
  const second = await positionAddresses(m.secondPositionNft.address);
  const migrate = getMigrationDammV2Instruction({
    virtualPool: p.pool,
    // Unused since DBC 0.1.7, still named.
    migrationMetadata: (await findMigrationMetadataPda({ virtualPool: p.pool }))[0],
    config: p.config,
    poolAuthority: DBC_POOL_AUTHORITY,
    pool: dammPool,
    firstPositionNftMint: m.firstPositionNft,
    firstPositionNftAccount: first.nftAccount,
    firstPosition: first.position,
    secondPositionNftMint: m.secondPositionNft,
    secondPositionNftAccount: second.nftAccount,
    secondPosition: second.position,
    dammPoolAuthority: DAMM_V2_POOL_AUTHORITY,
    ammProgram: DAMM_V2_PROGRAM_ADDRESS,
    baseMint: p.mint,
    quoteMint: p.quoteMint,
    tokenAVault: await dammV2VaultAddress(dammPool, p.mint),
    tokenBVault: await dammV2VaultAddress(dammPool, p.quoteMint),
    baseVault: p.baseVault,
    quoteVault: p.quoteVault,
    payer: m.payer,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    tokenQuoteProgram: p.quoteTokenProgram,
    token2022Program: TOKEN_2022_PROGRAM_ADDRESS,
    dammEventAuthority: await eventAuthorityAddress(DAMM_V2_PROGRAM_ADDRESS),
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
  });
  return [
    getSetComputeUnitLimitInstruction({ units: MIGRATION_COMPUTE_UNITS }),
    ...priced(m.computeUnitPrice),
    // DBC reads the DAMM v2 config as its first remaining account.
    { ...migrate, accounts: [...migrate.accounts, { address: DAMM_V2_MIGRATION_CONFIG, role: AccountRole.READONLY }] },
  ];
}

const priced = (computeUnitPrice: bigint) => (computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []);

/** DBC's share of a surplus for the partner and creator together (`PARTNER_AND_CREATOR_SURPLUS_SHARE`), the rest Meteora's. */
const PARTNER_AND_CREATOR_SURPLUS_SHARE = 80n;

/**
 * What the fee program's `claim_surplus` pays a complete pool, as DBC computes the partner's surplus: a fifth of what
 * the pool raised past its Graduation Target is Meteora's, and Heat's configs give the creator no part of the rest, so
 * the partner's is all of it, which the fee program splits like Creator Earnings.
 */
export function surplusOf(quoteReserve: bigint, graduationTarget: bigint): { creator: bigint; treasury: bigint } {
  const total = quoteReserve > graduationTarget ? quoteReserve - graduationTarget : 0n;
  const partner = (total * PARTNER_AND_CREATOR_SURPLUS_SHARE) / 100n;
  const creator = partner / 2n;
  return { creator, treasury: partner - creator };
}

/** `owner`'s associated account of a coin, opened if missing: every Heat coin is an SPL Token mint. */
async function associated(payer: TransactionSigner, owner: Address, mint: Address) {
  return getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint });
}

/** `owner`'s associated account of a quote under its token program, opened if missing. */
async function associatedQuote(payer: TransactionSigner, owner: Address, q: { quoteMint: Address; quoteTokenProgram: Address }) {
  const ata = await accountOf(owner, q.quoteMint, q.quoteTokenProgram);
  return getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint: q.quoteMint, tokenProgram: q.quoteTokenProgram });
}

export type SurplusClaim = {
  pool: Graduating;
  /** Whoever holds the pool's DBC creator role now, who is paid the creator's half. */
  creator: Address;
  treasury: Address;
  /** What it pays, from `surplusOf`: a creator's account is opened only if it is paid something. */
  surplus: { creator: bigint; treasury: bigint };
  payer: TransactionSigner;
  computeUnitPrice: bigint;
};

/** The surplus's claim: the accounts it pays opened if missing, then `claim_surplus`. */
export async function surplusClaimInstructions(s: SurplusClaim): Promise<Instruction[]> {
  const { pool, payer } = s;
  const [creatorTokenAccount, treasuryTokenAccount, feeClaimerTokenAccount] = await Promise.all([
    accountOf(s.creator, pool.quoteMint, pool.quoteTokenProgram),
    accountOf(s.treasury, pool.quoteMint, pool.quoteTokenProgram),
    accountOf(FEE_CLAIMER_ADDRESS, pool.quoteMint, pool.quoteTokenProgram),
  ]);
  return [
    getSetComputeUnitLimitInstruction({ units: GRADUATION_CLAIM_COMPUTE_UNITS }),
    ...priced(s.computeUnitPrice),
    await associatedQuote(payer, FEE_CLAIMER_ADDRESS, pool),
    ...(s.surplus.creator > 0n ? [await associatedQuote(payer, s.creator, pool)] : []),
    ...(s.surplus.treasury > 0n ? [await associatedQuote(payer, s.treasury, pool)] : []),
    await getClaimSurplusInstructionAsync({
      creatorTokenAccount,
      treasuryTokenAccount,
      feeClaimerTokenAccount,
      config: pool.config,
      pool: pool.pool,
      quoteVault: pool.quoteVault,
      quoteMint: pool.quoteMint,
      tokenQuoteProgram: pool.quoteTokenProgram,
      eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
      program: FEE_PROGRAM_ADDRESS,
    }),
  ];
}

/** The leftover's burn: the fee claimer's account of the coin opened if missing, as DBC pays into it, then `burn_leftover`. */
export async function burnLeftoverInstructions(b: { pool: Graduating; payer: TransactionSigner; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const { pool, payer } = b;
  return [
    getSetComputeUnitLimitInstruction({ units: GRADUATION_CLAIM_COMPUTE_UNITS }),
    ...priced(b.computeUnitPrice),
    await associated(payer, FEE_CLAIMER_ADDRESS, pool.mint),
    getBurnLeftoverInstruction({
      feeClaimer: FEE_CLAIMER_ADDRESS,
      feeClaimerCoinAccount: await accountOf(FEE_CLAIMER_ADDRESS, pool.mint, TOKEN_PROGRAM_ADDRESS),
      poolAuthority: DBC_POOL_AUTHORITY,
      config: pool.config,
      pool: pool.pool,
      baseVault: pool.baseVault,
      mint: pool.mint,
      tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
      dbcEventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
      dbcProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
      program: FEE_PROGRAM_ADDRESS,
    }),
  ];
}

/** A graduated pool, and one position in it with its NFT. */
export type GraduatedPosition = {
  /** The DAMM v2 pool. */
  pool: Address;
  mint: Address;
  quoteMint: Address;
  /** The quote's token program, token B's in the pool. */
  quoteTokenProgram: Address;
  position: Address;
  nftAccount: Address;
};

/** Heat's LP fee claim: the treasury's quote account and the fee claimer's coin account opened if missing, then `claim_lp_fees`. */
export async function lpFeeClaimInstructions(c: { heat: GraduatedPosition; treasury: Address; payer: TransactionSigner; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const { heat, payer } = c;
  return [
    getSetComputeUnitLimitInstruction({ units: GRADUATION_CLAIM_COMPUTE_UNITS }),
    ...priced(c.computeUnitPrice),
    await associatedQuote(payer, c.treasury, heat),
    await associated(payer, FEE_CLAIMER_ADDRESS, heat.mint),
    await getClaimLpFeesInstructionAsync({
      treasuryTokenAccount: await accountOf(c.treasury, heat.quoteMint, heat.quoteTokenProgram),
      feeClaimerCoinAccount: await accountOf(FEE_CLAIMER_ADDRESS, heat.mint, TOKEN_PROGRAM_ADDRESS),
      pool: heat.pool,
      position: heat.position,
      positionNftAccount: heat.nftAccount,
      tokenAVault: await dammV2VaultAddress(heat.pool, heat.mint),
      tokenBVault: await dammV2VaultAddress(heat.pool, heat.quoteMint),
      mint: heat.mint,
      quoteMint: heat.quoteMint,
      tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
      tokenQuoteProgram: heat.quoteTokenProgram,
      eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
      program: FEE_PROGRAM_ADDRESS,
    }),
  ];
}

/**
 * The creator's LP fee claim, straight from Meteora (spec 4): DAMM v2's `claim_position_fee` on the creator's own
 * position, signed by the creator, paying the quote into their quote account and the coin's fees, never any on a pool
 * collecting in the quote, into their coin account. The caller opens the quote account and closes it after.
 */
export async function creatorLpFeeClaimInstructions(c: { position: GraduatedPosition; creator: TransactionSigner }): Promise<Instruction[]> {
  const { position, creator } = c;
  return [
    await associated(creator, creator.address, position.mint),
    getClaimPositionFeeInstruction({
      poolAuthority: DAMM_V2_POOL_AUTHORITY,
      pool: position.pool,
      position: position.position,
      tokenAAccount: await accountOf(creator.address, position.mint, TOKEN_PROGRAM_ADDRESS),
      tokenBAccount: await accountOf(creator.address, position.quoteMint, position.quoteTokenProgram),
      tokenAVault: await dammV2VaultAddress(position.pool, position.mint),
      tokenBVault: await dammV2VaultAddress(position.pool, position.quoteMint),
      tokenAMint: position.mint,
      tokenBMint: position.quoteMint,
      positionNftAccount: position.nftAccount,
      signer: creator,
      tokenAProgram: TOKEN_PROGRAM_ADDRESS,
      tokenBProgram: position.quoteTokenProgram,
      eventAuthority: await eventAuthorityAddress(DAMM_V2_PROGRAM_ADDRESS),
      program: DAMM_V2_PROGRAM_ADDRESS,
    }),
  ];
}

/** `owner`'s associated account of `mint` under `tokenProgram`. */
async function accountOf(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return account;
}

/** DAMM v2's `SwapMode`, as `swap2` takes it. */
const DAMM_SWAP_MODES = { exact_in: 0, partial_fill: 1 } as const;

/** A swap on a graduated pool: DAMM v2's `swap2`, the coin token A and the quote token B. */
export type DammSwap = {
  pool: Address;
  mint: Address;
  quoteMint: Address;
  /** The quote's token program, token B's in the pool. */
  quoteTokenProgram: Address;
  trader: TransactionSigner;
  /** The trader's accounts: the quote's on a buy is the input, the coin's the output; a sell the other way round. */
  quoteAccount: Address;
  coinAccount: Address;
  side: "buy" | "sell";
  amountIn: bigint;
  minimumOut: bigint;
  referralAccount?: Address | null;
};

/** DAMM v2's `swap2`, exact in, between the trader's accounts. */
export async function dammSwapInstruction(s: DammSwap): Promise<Instruction> {
  const buy = s.side === "buy";
  return getDammSwap2Instruction({
    poolAuthority: DAMM_V2_POOL_AUTHORITY,
    pool: s.pool,
    inputTokenAccount: buy ? s.quoteAccount : s.coinAccount,
    outputTokenAccount: buy ? s.coinAccount : s.quoteAccount,
    tokenAVault: await dammV2VaultAddress(s.pool, s.mint),
    tokenBVault: await dammV2VaultAddress(s.pool, s.quoteMint),
    tokenAMint: s.mint,
    tokenBMint: s.quoteMint,
    payer: s.trader,
    tokenAProgram: TOKEN_PROGRAM_ADDRESS,
    tokenBProgram: s.quoteTokenProgram,
    referralTokenAccount: s.referralAccount ?? undefined,
    eventAuthority: await eventAuthorityAddress(DAMM_V2_PROGRAM_ADDRESS),
    program: DAMM_V2_PROGRAM_ADDRESS,
    params: { amount0: s.amountIn, amount1: s.minimumOut, swapMode: DAMM_SWAP_MODES.exact_in },
  });
}
