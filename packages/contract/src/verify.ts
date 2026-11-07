import { z } from "zod";
import { DepositorTier } from "./fairOpen";
import { Address } from "./launch";

// "Verify once" (spec 6.3): a person proves a wallet is theirs once, by signing a message with it that names the X
// account linked in the same browser, and the wallet has the person's Depositor tier in every Fair Open from then on.

/** `POST /verify/message`: the message the signed-in person's wallet signs. */
export const VerifyRequest = z.object({ wallet: Address });
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const VerifyMessage = z.object({ message: z.string() });
export type VerifyMessage = z.infer<typeof VerifyMessage>;

/** `POST /verify`: the message as the wallet signed it, and its ed25519 signature, base64. */
export const VerifySigned = z.object({ wallet: Address, message: z.string().max(1_000), signature: z.string().max(200) });
export type VerifySigned = z.infer<typeof VerifySigned>;

/** A verified wallet: the tier it now has, and the X account it is verified for. */
export const VerifiedWallet = z.object({ wallet: Address, tier: DepositorTier, handle: z.string() });
export type VerifiedWallet = z.infer<typeof VerifiedWallet>;

export const VerifyRefusal = z.object({
  error: z.string(),
  /** `signed_out`: no X account is linked in this browser; `taken`: the wallet is another person's. */
  code: z.enum(["invalid", "signed_out", "taken"]),
});
export type VerifyRefusal = z.infer<typeof VerifyRefusal>;
