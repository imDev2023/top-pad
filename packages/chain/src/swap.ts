// A swap on a Heat coin's pool (DBC's `swap2`, exact in), with the wrapping SOL needs around it: what the devnet scripts
// trade with, and what quick buy builds on the server (spec 10.1, "Trading").
import { AccountRole, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { findBaseVaultPda, findQuoteVaultPda, getSwap2Instruction } from "@top-pad/clients/dbc";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, eventAuthorityAddress } from "./dbc";
import { WSOL_MINT } from "./index";

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
/** DBC's `SwapMode::ExactIn`: spend exactly `amountIn`, receive at least `minimumOut`. */
const EXACT_IN = 0;

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
};

/**
 * The instructions of one exact-in swap: the trader's coin and quote accounts opened if missing, SOL wrapped for a buy,
 * the swap, and the wrapped SOL account closed again so what is left (a sell's proceeds) returns as SOL.
 */
export async function swapInstructions(swap: Swap): Promise<Instruction[]> {
  const { trader, mint, quoteMint, pool } = swap;
  const tokens = { tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const [quoteAccount] = await findAssociatedTokenPda({ owner: trader.address, mint: quoteMint, ...tokens });
  const [coinAccount] = await findAssociatedTokenPda({ owner: trader.address, mint, ...tokens });
  const wrapped = quoteMint === WSOL_MINT;
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
    payer: trader,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    params: { amount0: swap.amountIn, amount1: swap.minimumOut, swapMode: EXACT_IN },
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: trader, owner: trader.address, mint: quoteMint }),
    ...(buy && wrapped
      ? [getTransferSolInstruction({ source: trader, destination: quoteAccount, amount: swap.amountIn }), getSyncNativeInstruction({ account: quoteAccount })]
      : []),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: trader, owner: trader.address, mint }),
    // DBC reads the instructions sysvar on a swap, as Meteora's SDK passes it.
    { ...dbcSwap, accounts: [...dbcSwap.accounts, { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY }] },
    ...(wrapped ? [getCloseAccountInstruction({ account: quoteAccount, destination: trader.address, owner: trader })] : []),
  ];
}
