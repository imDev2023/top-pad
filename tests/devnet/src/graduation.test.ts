// Graduation on devnet (#51), against DBC, DAMM v2 and the fee program as deployed. A Heat coin is launched on devnet's
// rehearsal config, every value of the Instant config's but its Graduation Target of 0.25 SOL (spec 11.4), and bought
// until its curve completes; Heat's keeper migrates it into DAMM v2, and the test reads back the graduated pool: both
// halves of its liquidity permanently locked, the creator's position to the creator and Heat's to the fee program's
// `fee_claimer`, neither withdrawable, and the market-cap fee schedule as configured. Then the fee program splits the
// surplus and burns the leftover, every swap on the graduated pool does exactly what `@top-pad/meteora/damm` quoted,
// the fee steps down as the price rises, Heat's LP fees reach the treasury, and the creator claims their curve earnings
// and their LP fees in one transaction. The coins are sold back at the end. It spends about 0.07 devnet SOL from Heat's
// devnet bank (with `GRADUATION=real`, the Instant config itself and about 2 SOL) and signs with the keeper key, which,
// like the bank, only this Mac holds (~/.config/top-pad/devnet, never CI); without them it is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase58Encoder,
  getBase64Encoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  burnLeftoverInstructions,
  claimablePool,
  creatorClaimMessages,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ADDRESS,
  dammV2VaultAddress,
  eventAuthorityAddress,
  FEE_CLAIMER_ADDRESS,
  FEE_PROGRAM_ADDRESS,
  graduatedPoolAddress,
  graduating,
  instantLaunchAccounts,
  instantLaunchInstructions,
  lpFeeClaimInstructions,
  migrationInstructions,
  MIGRATION_COMPUTE_UNITS,
  MIGRATION_PROGRESS,
  positionAddresses,
  referralAccountOf,
  surplusClaimInstructions,
  surplusOf,
  swapInstructions,
  TOKEN_PROGRAM_ADDRESS,
  tokenAccountOf,
  windowClaimInstructions,
  type GraduatedPosition,
  type InstantLaunch,
} from "@top-pad/chain";
import {
  CP_AMM_ERROR__AMOUNT_IS_ZERO,
  EVT_SWAP2_EVENT_DISCRIMINATOR,
  fetchPool,
  fetchPosition,
  getRemoveAllLiquidityInstruction,
  parseEvtSwap2Event,
  type EvtSwap2Event,
} from "@top-pad/clients/damm-v2";
import { fetchPoolConfig, fetchVirtualPool } from "@top-pad/clients/dbc";
import {
  LEFTOVER_BURNT_EVENT_DISCRIMINATOR,
  LP_FEES_CLAIMED_EVENT_DISCRIMINATOR,
  parseLeftoverBurntEvent,
  parseLpFeesClaimedEvent,
  parseSurplusClaimedEvent,
  SURPLUS_CLAIMED_EVENT_DISCRIMINATOR,
} from "@top-pad/clients/fee";
import { GRADUATED_POOL_FEE } from "@top-pad/meteora";
import { dammFeeNumerator, quoteDammSwap, unclaimedPositionFees } from "@top-pad/meteora/damm";
import { bankFile, chainTime, coinBalance, devnet, fundedWallets, landed, programCompute, rpc, send, simulatedError, sweep } from "./devnet";

const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = process.env.GRADUATION === "real";
const config = real ? devnet.configs!.instant : devnet.rehearsal!;
const quoteMint = devnet.quote.mint;
const treasury = devnet.keys!.treasury;
const base64 = getBase64Encoder();
/** Anchor's tag on an event CPI's data, before the event's own discriminator. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
/** The Tax window: the test buys after it, at the 1.25% curve fee. */
const TAX_WINDOW_SECONDS = 60n;

/** The events of `program` in a landed transaction with the given discriminator, each parsed. */
async function events<T>(signature: string, program: Address, discriminator: ArrayLike<number>, parse: (data: Uint8Array) => T): Promise<T[]> {
  const raw = await landed(signature);
  const keys = [...raw.transaction.message.accountKeys, ...(raw.meta?.loadedAddresses?.writable ?? []), ...(raw.meta?.loadedAddresses?.readonly ?? [])];
  return (raw.meta?.innerInstructions ?? [])
    .flatMap((g) => g.instructions)
    .filter((ix) => keys[ix.programIdIndex] === program)
    .map((ix) => getBase58Encoder().encode(ix.data) as Uint8Array)
    .filter((data) => EVENT_IX_TAG.every((b, i) => data[i] === b) && Array.from(discriminator).every((b, i) => data[8 + i] === b))
    .map((data) => parse(data.subarray(8)));
}

