// PROTOTYPE, throwaway (ticket #31). The Fair Open creation transaction, with our program's two
// instructions stood in for by plain SPL Token instructions signed by `potOwner` (a keypair standing
// in for our program's pot PDA), because the program is not deployed (no devnet SOL for it).
//
//   0  SPL approve: crank becomes delegate of the pot's WSOL account for exactly the capped buy
//      (our program: `open_fair_open`, which also introspects the rest of the transaction)
//   1  DBC initialize_virtual_pool_with_spl_token  (creator signs as `creator`, crank as `payer`)
//   2  create the pot's coin account (ATA of potOwner)
//   3  DBC swap2 paid from the pot, the crank signing as `payer` (= SPL delegate)  -> ending fee
//   4  create a second trader's coin account, then 5 DBC swap2 by that trader      -> the cliff
//   6  SPL revoke: the pot's delegate is cleared (our program: `settle_fair_open`, records the fill)
//
// Usage: bun src/02-creation-tx.ts setup|simulate|send
import {
  Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createApproveInstruction, createRevokeInstruction, createSyncNativeInstruction,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  connection, key, loadDefaultWallet, readState, writeState, explorer, QUOTE, BN, swap2BuyIx, v0,
  txSize, decodeDbcEvents, feePct, lamportsToSol, poolAccounts,
} from "./common";

const mode = process.argv[2] ?? "simulate";
const st = readState();
const config = new PublicKey(st.config);
const crank = loadDefaultWallet();          // Top-pad keeper: fee payer, SPL delegate for the pot
const creator = key("creator-a");           // the coin's creator: signs only as DBC `creator`
const potOwner = key("pot-owner-a");        // stands in for our program's pot PDA
const baseMint = key("base-mint-a");        // fresh mint keypair, kept private until the open
const trader = crank;                        // second buyer in the same transaction (any wallet)

const POT_DEPOSITS = new BN(15_000_000);    // 0.015 SOL deposited in the window
const POT_CAP = new BN(10_000_000);         // the pot's buy, capped well below the 0.05 SOL Graduation Target
const SECOND_BUY = new BN(2_000_000);       // 0.002 SOL bought after the pot, same transaction

const potWsol = getAssociatedTokenAddressSync(QUOTE, potOwner.publicKey);
const potCoin = getAssociatedTokenAddressSync(baseMint.publicKey, potOwner.publicKey);
const traderWsol = getAssociatedTokenAddressSync(QUOTE, trader.publicKey);
const traderCoin = getAssociatedTokenAddressSync(baseMint.publicKey, trader.publicKey);

if (import.meta.main && mode === "setup") {
  // The deposit window's result: a funded WSOL pot, plus WSOL for the second trader.
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, potWsol, potOwner.publicKey, QUOTE),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: potWsol, lamports: POT_DEPOSITS.toNumber() }),
    createSyncNativeInstruction(potWsol),
    createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, traderWsol, trader.publicKey, QUOTE),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: traderWsol, lamports: 3 * SECOND_BUY.toNumber() }),
    createSyncNativeInstruction(traderWsol),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [crank]);
  console.log("setup", explorer(sig));
  writeState({ setupA: sig, potWsolA: potWsol.toBase58(), potOwnerA: potOwner.publicKey.toBase58() });
  process.exit(0);
}

