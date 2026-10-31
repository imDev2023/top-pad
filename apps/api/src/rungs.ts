// A Fair Open's ladder as the database keeps it (spec 2.1 step 6): each rung's creation message and the signatures
// collected so far, put back together as a transaction to sign or send.
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  signBytes,
  type Base64EncodedWireTransaction,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import type { fairOpenRungs } from "@top-pad/db";
import type { Keeper } from "./keeper";

const base64 = getBase64Encoder();
const base58 = getBase58Decoder();

/** Who signs a launch's rungs: our keeper, which pays, the Creator wallet and the coin's mint key. */
export type RungSigners = { keeper: string; creator: string; mint: string };

/** A rung as a wire transaction, with the signatures collected so far in the order its message names its signers. */
export function wireOf(rung: typeof fairOpenRungs.$inferSelect, signers: RungSigners): Base64EncodedWireTransaction {
  const messageBytes = base64.encode(rung.message);
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const required = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  const stored: Record<string, string | null> = {
    [signers.keeper]: rung.keeperSignature,
    [signers.creator]: rung.creatorSignature,
    [signers.mint]: rung.mintSignature,
  };
  const encoder = getBase58Encoder();
  const signatures = Object.fromEntries(required.map((a) => [a, stored[a] ? (encoder.encode(stored[a]!) as SignatureBytes) : null]));
  return getBase64EncodedWireTransaction({ messageBytes, signatures } as unknown as Transaction);
}

/** Our keeper's signature on a rung's message, base58: it signs last, once the Creator wallet has. */
export async function keeperSignatureOn(keeper: Keeper, message: string): Promise<string> {
  return base58.decode(await signBytes(keeper.signer.keyPair.privateKey, base64.encode(message)));
}