/** A token account's owner and balance, or null if it does not exist. */
async function tokenAccount(address: Address): Promise<{ owner: Address; amount: bigint } | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) return null;
  const data = base64.encode(value.data[0]) as Uint8Array;
  return { owner: getAddressDecoder().decode(data.subarray(32, 64)), amount: new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) };
}

/** A mint's supply. */
async function supply(mint: Address): Promise<bigint> {
  const { value } = await rpc.getTokenSupply(mint, { commitment: "confirmed" }).send();
  return BigInt(value.amount);
}

describe.skipIf(!existsSync(keeperFile) || !existsSync(bankFile))("Graduation on devnet", () => {
  it(
    "migrates a complete curve into DAMM v2 with both LP halves locked forever, splits its surplus, burns its leftover, and trades on",
    { timeout: 600_000 },
    async () => {
      const keeper = await load(keeperFile);
      const target = (await fetchPoolConfig(rpc, config)).data.migrationQuoteThreshold;
      // The trader's buy reaches the target with its 1.25% fee; the rest of its float trades on the graduated pool.
      const [creator, trader] = await fundedWallets(40_000_000n, (target * 105n) / 100n + 60_000_000n);
      // Once the coin has graduated, what the trader still holds is sold back into its pool at the end.
      let sellBack: (() => Promise<unknown>) | null = null;
      try {
        const mint = await generateKeyPairSigner();
        const launch: InstantLaunch = {
          config,
          quoteMint,
          creator,
          mint,
          launchKey: keeper,
          coin: { name: "Heat Graduation Test", ticker: "HEATGRAD", uri: "https://turbo-gateway.com/heat-devnet-graduation-test" },
          computeUnitPrice: 0n,
        };
        const { pool } = await instantLaunchAccounts(launch);
        await send(creator, await instantLaunchInstructions(launch));
        console.log(`launched ${mint.address} on ${real ? "the Instant config" : "the rehearsal config"}, pool ${pool}`);
        const opened = (await fetchVirtualPool(rpc, pool)).data.poolState.activationPoint;
        while ((await chainTime()) < opened + TAX_WINDOW_SECONDS) await sleep(1_000);
        // The window claim, as the keeper sends it at 60 s, so the creator's claim later may run.
        const curve = claimablePool(pool, (await fetchVirtualPool(rpc, pool)).data.poolState, quoteMint);
        await send(keeper, await windowClaimInstructions({ pool: curve, heat: true, treasury, payer: keeper, computeUnitPrice: 0n }));

        // The buy that completes the curve, a partial fill as quick buy sends it, with Heat's referral account.
        const referral = await referralAccountOf(treasury, quoteMint);
        const swapOn = (side: "buy" | "sell", amountIn: bigint, graduatedPool: Address | null = null) =>
          swapInstructions({ config, pool, mint: mint.address, quoteMint, trader, side, amountIn, minimumOut: 1n, mode: "partial_fill", referralAccount: referral, graduatedPool });
        await send(trader, await swapOn("buy", (target * 103n) / 100n));
        const complete = (await fetchVirtualPool(rpc, pool)).data.poolState;
        expect(complete.quoteReserve).toBeGreaterThanOrEqual(target);
        expect(complete.migrationProgress).toBe(MIGRATION_PROGRESS.lockedVesting);
        // The curve takes no more trades.
        expect(await simulatedError(trader, await swapOn("buy", 10_000_000n))).not.toBeNull();

        // The keeper migrates it.
        const [firstNft, secondNft] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
        const graduatingPool = graduating(pool, complete, quoteMint);
        const migration = await send(
          keeper,
          await migrationInstructions({ pool: graduatingPool, payer: keeper, firstPositionNft: firstNft, secondPositionNft: secondNft, computeUnitPrice: 0n }),
        );
        const migrated = (await fetchVirtualPool(rpc, pool)).data.poolState;
        expect(migrated.migrationProgress).toBe(MIGRATION_PROGRESS.createdPool);
        expect(migrated.isMigrated).toBe(1);
        const migrationUnits = ((await landed(migration)).meta as { computeUnitsConsumed?: number }).computeUnitsConsumed ?? 0;
        expect(migrationUnits).toBeLessThanOrEqual(MIGRATION_COMPUTE_UNITS);

        // The graduated pool, where Graduation says it is, with the market-cap fee schedule (spec 3.4).
        const dammPool = await graduatedPoolAddress(mint.address, quoteMint);
        const graduated = (await fetchPool(rpc, dammPool)).data;
        sellBack = async () => {
          const held = await coinBalance(trader.address, mint.address);
          if (held > 0n) await send(trader, await swapOn("sell", held, dammPool));
        };
        expect(graduated.tokenAMint).toBe(mint.address);
        expect(graduated.tokenBMint).toBe(quoteMint);
        expect(graduated.collectFeeMode).toBe(1);
        expect(graduated.poolFees.dynamicFee.initialized).toBe(0);
        expect(graduated.poolFees.initSqrtPrice).toBe(graduated.sqrtPrice);
        expect(dammFeeNumerator(graduated, await chainTime())).toBe(12_500_000n);
        const scheduler = new DataView(Uint8Array.from(graduated.poolFees.baseFee.baseFeeInfo.data).buffer);
        expect({
          mode: scheduler.getUint8(8),
          periods: scheduler.getUint16(14, true),
          stepBps: scheduler.getUint32(16, true),
          expiry: scheduler.getUint32(20, true),
          reduction: scheduler.getBigUint64(24, true),
        }).toEqual({
          mode: 3,
          periods: GRADUATED_POOL_FEE.numberOfPeriod,
          stepBps: GRADUATED_POOL_FEE.sqrtPriceStepBps,
          expiry: GRADUATED_POOL_FEE.schedulerExpirationDuration,
          reduction: GRADUATED_POOL_FEE.reductionFactor,
        });

        // Both positions permanently locked, one the creator's and one the fee claimer's.
        const positions = await Promise.all(
          [firstNft, secondNft].map(async (nft) => {
            const { position, nftAccount } = await positionAddresses(nft.address);
            const state = (await fetchPosition(rpc, position)).data;
            const holder = (await tokenAccount(nftAccount))!;
            return { position, nftAccount, state, owner: holder.owner, held: holder.amount };
          }),
        );
        const creators = positions.find((p) => p.owner === creator.address);
        const heats = positions.find((p) => p.owner === FEE_CLAIMER_ADDRESS);
        expect(creators && heats).toBeTruthy();
        for (const p of positions) {
          expect(p.held).toBe(1n);
          expect(p.state.pool).toBe(dammPool);
          // DBC's split rounds, and may leave a single unit of liquidity (of about 10^30) unlocked: worth no coin and no
          // lamport at any price in the pool's range, as the refused withdrawal below shows.
          expect(p.state.unlockedLiquidity).toBeLessThanOrEqual(1n);
          expect(p.state.vestedLiquidity).toBe(0n);
          expect(p.state.permanentLockedLiquidity).toBeGreaterThan(10n ** 20n);
        }
        expect(graduated.permanentLockLiquidity).toBe(positions.reduce((sum, p) => sum + p.state.permanentLockedLiquidity, 0n));
        console.log(`positions: ${positions.map((p) => `${p.owner === FEE_CLAIMER_ADDRESS ? "Heat" : "creator"} locked ${p.state.permanentLockedLiquidity}, unlocked ${p.state.unlockedLiquidity}`).join("; ")}`);
        // Each half is half, to within DAMM v2's rounding.
        const [a, b] = positions.map((p) => p.state.permanentLockedLiquidity);
        expect(Number(a! > b! ? a! - b! : b! - a!) / Number(a!)).toBeLessThan(1e-6);
        // Nobody can withdraw: the creator's own attempt to remove their liquidity is refused, as what is unlocked is worth
        // nothing.
        const withdraw = getRemoveAllLiquidityInstruction({
          poolAuthority: DAMM_V2_POOL_AUTHORITY,
          pool: dammPool,
          position: creators!.position,
          tokenAAccount: await tokenAccountOf(creator.address, mint.address),
          tokenBAccount: await tokenAccountOf(creator.address, quoteMint),
          tokenAVault: await dammV2VaultAddress(dammPool, mint.address),
          tokenBVault: await dammV2VaultAddress(dammPool, quoteMint),
          tokenAMint: mint.address,
          tokenBMint: quoteMint,
          positionNftAccount: creators!.nftAccount,
          signer: creator,
          tokenAProgram: TOKEN_PROGRAM_ADDRESS,
          tokenBProgram: TOKEN_PROGRAM_ADDRESS,
          eventAuthority: await eventAuthorityAddress(DAMM_V2_PROGRAM_ADDRESS),
          program: DAMM_V2_PROGRAM_ADDRESS,
          tokenAAmountThreshold: 0n,
          tokenBAmountThreshold: 0n,
        });
        const accounts = await Promise.all(
          [mint.address, quoteMint].map((m) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: creator, owner: creator.address, mint: m })),
        );
        expect(await simulatedError(creator, [...accounts, withdraw])).toBe(CP_AMM_ERROR__AMOUNT_IS_ZERO);

        // The surplus, split by the fee program (spec 4), and the leftover, burnt.
        const surplus = surplusOf(migrated.quoteReserve, target);
        const surplusSignature = await send(
          keeper,
          await surplusClaimInstructions({ pool: graduatingPool, creator: creator.address, treasury, surplus, payer: keeper, computeUnitPrice: 0n }),
        );
        const [split] = await events(surplusSignature, FEE_PROGRAM_ADDRESS, SURPLUS_CLAIMED_EVENT_DISCRIMINATOR, parseSurplusClaimedEvent);
        expect({ creator: split!.creatorAmount, treasury: split!.treasuryAmount }).toEqual(surplus);
        expect(split!.creator).toBe(creator.address);
        const supplyBefore = await supply(mint.address);
        const leftoverInVault = (await tokenAccount(complete.baseVault))!.amount - migrated.protocolBaseFee - migrated.partnerBaseFee - migrated.creatorBaseFee - migrated.protocolMigrationBaseFeeAmount;
        const burnSignature = await send(keeper, await burnLeftoverInstructions({ pool: graduatingPool, payer: keeper, computeUnitPrice: 0n }));
        const [burnt] = await events(burnSignature, FEE_PROGRAM_ADDRESS, LEFTOVER_BURNT_EVENT_DISCRIMINATOR, parseLeftoverBurntEvent);
        expect(burnt!.withdrawn).toBe(leftoverInVault);
        expect(burnt!.burnt).toBe(leftoverInVault);
        expect(await supply(mint.address)).toBe(supplyBefore - burnt!.burnt);
        expect((await tokenAccount(await tokenAccountOf(FEE_CLAIMER_ADDRESS, mint.address)))!.amount).toBe(0n);

        // Trades on the graduated pool, each exactly as quoted; a buy large enough to lift the fee off its top step.
        const trades: { side: string; fee: string; units: number }[] = [];
        async function tradeGraduated(side: "buy" | "sell", amountIn: bigint) {
          const before = (await fetchPool(rpc, dammPool, { commitment: "confirmed" })).data;
          const signature = await send(trader, await swapOn(side, amountIn, dammPool));
          const [event] = await events<EvtSwap2Event>(signature, DAMM_V2_PROGRAM_ADDRESS, EVT_SWAP2_EVENT_DISCRIMINATOR, parseEvtSwap2Event);
          const quote = quoteDammSwap({ pool: before, side, amountIn, currentPoint: event!.currentTimestamp, hasReferral: true });
          const r = event!.swapResult;
          expect({ out: r.outputAmount, trading: r.claimingFee, protocol: r.protocolFee, referral: r.referralFee, next: r.nextSqrtPrice }).toEqual({
            out: quote.amountOut,
            trading: quote.tradingFee,
            protocol: quote.protocolFee,
            referral: quote.referralFee,
            next: quote.nextSqrtPrice,
          });
          expect(r.referralFee).toBeGreaterThan(0n);
          const units = ((await landed(signature)).meta as { computeUnitsConsumed?: number }).computeUnitsConsumed ?? 0;
          trades.push({ side, fee: `${(Number(dammFeeNumerator(before, event!.currentTimestamp)) / 1e7).toFixed(2)}%`, units });
          return { before, quote };
        }
        await tradeGraduated("buy", 5_000_000n);
        // A buy of a fifth of the pool's quote lifts the square-root price past at least one 9% step, and the fee steps
        // down for the trade after it; a sell brings the price back down and the fee back up.
        await tradeGraduated("buy", target / 5n);
        const { before: lifted } = await tradeGraduated("buy", 2_000_000n);
        expect(dammFeeNumerator(lifted, await chainTime())).toBeLessThan(12_500_000n);
        const half = (await coinBalance(trader.address, mint.address)) / 2n;
        await tradeGraduated("sell", half);
        const { before: fallen } = await tradeGraduated("sell", (await coinBalance(trader.address, mint.address)) / 10n);
        expect(dammFeeNumerator(fallen, await chainTime())).toBe(12_500_000n);
        console.table(trades);

        // Heat's LP fees reach the treasury, exactly what its position had accrued.
        const heatPosition: GraduatedPosition = { pool: dammPool, mint: mint.address, quoteMint, position: heats!.position, nftAccount: heats!.nftAccount };
        const owedHeat = unclaimedPositionFees((await fetchPool(rpc, dammPool)).data, (await fetchPosition(rpc, heats!.position)).data);
        expect(owedHeat.quote).toBeGreaterThan(0n);
        expect(owedHeat.coin).toBe(0n);
        const lpSignature = await send(keeper, await lpFeeClaimInstructions({ heat: heatPosition, treasury, payer: keeper, computeUnitPrice: 0n }));
        const [lp] = await events(lpSignature, FEE_PROGRAM_ADDRESS, LP_FEES_CLAIMED_EVENT_DISCRIMINATOR, parseLpFeesClaimedEvent);
        expect(lp!.amount).toBe(owedHeat.quote);

        // The creator claims their curve earnings and their LP fees in one transaction, both exact.
        const creatorPosition: GraduatedPosition = { ...heatPosition, position: creators!.position, nftAccount: creators!.nftAccount };
        const owedCreator = unclaimedPositionFees((await fetchPool(rpc, dammPool)).data, (await fetchPosition(rpc, creators!.position)).data);
        const curveNow = claimablePool(pool, (await fetchVirtualPool(rpc, pool)).data.poolState, quoteMint);
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
        const [claim, ...more] = await creatorClaimMessages(
          { creator, treasury, computeUnitPrice: 0n, claims: [{ pool: curveNow, heat: true, maxAmount: curveNow.partnerQuoteFee, lpPosition: creatorPosition }] },
          lifetime,
        );
        expect(more).toHaveLength(0);
        const before = (await rpc.getBalance(creator.address, { commitment: "confirmed" }).send()).value;
        const claimSignature = await send(creator, claim!.instructions as Instruction[]);
        const after = (await rpc.getBalance(creator.address, { commitment: "confirmed" }).send()).value;
        // The coin account the LP claim opens holds the rent the creator paid for it.
        const coinRent = await rpc.getMinimumBalanceForRentExemption(165n).send();
        expect(after - before).toBe(curveNow.partnerQuoteFee / 2n + owedCreator.quote - 5_000n - coinRent);
        const lpUnits = await programCompute(claimSignature, DAMM_V2_PROGRAM_ADDRESS);

        console.log(
          `migration ${migration}: ${migrationUnits} CU; surplus ${surplus.creator}+${surplus.treasury}; leftover burnt ${burnt!.burnt}; ` +
            `Heat's LP fees ${lp!.amount}; the creator's LP fees ${owedCreator.quote} (${lpUnits} CU in DAMM v2) and curve earnings ${curveNow.partnerQuoteFee / 2n}; ` +
            `fee program: surplus ${await programCompute(surplusSignature, FEE_PROGRAM_ADDRESS)} CU, leftover ${await programCompute(burnSignature, FEE_PROGRAM_ADDRESS)} CU, LP fees ${await programCompute(lpSignature, FEE_PROGRAM_ADDRESS)} CU`,
        );
      } finally {
        await sellBack?.().catch((e: Error) => console.error(`selling back failed: ${e.message}`));
        await sweep(trader, creator);
      }
    },
  );
});

