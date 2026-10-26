// PROTOTYPE, throwaway (ticket #31). Can the creator sign the creation transaction in advance, so the
// open happens at a scheduled time without the creator online, and the creator still signs the init?
//
// The catch: the pot's buy amount is inside the signed message, but the pot's size is only known when
// the window closes. So the creator signs a ladder of variants (here two), all on ONE durable nonce;
// at the open the crank submits the largest variant the pot covers, which advances the nonce and voids
// every other variant. The rest of the pot is refunded pro rata.
//
// Usage: bun src/05-durable-nonce.ts nonce|setup|presign|open
import { Keypair, NonceAccount, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, NONCE_ACCOUNT_LENGTH } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connection, key, loadDefaultWallet, readState, writeState, explorer, QUOTE, BN, v0, txSize, decodeDbcEvents, poolAccounts, ROOT } from "./common";
import { creationInstructions, reportSwaps } from "./02-creation-tx";

const step = process.argv[2];
const st = readState();
const crank = loadDefaultWallet();
const creator = key("creator-b");
const potOwner = key("pot-owner-b");
const baseMint = key("base-mint-b");
const nonce = key("nonce-b");
const LADDER = [new BN(2_000_000), new BN(3_000_000)]; // pot buy variants the creator signs in advance
const POT_DEPOSITS = new BN(3_500_000);                // what the window actually raised
const potWsol = getAssociatedTokenAddressSync(QUOTE, potOwner.publicKey);
const PRESIGNED = path.join(process.env.KEYS_DIR ?? ROOT, "presigned-b.json"); // signed transactions are not secrets, but keep them out of the repo

if (step === "nonce") {
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: crank.publicKey, newAccountPubkey: nonce.publicKey, lamports: rent, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
    SystemProgram.nonceInitialize({ noncePubkey: nonce.publicKey, authorizedPubkey: crank.publicKey }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [crank, nonce]);
  console.log("nonce account", nonce.publicKey.toBase58(), "authority crank", explorer(sig));
  writeState({ nonceB: nonce.publicKey.toBase58(), nonceTx: sig });
}

if (step === "setup") {
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, potWsol, potOwner.publicKey, QUOTE),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: potWsol, lamports: POT_DEPOSITS.toNumber() }),
    createSyncNativeInstruction(potWsol),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [crank]);
  console.log("pot B funded", explorer(sig));
  writeState({ setupB: sig, potOwnerB: potOwner.publicKey.toBase58() });
}

if (step === "presign") {
  // The creator's wallet signs every rung now (one signAllTransactions prompt in a real wallet).
  const nonceInfo = NonceAccount.fromAccountData((await connection.getAccountInfo(nonce.publicKey))!.data);
  const alt = (await connection.getAddressLookupTable(new PublicKey(st.lookupTable))).value!;
  const signed: string[] = [];
  for (const cap of LADDER) {
    const ixs = await creationInstructions({
      creatorKey: creator.publicKey, payerKey: crank.publicKey, mint: baseMint.publicKey, potOwnerKey: potOwner.publicKey,
      cap, withSecondBuy: false, name: "Nonce Open Test", symbol: "NONCE",
    });
    const tx = v0(crank.publicKey, [SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: crank.publicKey }), ...ixs], nonceInfo.nonce, [alt]);
    tx.sign([creator]); // only the creator signs now
    signed.push(Buffer.from(tx.serialize()).toString("base64"));
    console.log(`rung ${cap.toString()} lamports: ${txSize(tx)} bytes, signed by creator at ${new Date().toISOString()}`);
  }
  writeFileSync(PRESIGNED, JSON.stringify({ nonce: nonceInfo.nonce, signedAt: new Date().toISOString(), signed }));
  writeState({ presignedAtB: new Date().toISOString(), nonceValueB: nonceInfo.nonce });
}

if (step === "open") {
  // Later, with the creator offline: pick the rung, add the crank's, mint's and pot's signatures, send.
  const { signed, signedAt } = JSON.parse(readFileSync(PRESIGNED, "utf8"));
  const txs = signed.map((s: string) => VersionedTransaction.deserialize(Buffer.from(s, "base64")));
  const pot = new BN((await connection.getTokenAccountBalance(potWsol)).value.amount);
  const idx = LADDER.map((c, i) => [c, i] as const).filter(([c]) => c.lte(pot)).pop()![1];
  console.log(`pot holds ${pot.toString()}, opening with rung ${LADDER[idx].toString()} (signed ${signedAt}, now ${new Date().toISOString()})`);
  const chosen = txs[idx];
  chosen.sign([crank, baseMint, potOwner]);
  const sim = await connection.simulateTransaction(chosen, { sigVerify: true, innerInstructions: true });
  console.log("simulate:", JSON.stringify(sim.value.err), "CU", sim.value.unitsConsumed);
  if (sim.value.err) { console.log(sim.value.logs?.join("\n")); process.exit(1); }
  const sig = await connection.sendTransaction(chosen);
  const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("opened", explorer(sig));
  const opened = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const okeys = [...opened!.transaction.message.staticAccountKeys, ...(opened!.meta?.loadedAddresses?.writable ?? []), ...(opened!.meta?.loadedAddresses?.readonly ?? [])];
  console.log(`slot ${opened!.slot}, CU ${opened!.meta?.computeUnitsConsumed}, signers ${opened!.transaction.message.staticAccountKeys.slice(0, opened!.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58()).join(", ")}`);
  reportSwaps(decodeDbcEvents(okeys, opened!.meta?.innerInstructions as any, "base58"));
  // A public buy straight after the open, inside the 60 s tax window.
  const tCoin = getAssociatedTokenAddressSync(baseMint.publicKey, crank.publicKey);
  const { swap2BuyIx } = await import("./common");
  const btx = v0(crank.publicKey, [
    createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, tCoin, crank.publicKey, baseMint.publicKey),
    await swap2BuyIx({ config: new PublicKey(st.config), baseMint: baseMint.publicKey, inputTokenAccount: getAssociatedTokenAddressSync(QUOTE, crank.publicKey), outputTokenAccount: tCoin, authority: crank.publicKey, amountIn: new BN(1_000_000), minOut: new BN(0) }),
  ], (await connection.getLatestBlockhash()).blockhash);
  btx.sign([crank]);
  const bsig = await connection.sendTransaction(btx);
  const lb = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: bsig, blockhash: lb.blockhash, lastValidBlockHeight: lb.lastValidBlockHeight }, "confirmed");
  const b = await connection.getTransaction(bsig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log(`public buy ${explorer(bsig)} slot ${b!.slot} (${b!.slot - opened!.slot} slots after the open)`);
  reportSwaps(decodeDbcEvents(b!.transaction.message.staticAccountKeys, b!.meta?.innerInstructions as any, "base58"));
  const { pool } = poolAccounts(new PublicKey(st.config), baseMint.publicKey);
  writeState({ poolB: pool.toBase58(), mintB: baseMint.publicKey.toBase58(), creatorB: creator.publicKey.toBase58(), creationTxB: sig });
  // Every other rung is now void: the nonce has advanced.
  for (const [i, other] of txs.entries()) {
    if (i === idx) continue;
    other.sign([crank, baseMint, potOwner]);
    try {
      const s = await connection.sendTransaction(other);
      console.log(`rung ${i} unexpectedly accepted: ${s}`);
    } catch (e: any) {
      console.log(`rung ${i} rejected as expected: ${String(e.message).split("\n")[0]}`);
    }
  }
}
