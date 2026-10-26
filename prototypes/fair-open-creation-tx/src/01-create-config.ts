// PROTOTYPE, throwaway (ticket #31). Creates one DBC config shaped like a Fair Open config:
// 99% cliff falling linearly to the 1.25% ending fee over 60 s (timestamp mode), QuoteToken fee
// collection, first swap at the ending fee enabled, creator trading share 0, dynamic fee off.
// The Graduation Target is a toy 0.05 SOL so the partial-fill check fits a devnet budget.
// Usage: bun src/01-create-config.ts [--send]
import { Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient, buildCurve, ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, TokenDecimal, TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, key, loadDefaultWallet, writeState, explorer, QUOTE, txSize } from "./common";

const send = process.argv.includes("--send");
const crank = loadDefaultWallet(); // stands in for Top-pad's keeper: pays fees, is the partner (fee_claimer) for now
const config = key("config");

const params = buildCurve({
  token: {
    tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
    tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 9900, endingFeeBps: 125, numberOfPeriod: 60, totalDuration: 60 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: true,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps25,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  percentageSupplyOnMigration: 20,
  migrationQuoteThreshold: 0.05,
});

const client = new DynamicBondingCurveClient(connection, "confirmed");
const tx = await client.partner.createConfig2({
  ...params,
  config: config.publicKey, feeClaimer: crank.publicKey, leftoverReceiver: crank.publicKey,
  quoteMint: QUOTE, payer: crank.publicKey,
});
tx.feePayer = crank.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(crank, config);
console.log("config", config.publicKey.toBase58(), "tx bytes", txSize(tx));
console.log("baseFee", JSON.stringify(params.poolFees.baseFee, (_, v) => (v?.toString ? v.toString() : v)));
console.log("migrationQuoteThreshold", params.migrationQuoteThreshold.toString());

const sim = await connection.simulateTransaction(tx);
console.log("simulate:", sim.value.err ?? "ok", "CU", sim.value.unitsConsumed);
if (sim.value.err) { console.log(sim.value.logs?.join("\n")); process.exit(1); }
if (send) {
  const sig = await sendAndConfirmTransaction(connection, tx, [crank, config]);
  console.log("sent", explorer(sig));
  writeState({ config: config.publicKey.toBase58(), configTx: sig, feeClaimer: crank.publicKey.toBase58() });
}
