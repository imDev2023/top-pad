// A Fair Open's open and what follows it (spec 2.1 steps 6 and 10 to 12, ADR 0005): the coin's creation transaction for
// each rung of the creator's ladder, all signed at scheduling on the launch's durable nonce and squeezed through Heat's
// shared address lookup table; each seat's part of the open, by the reference the program's own must match; the pushes
// and claims that deliver it; and our keeper closing the nonce once the launch has opened or failed, its rent going back
// to the creator. Kit only, so the API, the keeper, the scripts and the tests build the same transactions.
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type Nonce,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getWithdrawNonceAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { findBaseVaultPda, findQuoteVaultPda, getInitializeVirtualPoolWithSplTokenInstructionAsync, getSwap2Instruction } from "@top-pad/clients/dbc";
import {
  findCoinRegistrarPda,
  findProgramConfigPda,
  findPotPda,
  getClaimInstructionAsync,
  getOpenInstructionAsync,
  getPushInstructionAsync,
  getSettleInstructionAsync,
  Tier,
  type Launch,
} from "@top-pad/clients/fair-open";
import { findCoinRecordPda, findFeeConfigPda } from "@top-pad/clients/fee";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_METADATA_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, dbcPoolAddress, eventAuthorityAddress, mintMetadataAddress } from "./dbc";
import { rungs } from "./fairOpen";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS, type HeatCluster } from "./index";

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const SYSVAR_RECENT_BLOCKHASHES = "SysvarRecentB1ockHashes11111111111111111111" as Address;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
/** DBC's pool authority, which owns every pool's vaults. */
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
/** DBC's `SwapMode::ExactIn`. */
const EXACT_IN = 0;

/**
 * The compute each transaction may use, from the programs' LiteSVM tests against our stand-in for DBC: the creation
 * transaction used 239,608 units there, of which DBC's own instructions are a stand-in's; a push about 46,000 a seat
 * (186,126 for four); a claim one seat's worth. The devnet tests measure them against the real DBC.
 */
export const OPEN_COMPUTE_UNITS = 450_000;
export const PUSH_COMPUTE_UNITS = { base: 30_000, seat: 60_000 } as const;
export const CLAIM_COMPUTE_UNITS = 80_000;
/** Seats per push: each takes three accounts of its own, and 8 fit a transaction with the shared lookup table. */
export const PUSH_SEATS = 8;

const budget = (units: number, computeUnitPrice: bigint) => [
  getSetComputeUnitLimitInstruction({ units }),
  ...(computeUnitPrice > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })] : []),
];

// --- A seat's part of the open (spec 2.1 step 11) ------------------------------------------------------------------------

/**
 * A seat's share of an open: what its fill spent of the rung, rounded up, and the coins it bought, rounded down
 * (`allocation::share` in the program), so every seat buys at the pot's one price.
 */
export function shareOf(fill: bigint, spend: bigint, spent: bigint, coins: bigint): { spent: bigint; coins: bigint } {
  if (spend === 0n) return { spent: 0n, coins: 0n };
  return { spent: (fill * spent + spend - 1n) / spend, coins: (fill * coins) / spend };
}

/** What an opened launch records of its open. */
export type Opened = Pick<Launch, "spend" | "spent" | "coins" | "othersLevel" | "unverifiedLevel">;

/** A seat's part of an open (`Launch::outcome` in the program): its fill, what it spent, its coins and its refund. */
export function seatOutcome(open: Opened, tier: Tier, deposit: bigint) {
  const level = tier === Tier.Unverified ? open.unverifiedLevel : open.othersLevel;
  const fill = deposit < level ? deposit : level;
  const { spent, coins } = shareOf(fill, open.spend, open.spent, open.coins);
  return { fill, spent, coins, refund: deposit - spent };
}

// --- The creation transaction (spec 2.1 step 10) -------------------------------------------------------------------------

export type Creation = {
  launch: Address;
  dbcConfig: Address;
  quoteMint: Address;
  /** The Creator wallet, DBC's `creator`, so terminals show it as the coin's dev. */
  creator: TransactionSigner;
  /** Our keeper: the fee payer, the payer of the open's accounts (paid back from the creator's prepaid rent), and the
   * pot's delegate for exactly the buy. */
  keeper: TransactionSigner;
  /** The coin's mint key, generated by our server and destroyed once the ladder is signed. */
  mint: TransactionSigner;
  coin: { name: string; ticker: string; uri: string };
  /** What the pot spends: one rung of the ladder. */
  rung: bigint;
  computeUnitPrice: bigint;
};

