import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getSwap2InstructionDataDecoder, SWAP2_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { CLUSTERS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, swapInstructions, TOKEN_PROGRAM_ADDRESS } from "./index";

const devnet = CLUSTERS.devnet!;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT = "DifLzk7pn5uebV4sjrZJNoHs9DxY5jUi97ASYdUQbPuR";
const POOL = "Gf1JNnmn2nepsvG3mF5Az815pduuwvGgTZWn9H8SR5JS";

async function swap(side: "buy" | "sell", trader?: KeyPairSigner) {
  trader ??= await generateKeyPairSigner();
  const ixs = await swapInstructions({
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
