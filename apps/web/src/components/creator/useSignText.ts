"use client";

import { useSignMessage } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";

export const SIGN_MESSAGE = "solana:signMessage";

/** Whether a wallet's error means the person declined, as Phantom, Solflare and Backpack say it. */
export const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

/** Signs Heat's text with the wallet, as given, and returns the ed25519 signature, base64. */
export function useSignText(account: UiWalletAccount) {
  const signMessage = useSignMessage(account);
  return async (text: string) => {
    const signed = await signMessage({ message: new TextEncoder().encode(text) });
    if (new TextDecoder().decode(signed.signedMessage) !== text) throw new Error("the wallet signed other text than Heat's");
    return btoa(String.fromCharCode(...signed.signature));
  };
}
