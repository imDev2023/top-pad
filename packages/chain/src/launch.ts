// The Instant launch's creation transaction (spec 2.2): DBC creates the coin and its pool on the Instant config, with the
// Creator wallet signing as `creator` and paying the pool's rent, and the fee program registers the coin's record in the
// same transaction with the launch key's signature. A coin is therefore a Heat coin from its first instant, or not at
// all, and the launch key's signature is what Vamp Shield and the Creator wallet rule gate (spec 6.2, 7).
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getInitializeVirtualPoolWithSplTokenInstructionAsync } from "@top-pad/clients/dbc";
import { FEE_PROGRAM_ADDRESS, findCoinRecordPda, getRegisterCoinInstructionAsync } from "@top-pad/clients/fee";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  dbcPoolAddress,
  eventAuthorityAddress,
  mintMetadataAddress,
} from "./dbc";

export type InstantLaunch = {
  /** Heat's Instant config, which has the first-swap discount off (spec 3.2). */
  config: Address;
  quoteMint: Address;
  /** The Creator wallet: DBC's `creator`, so terminals show it as the coin's dev, and the fee payer, so it pays the rent. */
  creator: TransactionSigner;
  /** A new key for the coin's mint, which DBC creates. */
  mint: TransactionSigner;
  /** The launch key, which co-signs and registers the coin (spec 10.3). */
  launchKey: TransactionSigner;
  coin: { name: string; ticker: string; uri: string };
  /** A priority fee in micro-lamports per compute unit; none when 0. */
  computeUnitPrice: bigint;
};

/**
 * The compute the creation may use: DBC's pool creation with its Metaplex call and `register_coin` together measured
 * 114,299 to 117,299 units on devnet (2026-10-29, `tests/devnet/src/instant-launch.test.ts`), the transaction 1,015 of
 * its 1,232 bytes.
 */
export const INSTANT_LAUNCH_COMPUTE_UNITS = 200_000;

/** The coin's pool and record, where an Instant launch's creation transaction makes them. */
export async function instantLaunchAccounts(l: Pick<InstantLaunch, "config" | "quoteMint" | "mint">) {
  const pool = await dbcPoolAddress(l.config, l.mint.address, l.quoteMint);
  const [coinRecord] = await findCoinRecordPda({ mint: l.mint.address });
  return { pool, coinRecord };
}

/** The creation transaction's instructions: the compute budget, DBC's pool creation, then the fee program's record. */
export async function instantLaunchInstructions(l: InstantLaunch): Promise<Instruction[]> {
  const { pool } = await instantLaunchAccounts(l);
  const createPool = await getInitializeVirtualPoolWithSplTokenInstructionAsync({
    config: l.config,
    creator: l.creator,
    baseMint: l.mint,
    quoteMint: l.quoteMint,
    pool,
    mintMetadata: await mintMetadataAddress(l.mint.address),
    payer: l.creator,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    params: { name: l.coin.name, symbol: l.coin.ticker, uri: l.coin.uri },
  });
  const register = await getRegisterCoinInstructionAsync({
    launchKey: l.launchKey,
    payer: l.creator,
    mint: l.mint.address,
    pool,
    config: l.config,
    eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
    program: FEE_PROGRAM_ADDRESS,
  });
  return [
    getSetComputeUnitLimitInstruction({ units: INSTANT_LAUNCH_COMPUTE_UNITS }),
    ...(l.computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: l.computeUnitPrice })] : []),
    createPool,
    register,
  ];
}

/** The creation transaction's message, the creator paying, on a recent blockhash. */
export async function instantLaunchMessage(l: InstantLaunch, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
  const instructions = await instantLaunchInstructions(l);
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(l.creator, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}
