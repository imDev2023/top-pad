// PROTOTYPE, throwaway (ticket #31). One address lookup table holding the accounts every Fair Open
// creation transaction on this config shares, so it can be reused by every launch.
// Usage: bun src/03-lookup-table.ts
import { AddressLookupTableProgram, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, loadDefaultWallet, readState, writeState, explorer, QUOTE, DBC, POOL_AUTHORITY, EVENT_AUTHORITY, SYSVAR_INSTRUCTIONS_PUBKEY } from "./common";

const crank = loadDefaultWallet();
const st = readState();
const addresses = [
  new PublicKey(st.config), POOL_AUTHORITY, QUOTE, new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
  TOKEN_PROGRAM_ID, SystemProgram.programId, EVENT_AUTHORITY, DBC, ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
];
const slot = await connection.getSlot("finalized");
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: crank.publicKey, payer: crank.publicKey, recentSlot: slot });
const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: crank.publicKey, authority: crank.publicKey, lookupTable: table, addresses });
const sig = await sendAndConfirmTransaction(connection, new Transaction().add(createIx, extendIx), [crank]);
console.log("lookup table", table.toBase58(), "addresses", addresses.length, explorer(sig));
writeState({ lookupTable: table.toBase58(), lookupTableTx: sig });
