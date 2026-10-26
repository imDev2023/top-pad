// PROTOTYPE, throwaway (ticket #31). The partner (config `fee_claimer`, here the crank keypair, in the
// real design a PDA of our program) claims the pools' partner trading fees. Since the creator's DBC
// share is 0, this is every non-Meteora fee, sniper tax included, which our program would then split.
// Usage: bun src/08-claim-partner-fees.ts <pool> [<pool> ...]
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, loadDefaultWallet, explorer, QUOTE, BN } from "./common";

const crank = loadDefaultWallet();
const client = new DynamicBondingCurveClient(connection, "confirmed");
const U64_MAX = new BN("18446744073709551615");
for (const p of process.argv.slice(2)) {
  const pool = new PublicKey(p);
  const fetched: any = await client.state.getPool(pool);
  const before = fetched.poolState ?? fetched;
  const tx = await client.partner.claimPartnerTradingFeeToReceiver({
    feeClaimer: crank.publicKey, payer: crank.publicKey, pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX, receiver: crank.publicKey,
  } as any);
  const sig = await sendAndConfirmTransaction(connection, tx, [crank]);
  console.log(`pool ${p}: claimed ${before.partnerQuoteFee.toString()} lamports of partner quote fees`, explorer(sig));
}
