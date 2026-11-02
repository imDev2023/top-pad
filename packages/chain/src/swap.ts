// A swap on a Heat coin's pool (DBC's `swap2`, or DAMM v2's `swap2` once the coin has graduated), with the wrapping SOL
// needs around it: what the devnet scripts trade with, and what quick buy and sell build on the server (spec 10.1,
// "Trading"), naming Heat's referral account so Heat earns Meteora's referral share on every swap its site builds
// (spec 4).
import {
  AccountRole,
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
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { findBaseVaultPda, findQuoteVaultPda, getSwap2Instruction } from "@top-pad/clients/dbc";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, eventAuthorityAddress } from "./dbc";
import { dammSwapInstruction } from "./graduation";
import { WSOL_MINT } from "./index";

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
/**
 * DBC's `SwapMode`: exact in spends exactly `amountIn` and fails if the curve cannot take it all; a partial fill spends
 * what the curve can take before it completes and leaves the rest with the trader, which is how quick buy sends a buy,
 * so the buy that reaches Graduation lands rather than failing.
 */
const SWAP_MODES = { exact_in: 0, partial_fill: 1 } as const;

/**
 * What a quick swap may use of the compute budget: DBC's swap with its events, both associated accounts opened, and
 * the wrapping around it; measured on devnet at 58,711 to 69,850 units, the most a first buy that opens the trader's
 * coin account (`tests/devnet/src/quick-trade.test.ts`, 2026-11-02).
 */
export const SWAP_COMPUTE_UNITS = 100_000;

export type Swap = {
  config: Address;
  pool: Address;
  mint: Address;
  quoteMint: Address;
  /** Who swaps and pays: DBC's `payer`. */
  trader: TransactionSigner;
  side: "buy" | "sell";
  /** The quote spent on a buy, or the coins sold on a sell, in raw units. */
  amountIn: bigint;
  /** The least the swap may return, in raw units; the swap fails below it. */
  minimumOut: bigint;
  /** Exact in unless said; quick buy sends a buy as a partial fill. */
  mode?: keyof typeof SWAP_MODES;
  /** A quote account that takes Meteora's referral share of the fee: Heat's on every swap Heat's site builds. */
  referralAccount?: Address | null;
  /**
   * The coin's DAMM v2 pool once it has graduated (spec 2.3), where the swap then runs, exact in, instead of on its
   * curve; `config` and `pool` still name the curve.
   */
  graduatedPool?: Address | null;
};

/** A wallet's associated account of a mint: where a swap takes its coins from and pays them to. */
export async function tokenAccountOf(owner: Address, mint: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return account;
}

/** Heat's referral account (spec 4): the treasury's associated account of the quote, where its Platform Fee lands too. */
export const referralAccountOf = (treasury: Address, quoteMint: Address) => tokenAccountOf(treasury, quoteMint);

/**
 * The instructions of one exact-in swap: the trader's coin and quote accounts opened if missing, SOL wrapped for a buy,
 * the swap, and the wrapped SOL account closed again so what is left (a sell's proceeds) returns as SOL.
 */
export async function swapInstructions(swap: Swap): Promise<Instruction[]> {
  const { trader, mint, quoteMint } = swap;
  const tokens = { tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const [quoteAccount] = await findAssociatedTokenPda({ owner: trader.address, mint: quoteMint, ...tokens });
  const [coinAccount] = await findAssociatedTokenPda({ owner: trader.address, mint, ...tokens });
  const wrapped = quoteMint === WSOL_MINT;
  const buy = swap.side === "buy";
  const swapInstruction = swap.graduatedPool
    ? await dammSwapInstruction({
        pool: swap.graduatedPool,
        mint,
        quoteMint,
        trader,
        quoteAccount,
        coinAccount,
        side: swap.side,
        amountIn: swap.amountIn,
        minimumOut: swap.minimumOut,
        referralAccount: swap.referralAccount,
      })
    : await curveSwapInstruction(swap, quoteAccount, coinAccount);
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: trader, owner: trader.address, mint: quoteMint }),
    ...(buy && wrapped
      ? [getTransferSolInstruction({ source: trader, destination: quoteAccount, amount: swap.amountIn }), getSyncNativeInstruction({ account: quoteAccount })]
      : []),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: trader, owner: trader.address, mint }),
    swapInstruction,
    ...(wrapped ? [getCloseAccountInstruction({ account: quoteAccount, destination: trader.address, owner: trader })] : []),
  ];
}

/** DBC's `swap2` on the coin's curve, between the trader's accounts. */
async function curveSwapInstruction(swap: Swap, quoteAccount: Address, coinAccount: Address): Promise<Instruction> {
  const { mint, quoteMint, pool } = swap;
  const buy = swap.side === "buy";
  const dbcSwap = getSwap2Instruction({
    config: swap.config,
    pool,
    baseVault: (await findBaseVaultPda({ baseMint: mint, pool }))[0],
    quoteVault: (await findQuoteVaultPda({ quoteMint, pool }))[0],
    inputTokenAccount: buy ? quoteAccount : coinAccount,
    outputTokenAccount: buy ? coinAccount : quoteAccount,
    baseMint: mint,
    quoteMint,
    payer: swap.trader,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    referralTokenAccount: swap.referralAccount ?? undefined,
    params: { amount0: swap.amountIn, amount1: swap.minimumOut, swapMode: SWAP_MODES[swap.mode ?? "exact_in"] },
  });
  // DBC reads the instructions sysvar on a swap, as Meteora's SDK passes it.
  return { ...dbcSwap, accounts: [...dbcSwap.accounts, { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY }] };
}

/**
 * A quick buy or sell as the trader signs it (spec 9, screen 3): its compute budget, the swap with its wrapping, on a
 * recent blockhash, the trader paying the network fee.
 */
export async function swapMessage(swap: Swap, o: { computeUnitPrice: bigint; lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint } }) {
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: SWAP_COMPUTE_UNITS }),
    ...(o.computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: o.computeUnitPrice })] : []),
    ...(await swapInstructions(swap)),
  ];
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(swap.trader, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(o.lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}