export async function creationInstructions(p: {
  creatorKey: PublicKey; payerKey: PublicKey; mint: PublicKey; potOwnerKey: PublicKey; cap: BN;
  name?: string; symbol?: string; uri?: string; withSecondBuy?: boolean;
}) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const initTx = await client.creator.createPool({
    baseMint: p.mint, config, payer: p.payerKey, poolCreator: p.creatorKey,
    name: p.name ?? "Fair Open Test", symbol: p.symbol ?? "FOTEST",
    uri: p.uri ?? "https://arweave.net/9Xs7kQbJ3mJ0Yd2a1e6Qn2Kq8f4l3Hc5Zr1Tw7Uy0Pv",
  });
  if (initTx.instructions.length !== 1) throw new Error(`createPool built ${initTx.instructions.length} instructions`);
  const pWsol = getAssociatedTokenAddressSync(QUOTE, p.potOwnerKey, true);
  const pCoin = getAssociatedTokenAddressSync(p.mint, p.potOwnerKey, true);
  const ixs = [
    createApproveInstruction(pWsol, p.payerKey, p.potOwnerKey, BigInt(p.cap.toString())),
    initTx.instructions[0],
    createAssociatedTokenAccountIdempotentInstruction(p.payerKey, pCoin, p.potOwnerKey, p.mint),
    await swap2BuyIx({ config, baseMint: p.mint, inputTokenAccount: pWsol, outputTokenAccount: pCoin, authority: p.payerKey, amountIn: p.cap, minOut: new BN(0) }),
  ];
  if (p.withSecondBuy !== false) {
    const tCoin = getAssociatedTokenAddressSync(p.mint, trader.publicKey);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(p.payerKey, tCoin, trader.publicKey, p.mint),
      await swap2BuyIx({ config, baseMint: p.mint, inputTokenAccount: traderWsol, outputTokenAccount: tCoin, authority: trader.publicKey, amountIn: SECOND_BUY, minOut: new BN(0) }),
    );
  }
  ixs.push(createRevokeInstruction(pWsol, p.potOwnerKey));
  return ixs;
}

export function reportSwaps(events: { name: string; data: any }[]) {
  for (const e of events.filter((e) => e.name === "EvtSwap2")) {
    const r = e.data.swap_result;
    const fee = r.trading_fee.add(r.protocol_fee).add(r.referral_fee);
    console.log(`  swap in ${lamportsToSol(r.included_fee_input_amount)} SOL, fee ${lamportsToSol(fee)} SOL = ${feePct(fee, r.included_fee_input_amount)}` +
      ` (partner+creator ${lamportsToSol(r.trading_fee)}, protocol ${lamportsToSol(r.protocol_fee)}), out ${r.output_amount.toString()} base units, t=${e.data.current_timestamp}`);
  }
}

if (import.meta.main && (mode === "simulate" || mode === "send")) {
  const ixs = await creationInstructions({
    creatorKey: creator.publicKey, payerKey: crank.publicKey, mint: baseMint.publicKey, potOwnerKey: potOwner.publicKey, cap: POT_CAP,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const noAlt = v0(crank.publicKey, ixs, blockhash);
  noAlt.sign([crank, creator, baseMint, potOwner]);
  const alt = (await connection.getAddressLookupTable(new PublicKey(st.lookupTable))).value!;
  const tx = v0(crank.publicKey, ixs, blockhash, [alt]);
  tx.sign([crank, creator, baseMint, potOwner]);
  console.log("instructions", ixs.length, "signers 4 (crank, creator, mint, potOwner stand-in)",
    "bytes without lookup table", txSize(noAlt), "with", txSize(tx), "of 1232");
  const sim = await connection.simulateTransaction(tx, { sigVerify: true, innerInstructions: true });
  console.log("simulate:", JSON.stringify(sim.value.err) ?? "ok", "CU", sim.value.unitsConsumed);
  if (sim.value.err) { console.log(sim.value.logs?.join("\n")); process.exit(1); }
  if (process.env.DEBUG) console.log(JSON.stringify(sim.value.innerInstructions?.map((g: any) => g.instructions.map((i: any) => [i.programIdIndex, typeof i.data, String(i.data).slice(0, 20)]))));
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: [alt] }).keySegments().flat();
  reportSwaps(decodeDbcEvents(keys, sim.value.innerInstructions as any, "base58"));
  if (mode === "send") {
    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, "confirmed");
    console.log("sent", explorer(sig), conf.value.err ?? "confirmed");
    const { pool } = poolAccounts(config, baseMint.publicKey);
    writeState({ poolA: pool.toBase58(), mintA: baseMint.publicKey.toBase58(), creatorA: creator.publicKey.toBase58(), creationTxA: sig });
  }
}
