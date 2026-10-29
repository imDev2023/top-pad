// The keeper key (spec 10.3): fee payer for the keeper's own work, and the launch key that co-signs creation transactions
// and registers coins. It lives in Cloudflare Secrets Store, bound only to this Worker, and holds a capped SOL float;
// a scheduled check raises an operator alert when the float runs low.
import { createKeyPairSignerFromBytes, type Address, type KeyPairSigner, type Rpc, type GetBalanceApi } from "@solana/kit";
import { raiseAlert, resolveAlert } from "@top-pad/jobs";
import type { Db } from "@top-pad/db";
import type { SecretBinding } from "./env";

export type Keeper = { signer: KeyPairSigner; secret: Uint8Array };

/** Reads the keeper key from its binding, and refuses one that is not the key the cluster's FeeConfig names. */
export async function loadKeeper(binding: SecretBinding, expected: Address): Promise<Keeper> {
  let secret: Uint8Array;
  try {
    secret = Uint8Array.from(JSON.parse(await binding.get()) as number[]);
  } catch {
    throw new Error("the keeper key binding does not hold a keypair array");
  }
  if (secret.length !== 64) throw new Error("the keeper key binding does not hold a 64-byte keypair");
  const signer = await createKeyPairSignerFromBytes(secret);
  if (signer.address !== expected) throw new Error(`the bound keeper key is ${signer.address}, not ${expected}`);
  return { signer, secret };
}

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(3);

/** The keeper's float against its floor: an alert while it is below, resolved once it is topped up. */
export async function checkKeeperFloat(db: Db, rpc: Rpc<GetBalanceApi>, keeper: Address, floor: bigint) {
  const { value: lamports } = await rpc.getBalance(keeper, { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(15_000) });
  if (lamports < floor) {
    await raiseAlert(db, "keeper_low_balance", keeper, `The keeper ${keeper} holds ${sol(lamports)} SOL, below its ${sol(floor)} SOL floor: top it up.`);
  } else {
    await resolveAlert(db, "keeper_low_balance", keeper);
  }
  return { keeper, lamports: lamports.toString(), floor: floor.toString(), low: lamports < floor };
}