/** The coin's accounts where DBC and the open make them. */
export async function creationAccounts(c: Pick<Creation, "launch" | "dbcConfig" | "quoteMint"> & { mint: Address }) {
  const pool = await dbcPoolAddress(c.dbcConfig, c.mint, c.quoteMint);
  const [potCoins] = await findAssociatedTokenPda({ owner: c.launch, mint: c.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [pot] = await findPotPda({ launch: c.launch });
  const [coinRecord] = await findCoinRecordPda({ mint: c.mint });
  return { pool, potCoins, pot, coinRecord };
}

/**
 * The creation transaction's instructions after its nonce advance, in the order the open checks (`creation` in the
 * program): the compute budget, the open, DBC's pool creation, the pot's coin account, the pot's buy as the pool's first
 * swap, and the settle.
 */
export async function creationInstructions(c: Creation): Promise<Instruction[]> {
  const mint = c.mint.address;
  const { pool, potCoins, pot, coinRecord } = await creationAccounts({ ...c, mint });
  const dbcEvents = await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS);
  const open = await getOpenInstructionAsync({ launch: c.launch, keeper: c.keeper, quoteMint: c.quoteMint, rung: c.rung });
  const init = await getInitializeVirtualPoolWithSplTokenInstructionAsync({
    config: c.dbcConfig,
    creator: c.creator,
    baseMint: c.mint,
    quoteMint: c.quoteMint,
    pool,
    mintMetadata: await mintMetadataAddress(mint),
    payer: c.keeper,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: dbcEvents,
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    params: { name: c.coin.name, symbol: c.coin.ticker, uri: c.coin.uri },
  });
  const potCoinAccount = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: c.keeper, owner: c.launch, mint });
  const swap = getSwap2Instruction({
    config: c.dbcConfig,
    pool,
    inputTokenAccount: pot,
    outputTokenAccount: potCoins,
    baseVault: (await findBaseVaultPda({ baseMint: mint, pool }))[0],
    quoteVault: (await findQuoteVaultPda({ quoteMint: c.quoteMint, pool }))[0],
    baseMint: mint,
    quoteMint: c.quoteMint,
    payer: c.keeper,
    tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
    tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
    eventAuthority: dbcEvents,
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    // The least out: the pool is new, so nothing can move its price before the pot's buy.
    params: { amount0: c.rung, amount1: 1n, swapMode: EXACT_IN },
  });
  const settle = await getSettleInstructionAsync({
    launch: c.launch,
    potCoins,
    keeper: c.keeper,
    mint,
    pool,
    dbcConfig: c.dbcConfig,
    coinRecord,
    feeConfig: (await findFeeConfigPda())[0],
    feeEventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
    feeProgram: FEE_PROGRAM_ADDRESS,
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
  });
  return [
    ...budget(OPEN_COMPUTE_UNITS, c.computeUnitPrice),
    open,
    init,
    potCoinAccount,
    // DBC gives the first-swap discount only to a swap that passes the instructions sysvar.
    { ...swap, accounts: [...swap.accounts, { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY }] },
    settle,
  ];
}

/** How a creation transaction lives: on the launch's durable nonce (a rung signed in advance), or a recent blockhash
 * (the creator signing at the open). */
export type CreationLifetime =
  | { nonce: Address; value: Nonce; authority: Address }
  | { blockhash: Blockhash; lastValidBlockHeight: bigint };

/** The addresses of Heat's shared lookup table, by the table's address. */
export type LookupTable = { address: Address; addresses: Address[] };

/** A creation transaction's message, our keeper paying, compressed through the shared lookup table. */
export async function creationMessage(c: Creation, lifetime: CreationLifetime, table: LookupTable) {
  const instructions = await creationInstructions(c);
  const message = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(c.keeper, m));
  const lived =
    "nonce" in lifetime
      ? setTransactionMessageLifetimeUsingDurableNonce({ nonce: lifetime.value, nonceAccountAddress: lifetime.nonce, nonceAuthorityAddress: lifetime.authority }, message)
      : setTransactionMessageLifetimeUsingBlockhash(lifetime, message);
  return compressTransactionMessageUsingAddressLookupTables(appendTransactionMessageInstructions(instructions, lived), {
    [table.address]: table.addresses,
  });
}

/** A signed rung: what the pot spends, and the transaction ready to send, base64. */
export type SignedRung = { rung: bigint; transaction: string; bytes: number };

/**
 * The creator's ladder (ADR 0005): one creation transaction per rung, all 64 on the launch's durable nonce, each signed
 * by the creator, our keeper and the coin's mint key, so at the open our keeper only broadcasts the rung the pot covers
 * and the nonce advancing voids every other. The caller destroys the mint key afterwards.
 */
