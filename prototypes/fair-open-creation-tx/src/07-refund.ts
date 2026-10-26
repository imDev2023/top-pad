// PROTOTYPE, throwaway (ticket #31). Stands in for the refund path: after the open, whatever is left
// in the pot's WSOL account (deposits above the capped buy) goes back. Here it goes to the crank, which
// funded these test deposits; our program would pay each depositor pro rata (see FINDINGS.md).
// Usage: bun src/07-refund.ts <pot-owner key name>
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createCloseAccountInstruction } from "@solana/spl-token";
import { connection, key, loadDefaultWallet, explorer, QUOTE } from "./common";

const crank = loadDefaultWallet();
const potOwner = key(process.argv[2]);
const potWsol = getAssociatedTokenAddressSync(QUOTE, potOwner.publicKey);
const left = (await connection.getTokenAccountBalance(potWsol)).value.amount;
const sig = await sendAndConfirmTransaction(connection,
  new Transaction().add(createCloseAccountInstruction(potWsol, crank.publicKey, potOwner.publicKey)), [crank, potOwner]);
console.log(`pot ${process.argv[2]} closed, ${left} lamports of deposits returned`, explorer(sig));
