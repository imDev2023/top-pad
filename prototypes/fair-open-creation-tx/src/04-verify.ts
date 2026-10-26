// PROTOTYPE, throwaway (ticket #31). Reads a confirmed creation transaction back from devnet: the
// fee each swap paid (from DBC's swap events), who DBC records as the pool's creator, and the pot's
// balances and delegate afterwards. Optionally makes one more buy now, to show the decayed tax.
// Usage: bun src/04-verify.ts <signature> <poolKey> <potOwnerKey> [--buy]
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, loadDefaultWallet, decodeDbcEvents, explorer, QUOTE, BN, swap2BuyIx, v0, readState } from "./common";
import { reportSwaps } from "./02-creation-tx";

const [sig, poolKey, potOwnerKey] = process.argv.slice(2);
const buy = process.argv.includes("--buy");
const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
if (!tx) throw new Error("tx not found");
const keys = [
  ...tx.transaction.message.staticAccountKeys,
  ...(tx.meta?.loadedAddresses?.writable ?? []),
  ...(tx.meta?.loadedAddresses?.readonly ?? []),
];
console.log(`tx ${explorer(sig)} slot ${tx.slot} CU ${tx.meta?.computeUnitsConsumed} fee ${tx.meta?.fee} lamports, err ${JSON.stringify(tx.meta?.err)}`);
console.log("signers:", tx.transaction.message.staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58()).join(", "));
reportSwaps(decodeDbcEvents(keys, tx.meta?.innerInstructions as any, "base58"));

const client = new DynamicBondingCurveClient(connection, "confirmed");
const pool = await client.state.getPool(new PublicKey(poolKey));
const ps: any = (pool as any).poolState ?? pool;
console.log("pool.creator", ps.creator.toBase58(), "activationPoint", ps.activationPoint.toString(), "quoteReserve", ps.quoteReserve.toString());
console.log("partner quote fee accrued", ps.partnerQuoteFee.toString(), "creator quote fee accrued", ps.creatorQuoteFee.toString());
if (potOwnerKey) {
  const owner = new PublicKey(potOwnerKey);
  const wsol = await getAccount(connection, getAssociatedTokenAddressSync(QUOTE, owner));
  const coin = await getAccount(connection, getAssociatedTokenAddressSync(ps.baseMint, owner));
  console.log(`pot WSOL left ${wsol.amount} lamports, delegate ${wsol.delegate?.toBase58() ?? "none"} (${wsol.delegatedAmount}), pot coins ${coin.amount}`);
}

if (buy) {
  const trader = loadDefaultWallet();
  const st = readState();
  const tCoin = getAssociatedTokenAddressSync(ps.baseMint, trader.publicKey);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, tCoin, trader.publicKey, ps.baseMint),
    await swap2BuyIx({ config: ps.config, baseMint: ps.baseMint, inputTokenAccount: getAssociatedTokenAddressSync(QUOTE, trader.publicKey), outputTokenAccount: tCoin, authority: trader.publicKey, amountIn: new BN(1_000_000), minOut: new BN(0) }),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const btx = v0(trader.publicKey, ixs, blockhash);
  btx.sign([trader]);
  const bsig = await connection.sendTransaction(btx);
  await connection.confirmTransaction({ signature: bsig, blockhash, lastValidBlockHeight }, "confirmed");
  const b = await connection.getTransaction(bsig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log(`later buy ${explorer(bsig)} slot ${b!.slot} (${b!.slot - tx.slot} slots after creation)`);
  reportSwaps(decodeDbcEvents(b!.transaction.message.staticAccountKeys, b!.meta?.innerInstructions as any, "base58"));
}
