import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getSwap2InstructionDataDecoder, SWAP2_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { CLUSTERS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, referralAccountOf, swapInstructions, swapMessage, SWAP_COMPUTE_UNITS, TOKEN_PROGRAM_ADDRESS } from "./index";

const devnet = CLUSTERS.devnet!;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT = "DifLzk7pn5uebV4sjrZJNoHs9DxY5jUi97ASYdUQbPuR";
const POOL = "Gf1JNnmn2nepsvG3mF5Az815pduuwvGgTZWn9H8SR5JS";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** DBC's `swap2` names its optional referral account thirteenth: the program's own id stands for none. */
const REFERRAL = 12;

async function swap(side: "buy" | "sell", trader?: KeyPairSigner, extra: { mode?: "exact_in" | "partial_fill"; referralAccount?: string } = {}) {
  trader ??= await generateKeyPairSigner();
  const ixs = await swapInstructions({
    ...(extra as object),
    config: devnet.configs!.instant,
    pool: POOL as never,
    mint: MINT as never,
    quoteMint: devnet.quote.mint,
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
    const referral = await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint);
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
        trader,
        side: "buy",
        amountIn: 10_000_000n,
        minimumOut: 1n,
        mode: "partial_fill",
        referralAccount: await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint),
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
});