export async function signLadder(
  l: Omit<Creation, "rung"> & { potCap: bigint; nonce: Address; nonceValue: Nonce; table: LookupTable },
): Promise<SignedRung[]> {
  const lifetime: CreationLifetime = { nonce: l.nonce, value: l.nonceValue, authority: l.keeper.address };
  const signed: SignedRung[] = [];
  for (const rung of rungs(l.potCap)) {
    const transaction = await signTransactionMessageWithSigners(await creationMessage({ ...l, rung }, lifetime, l.table));
    signed.push({ rung, transaction: getBase64EncodedWireTransaction(transaction), bytes: getTransactionEncoder().encode(transaction).length });
  }
  return signed;
}

/**
 * What Heat's shared lookup table holds for the open and the pushes (spec 2.1 step 10): every account they use that is
 * the same in every launch, so a creation transaction carries only its own launch's and coin's addresses in full.
 */
export async function fairOpenLookupTableAddresses(heat: HeatCluster): Promise<Address[]> {
  if (!heat.configs) throw new Error("the lookup table needs Heat's configs");
  return [
    SYSTEM_PROGRAM_ADDRESS,
    COMPUTE_BUDGET_PROGRAM,
    SYSVAR_RECENT_BLOCKHASHES,
    SYSVAR_INSTRUCTIONS,
    TOKEN_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    TOKEN_METADATA_PROGRAM_ADDRESS,
    DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    DBC_POOL_AUTHORITY,
    await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    heat.configs.fairOpen,
    heat.quote.mint,
    FAIR_OPEN_PROGRAM_ADDRESS,
    await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    (await findProgramConfigPda())[0],
    (await findCoinRegistrarPda())[0],
    FEE_PROGRAM_ADDRESS,
    await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
    (await findFeeConfigPda())[0],
  ];
}

// --- Delivering the seats (spec 2.1 step 12) -------------------------------------------------------------------------------

export type PushSeat = { seat: Address; wallet: Address };

/** A push of up to `PUSH_SEATS` seats, which anyone may send: each seat with its wallet and the wallet's coin account. */
export async function pushInstructions(p: { launch: Address; mint: Address; payer: TransactionSigner; seats: PushSeat[]; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const tokens = { mint: p.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const push = await getPushInstructionAsync({
    launch: p.launch,
    potCoins: (await findAssociatedTokenPda({ owner: p.launch, ...tokens }))[0],
    mint: p.mint,
    payer: p.payer,
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
  });
  const seats = [];
  for (const s of p.seats) {
    const [coinAccount] = await findAssociatedTokenPda({ owner: s.wallet, ...tokens });
    seats.push(...[s.seat, s.wallet, coinAccount].map((address) => ({ address, role: AccountRole.WRITABLE })));
  }
  const units = PUSH_COMPUTE_UNITS.base + PUSH_COMPUTE_UNITS.seat * p.seats.length;
  return [...budget(units, p.computeUnitPrice), { ...push, accounts: [...push.accounts, ...seats] }];
}

/** A depositor's own claim of their seat's coins and refund, into their own coin account, made first if missing. */
export async function claimInstructions(c: { launch: Address; mint: Address; seat: Address; wallet: TransactionSigner; computeUnitPrice: bigint }): Promise<Instruction[]> {
  const tokens = { mint: c.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const [coinAccount] = await findAssociatedTokenPda({ owner: c.wallet.address, ...tokens });
  return [
    ...budget(CLAIM_COMPUTE_UNITS, c.computeUnitPrice),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: c.wallet, owner: c.wallet.address, mint: c.mint }),
    await getClaimInstructionAsync({
      launch: c.launch,
      seat: c.seat,
      wallet: c.wallet,
      coinAccount,
      potCoins: (await findAssociatedTokenPda({ owner: c.launch, ...tokens }))[0],
      mint: c.mint,
      eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
      program: FAIR_OPEN_PROGRAM_ADDRESS,
    }),
  ];
}

/**
 * Our keeper closes a launch's durable nonce once the launch has opened or failed, every lamport going back to the
 * creator, who funded it at scheduling (#45). It cannot ride in the creation transaction: a nonce cannot be emptied in
 * the transaction that advances it.
 */
export function closeNonceInstruction(c: { nonce: Address; keeper: TransactionSigner; creator: Address; lamports: bigint }): Instruction {
  return getWithdrawNonceAccountInstruction({ nonceAccount: c.nonce, recipientAccount: c.creator, nonceAuthority: c.keeper, withdrawAmount: c.lamports });
}
