// PROTOTYPE, throwaway (ticket #31). Size of the real creation transaction, with our program's `open`
// and `settle` (program/src/lib.rs) in place of the SPL approve/revoke stand-ins, the pot as a PDA
// (no pot signer), and a durable nonce. Built offline: nothing is sent and no SOL is spent.
import { AddressLookupTableAccount, PublicKey, SystemProgram, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, TransactionInstruction, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { connection, readState, QUOTE, BN, v0, txSize, SYSVAR_INSTRUCTIONS_PUBKEY } from "./common";
import { creationInstructions } from "./02-creation-tx";

const st = readState();
const PROGRAM = new PublicKey("GpUeEpdPZSWZRWCornEzPHXfCyejZCGcv3nrsUgqScbE");
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const crank = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate(), nonce = Keypair.generate();
const id = new BN(1);
const [launch] = PublicKey.findProgramAddressSync([Buffer.from("launch"), id.toArrayLike(Buffer, "le", 8)], PROGRAM);
const [potWsol] = PublicKey.findProgramAddressSync([Buffer.from("pot"), launch.toBuffer()], PROGRAM);
const potCoin = getAssociatedTokenAddressSync(mint.publicKey, launch, true);
const buy = new BN(10_000_000);

const open = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: crank.publicKey, isSigner: true, isWritable: false },
    { pubkey: launch, isSigner: false, isWritable: true },
    { pubkey: potWsol, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("open"), buy.toArrayLike(Buffer, "le", 8)]),
});
const settle = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: launch, isSigner: false, isWritable: true },
    { pubkey: potWsol, isSigner: false, isWritable: true },
    { pubkey: potCoin, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: disc("settle"),
});
// reuse the real DBC init, ATA and swap2 builders, then swap the stand-ins for our instructions
const built = await creationInstructions({ creatorKey: creator.publicKey, payerKey: crank.publicKey, mint: mint.publicKey, potOwnerKey: launch, cap: buy, withSecondBuy: false });
// creationInstructions derives the pot as the ATA of potOwner; the real pot is a PDA token account
const swap = built[3];
swap.keys[3] = { pubkey: potWsol, isSigner: false, isWritable: true };
const ixs = [
  SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: crank.publicKey }),
  open, built[1], built[2], swap, settle,
];
const real = (await connection.getAddressLookupTable(new PublicKey(st.lookupTable))).value!;
const projectedAlt = new AddressLookupTableAccount({
  key: real.key,
  state: { ...real.state, addresses: [...real.state.addresses, PROGRAM, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, ASSOCIATED_TOKEN_PROGRAM_ID] },
});
const blockhash = "11111111111111111111111111111111";
for (const [label, alts] of [["no lookup table", []], ["lookup table", [projectedAlt]]] as const) {
  const tx = v0(crank.publicKey, ixs, blockhash, alts as any);
  tx.sign([crank, creator, mint]);
  console.log(`${label}: ${txSize(tx)} bytes of 1232, ${tx.message.header.numRequiredSignatures} signatures, ${ixs.length} instructions`);
}
