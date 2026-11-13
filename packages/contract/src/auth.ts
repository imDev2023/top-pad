import { z } from "zod";
import { Address } from "./launch";

// Signing in with a wallet (ADR 0008): a Sign In With Solana message naming Heat's site, the wallet, a nonce and an
// expiry, which the wallet signs and the API takes once. It gives the browser the same session linking X does.

/** `POST /auth/wallet/message`: the message the wallet signs to sign in. */
export const WalletSignInRequest = z.object({ wallet: Address });
export type WalletSignInRequest = z.infer<typeof WalletSignInRequest>;

export const WalletSignInMessage = z.object({ message: z.string(), expiresAt: z.string() });
export type WalletSignInMessage = z.infer<typeof WalletSignInMessage>;

/** `POST /auth/wallet`: the message as the wallet signed it, and its ed25519 signature, base64. */
export const WalletSignInSigned = z.object({ wallet: Address, message: z.string().max(1_000), signature: z.string().max(200) });
export type WalletSignInSigned = z.infer<typeof WalletSignInSigned>;

export const WalletSignInRefusal = z.object({
  error: z.string(),
  /** `expired`: the message was not signed in time, or was taken already; `invalid`: it is not Heat's, or not signed by the wallet. */
  code: z.enum(["invalid", "expired"]),
});
export type WalletSignInRefusal = z.infer<typeof WalletSignInRefusal>;
