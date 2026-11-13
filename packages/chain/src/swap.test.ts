import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getSwap2InstructionDataDecoder, SWAP2_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getSwap2InstructionDataDecoder as getDammSwap2InstructionDataDecoder } from "@top-pad/clients/damm-v2";
import {
  CLUSTERS,
  DAMM_V2_PROGRAM_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  referralAccountOf,
  swapInstructions,
  swapMessage,
  SWAP_COMPUTE_UNITS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "./index";
import { DEVNET_XSTOCK_STAND_IN } from "./quotes";

const devnet = CLUSTERS.devnet!;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT = "DifLzk7pn5uebV4sjrZJNoHs9DxY5jUi97ASYdUQbPuR";
const POOL = "Gf1JNnmn2nepsvG3mF5Az815pduuwvGgTZWn9H8SR5JS";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** DBC's `swap2` names its optional referral account thirteenth: the program's own id stands for none. */
const REFERRAL = 12;

type Extra = { mode?: "exact_in" | "partial_fill"; referralAccount?: string; quoteMint?: string; quoteTokenProgram?: string; graduatedPool?: string };

async function swap(side: "buy" | "sell", trader?: KeyPairSigner, extra: Extra = {}) {
  trader ??= await generateKeyPairSigner();
  const ixs = await swapInstructions({
    ...(extra as object),
    config: devnet.configs!.instant,
    pool: POOL as never,
    mint: MINT as never,
    quoteMint: devnet.quote.mint,
    quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...(extra as object),
    trader,
    side,
    amountIn: 10_000_000n,
    minimumOut: 1n,
  });
  const dbc = ixs.find((ix) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)!;
  return { trader, ixs, dbc, data: getSwap2InstructionDataDecoder().decode(dbc.data!) };
}

describe("a swap", () => {
  it("buys: wraps exactly the SOL it spends, swaps it for the coin, and closes the wrapped account", async () => {
    const { trader, ixs, dbc, data } = await swap("buy");
    expect(ixs.map((ix) => ix.programAddress)).toEqual([ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM_ADDRESS, ATA_PROGRAM, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    expect(Array.from(dbc.data!.slice(0, 8))).toEqual(Array.from(SWAP2_DISCRIMINATOR));
    expect(data.params).toEqual({ amount0: 10_000_000n, amount1: 1n, swapMode: 0 });
    const accounts = dbc.accounts!.map((a) => a.address);
    // The config second and the payer tenth, where the indexer reads them; the instructions sysvar last.
    expect(accounts[1]).toBe(devnet.configs!.instant);
    expect(accounts[2]).toBe(POOL);
    expect(accounts[7]).toBe(MINT);
    expect(accounts[9]).toBe(trader.address);
    expect(accounts.at(-1)).toBe("Sysvar1nstructions1111111111111111111111111");
    // No referral account unless one is given.
    expect(accounts[REFERRAL]).toBe(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS);
  });

  it("names Heat's referral account, the treasury's quote account, and buys as a partial fill when asked", async () => {
    const referral = await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint, TOKEN_PROGRAM_ADDRESS);
    // The treasury's wrapped SOL account on devnet, where its Platform Fee lands too.
    expect(referral).toBe("CrQJCsFgWLETU8vPcavPV6SWyQsVSFJ5RkYxckpXWXu7");
    const { dbc, data } = await swap("buy", undefined, { mode: "partial_fill", referralAccount: referral });
    expect(dbc.accounts![REFERRAL]!.address).toBe(referral);
    expect(dbc.accounts![REFERRAL]!.role).toBe(1); // writable: DBC pays the share into it
    expect(data.params.swapMode).toBe(1);
  });

  it("makes a transaction the trader pays for, with its compute budget first", async () => {
    const trader = await generateKeyPairSigner();
    const message = await swapMessage(
      {
        config: devnet.configs!.instant,
        pool: POOL as never,
        mint: MINT as never,
        quoteMint: devnet.quote.mint,
        quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
        trader,
        side: "buy",
        amountIn: 10_000_000n,
        minimumOut: 1n,
        mode: "partial_fill",
        referralAccount: await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint, TOKEN_PROGRAM_ADDRESS),
      },
      { computeUnitPrice: 1_000n, lifetime: { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 1n } },
    );
    expect(message.feePayer.address).toBe(trader.address);
    expect(message.instructions.slice(0, 2).map((ix) => ix.programAddress)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET]);
    expect(Array.from(message.instructions[0]!.data!.slice(1, 5))).toEqual(Array.from(new Uint8Array(new Uint32Array([SWAP_COMPUTE_UNITS]).buffer)));
  });

  it("sells: spends the coin from the trader's coin account, and unwraps the proceeds", async () => {
    const buy = await swap("buy");
    const sell = await swap("sell", buy.trader);
    expect(sell.ixs.map((ix) => ix.programAddress)).toEqual([ATA_PROGRAM, ATA_PROGRAM, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    const inOut = (s: typeof buy) => [s.dbc.accounts![3]!.address, s.dbc.accounts![4]!.address];
    // A buy's input is the wrapped SOL account and its output the coin account; a sell turns them around.
    const [wrappedSol, coinAccount] = inOut(buy);
    expect(wrappedSol).not.toBe(coinAccount);
    expect(inOut(sell)).toEqual([coinAccount, wrappedSol]);
    expect(sell.data.params.amount0).toBe(10_000_000n);
  });

  it("in an xStock names the quote's accounts and program as Token-2022's and the coin's as SPL Token's, wrapping nothing", async () => {
    const xstock = { quoteMint: DEVNET_XSTOCK_STAND_IN, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS };
    const referral = await referralAccountOf(devnet.keys!.treasury, DEVNET_XSTOCK_STAND_IN, TOKEN_2022_PROGRAM_ADDRESS);
    const { trader, ixs, dbc } = await swap("buy", undefined, { ...xstock, referralAccount: referral });
    expect(ixs.map((ix) => ix.programAddress)).toEqual([ATA_PROGRAM, ATA_PROGRAM, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS]);
    const [quoteAccount] = await findAssociatedTokenPda({ owner: trader.address, mint: DEVNET_XSTOCK_STAND_IN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [coinAccount] = await findAssociatedTokenPda({ owner: trader.address, mint: MINT as never, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    // Each account opened under its own program: the quote's first, then the coin's.
    expect(ixs[0]!.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([quoteAccount, DEVNET_XSTOCK_STAND_IN, TOKEN_2022_PROGRAM_ADDRESS]));
    expect(ixs[1]!.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([coinAccount, MINT, TOKEN_PROGRAM_ADDRESS]));
    const accounts = dbc.accounts!.map((a) => a.address);
    // DBC's input, output, base and quote token programs, and the treasury's Token-2022 account for the referral share.
    expect([accounts[3], accounts[4], accounts[10], accounts[11], accounts[REFERRAL]]).toEqual([quoteAccount, coinAccount, TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, referral]);
  });

  it("on a graduated pool in an xStock names DAMM v2's token B program as Token-2022", async () => {
    const graduatedPool = "8YqGGdTktYjbDKkwvyhX4ZTvKPp4VkCLt2Ud7C9hP2Uh";
    const ixs = await swapInstructions({
      config: devnet.configs!.instant,
      pool: POOL as never,
      mint: MINT as never,
      quoteMint: DEVNET_XSTOCK_STAND_IN,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      trader: await generateKeyPairSigner(),
      side: "sell",
      amountIn: 5n,
      minimumOut: 1n,
      graduatedPool: graduatedPool as never,
    });
    const damm = ixs.find((ix) => ix.programAddress === DAMM_V2_PROGRAM_ADDRESS)!;
    expect(getDammSwap2InstructionDataDecoder().decode(damm.data!).params.amount0).toBe(5n);
    const accounts = damm.accounts!.map((a) => a.address);
    // `swap2`'s token A and token B programs, tenth and eleventh.
    expect([accounts[9], accounts[10]]).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
  });
});
