// PROTOTYPE, throwaway (ticket #31). The alternative to the creator signing: our crank signs the init
// as DBC `creator`, and the same transaction hands the creator role to the real creator with
// `transfer_pool_creator`, so Creator Earnings follow the real creator from the first trade.
// Usage: bun src/06-crank-as-creator.ts simulate|send
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, key, loadDefaultWallet, readState, writeState, explorer, QUOTE, BN, v0, txSize, decodeDbcEvents, poolAccounts, coder, program } from "./common";
import { creationInstructions, reportSwaps } from "./02-creation-tx";

const mode = process.argv[2] ?? "simulate";
const st = readState();
const config = new PublicKey(st.config);
const crank = loadDefaultWallet();
const realCreator = key("creator-c");
const potOwner = key("pot-owner-c");
const baseMint = key("base-mint-c");
const CAP = new BN(2_000_000);
const potWsol = getAssociatedTokenAddressSync(QUOTE, potOwner.publicKey);
const { pool } = poolAccounts(config, baseMint.publicKey);

const pre = [
  // in the real flow the pot already exists; here it is funded in the same transaction to save a round trip
  createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, potWsol, potOwner.publicKey, QUOTE),
  SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: potWsol, lamports: CAP.toNumber() }),
  createSyncNativeInstruction(potWsol),
];
const ixs = await creationInstructions({
  creatorKey: crank.publicKey, payerKey: crank.publicKey, mint: baseMint.publicKey, potOwnerKey: potOwner.publicKey,
  cap: CAP, withSecondBuy: false, name: "Crank Creator Test", symbol: "CRANK",
});
// the SDK helper reads the pool first, which does not exist yet, so build the instruction directly
const transferIx = await program.methods.transferPoolCreator().accountsPartial({ virtualPool: pool, config, creator: crank.publicKey, newCreator: realCreator.publicKey }).instruction();
const all = [...pre, ...ixs, transferIx];
const alt = (await connection.getAddressLookupTable(new PublicKey(st.lookupTable))).value!;
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
const tx = v0(crank.publicKey, all, blockhash, [alt]);
tx.sign([crank, baseMint, potOwner]);
console.log("instructions", all.length, "bytes", txSize(tx));
const sim = await connection.simulateTransaction(tx, { sigVerify: true, innerInstructions: true, accounts: { addresses: [pool.toBase58()], encoding: "base64" } });
console.log("simulate:", JSON.stringify(sim.value.err), "CU", sim.value.unitsConsumed);
if (sim.value.err) { console.log(sim.value.logs?.join("\n")); process.exit(1); }
const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: [alt] }).keySegments().flat();
const events = decodeDbcEvents(keys, sim.value.innerInstructions as any, "base58");
reportSwaps(events);
for (const e of events.filter((e) => e.name === "EvtUpdatePoolCreator")) console.log("EvtUpdatePoolCreator", e.data.creator.toBase58(), "->", e.data.new_creator.toBase58());
const decoded: any = coder.accounts.decode("VirtualPool", Buffer.from(sim.value.accounts![0]!.data[0], "base64"));
const post = decoded.creator ? decoded : decoded.pool_state ?? decoded.poolState;
console.log("pool.creator after the transaction:", post.creator.toBase58(), "(real creator", realCreator.publicKey.toBase58() + ")");
if (mode === "send") {
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("sent", explorer(sig));
  writeState({ poolC: pool.toBase58(), mintC: baseMint.publicKey.toBase58(), creatorC: realCreator.publicKey.toBase58(), creationTxC: sig });
}
