// Heat's two DBC configs as created on devnet (#40), read back field by field against spec 3. Spec 3.2's settings are
// written out here as numbers; the curve comes from the generator, whose unit tests pin it to spec 3.3; and what DBC
// derived when it created each config (where the coin graduates, what the curve sells, the graduated pool's base) must
// equal the generator's mirror of DBC's arithmetic. A config cannot be changed (spec 3.2): if this fails, replace the
// config, never patch around it.
import { createSolanaRpc } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { CLUSTERS, FEE_CLAIMER_ADDRESS } from "@top-pad/chain";
import { fetchPoolConfig, getMigratedPoolMarketCapFeeSchedulerParamsDecoder } from "@top-pad/clients/dbc";
import { checkCurve, COIN_SUPPLY, curveA } from "@top-pad/meteora";

// Free tiers only during the devnet build (spec 10.5); the public endpoint by default.
const rpc = createSolanaRpc(process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com");
const devnet = CLUSTERS.devnet!;

// What DBC writes that spec 3 says nothing about: the account's type tag, its layout version and padding.
const NOT_IN_SPEC = ["discriminator", "version", "padding0", "padding1", "padding2"];

const NO_VESTING = { isInitialized: 0, vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0, cliffDurationFromMigrationTime: 0 };

describe.each([
  ["fairOpen", devnet.configs!.fairOpen],
  ["instant", devnet.configs!.instant],
] as const)("the %s config on devnet", (mode, address) => {
  it("holds every value of spec 3", async () => {
    const { data } = await fetchPoolConfig(rpc, address);
    const curve = curveA(devnet.graduationTarget);
    const derived = checkCurve(curve, devnet.graduationTarget);
    const expected = {
      quoteMint: devnet.quote.mint,
      // The fee program's PDA is partner, fee claimer and leftover receiver (spec 3.2, 5.2).
      feeClaimer: FEE_CLAIMER_ADDRESS,
      leftoverReceiver: FEE_CLAIMER_ADDRESS,
      // The sniper tax: linear, a 98.999996% cliff falling 16,291,666 a second for 60 seconds; no dynamic fee.
      poolFees: {
        baseFee: expect.objectContaining({ cliffFeeNumerator: 989_999_960n, firstFactor: 60, secondFactor: 1n, thirdFactor: 16_291_666n, baseFeeMode: 0 }),
        dynamicFee: expect.objectContaining({ initialized: 0, maxVolatilityAccumulator: 0, variableFeeControl: 0, binStep: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, binStepU128: 0n }),
      },
      partnerLiquidityVestingInfo: expect.objectContaining(NO_VESTING),
      creatorLiquidityVestingInfo: expect.objectContaining(NO_VESTING),
      // A classic SPL coin with no transfer fee, quoted in SPL wrapped SOL.
      transferFeeBasisPoints: 0,
      transferFeeWithheldAuthority: 0,
      migratedTransferFeeAuthorityOption: 0,
      transferFeeFlag: 0,
      tokenType: 0,
      quoteTokenFlag: 0,
      tokenDecimal: 6,
      // Fees collected in the quote; timestamp activation; graduation into DAMM v2.
      collectFeeMode: 0,
      activationType: 1,
      migrationOption: 1,
      // Both graduated LP halves permanently locked.
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
      // Customizable migration with a 0% migration fee; the creator takes no trading fee; immutable metadata.
      migrationFeeOption: 6,
      migrationFeePercentage: 0,
      creatorMigrationFeePercentage: 0,
      creatorTradingFeePercentage: 0,
      tokenUpdateAuthority: 1,
      // A fixed supply of 1,000,000,000 coins, the curve selling everything the graduated pool does not take.
      fixedTokenSupplyFlag: 1,
      preMigrationTokenSupply: COIN_SUPPLY,
      postMigrationTokenSupply: COIN_SUPPLY,
      migrationQuoteThreshold: devnet.graduationTarget,
      swapBaseAmount: derived.swapBaseAmount,
      migrationBaseThreshold: derived.migrationBaseAmount,
      // Graduation exactly at the curve's last point.
      migrationSqrtPrice: curve.points[1].sqrtPrice,
      lockedVestingConfig: expect.objectContaining({ amountPerPeriod: 0n, cliffDurationFromMigrationTime: 0n, frequency: 0n, numberOfPeriod: 0n, cliffUnlockAmount: 0n }),
      // The graduated pool: 1.25% in the quote, no dynamic fee, the market-cap scheduler (checked below).
      migratedCollectFeeMode: 0,
      migratedDynamicFee: 0,
      migratedPoolFeeBps: 125,
      migratedPoolBaseFeeMode: 3,
      migratedCompoundingFeeBps: 0,
      migratedPoolBaseFeeBytes: expect.anything(),
      poolCreationFee: 0n,
      // The only difference between the two configs: the pot's buy pays the ending fee.
      enableFirstSwapWithMinFee: mode === "fairOpen" ? 1 : 0,
      sqrtStartPrice: curve.sqrtStartPrice,
      curve: [...curve.points, ...Array.from({ length: 18 }, () => ({ sqrtPrice: 0n, liquidity: 0n }))],
    };
    expect(Object.keys(expected).sort()).toEqual(Object.keys(data).filter((k) => !NOT_IN_SPEC.includes(k)).sort());
    expect(data).toMatchObject(expected);
    expect(derived.migrationSqrtPrice).toBe(data.migrationSqrtPrice);

    // Spec 3.4: 100 steps of 0.01% from 1.25%, a step every 9% of the graduation square-root price, for 10 years.
    expect(getMigratedPoolMarketCapFeeSchedulerParamsDecoder().decode(data.migratedPoolBaseFeeBytes)).toEqual({
      numberOfPeriod: 100,
      sqrtPriceStepBps: 900,
      schedulerExpirationDuration: 315_360_000,
      reductionFactor: 100_000n,
    });
  });
});
