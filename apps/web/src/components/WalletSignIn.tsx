"use client";

// Signing in with a wallet (ADR 0008): anyone launches, appeals or signs their open with a wallet alone. The wallet signs
// Heat's Sign In With Solana message, which costs nothing and sends no transaction, and the browser is signed in as the
// Creator record whose Creator wallet it is, or a new one.
import { useSignMessage } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { useState } from "react";
import type { Me } from "@top-pad/contract";
import { ApiProblem, walletSignIn, walletSignInMessage } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { WalletButton } from "./WalletButton";
import { useWallet } from "./WalletProvider";

const SIGN_MESSAGE = "solana:signMessage";
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

/** Whether the browser is signed in as the connected wallet's record: the record's Creator wallet is the connected one. */
export const signedInAs = (me: Me | null | undefined, address: string | null | undefined) => !!me && !!address && me.creatorWallet === address;

/**
 * Connect a wallet if none is, then sign in with it. `connectNote` says why connecting, when no wallet is connected;
 * `me` is who the browser is signed in as now, so the step can say it is someone else.
 */
export function WalletSignIn({ me, connectNote, onSignedIn }: { me: Me | null | undefined; connectNote: string; onSignedIn: (me: Me) => void }) {
  const { account } = useWallet();
  if (!account) {
    return (
      <div className="stack">
        <p className="note">{connectNote}</p>
        <WalletButton variant="inline" />
      </div>
    );
  }
  return <SignInWith account={account} me={me ?? null} onSignedIn={onSignedIn} />;
}

type Signing = { phase: "idle" } | { phase: "signing" } | { phase: "failed"; text: string };

function SignInWith({ account, me, onSignedIn }: { account: UiWalletAccount; me: Me | null; onSignedIn: (me: Me) => void }) {
  const signMessage = useSignMessage(account);
  const [signing, setSigning] = useState<Signing>({ phase: "idle" });

  if (!account.features.includes(SIGN_MESSAGE)) {
    return (
      <div className="verdict verdict-caution" role="status">
        <b>This wallet cannot sign a message</b>
        <span className="note">Signing in needs one. Use Phantom, Solflare or Backpack.</span>
      </div>
    );
  }

  async function signIn() {
    setSigning({ phase: "signing" });
    try {
      const { message } = await walletSignInMessage(account.address);
      let signed: { signature: Uint8Array; signedMessage: Uint8Array };
      try {
        signed = await signMessage({ message: new TextEncoder().encode(message) });
      } catch (e) {
        setSigning({ phase: "failed", text: declined(e) ? "You declined in your wallet. Nothing was signed." : `Your wallet could not sign it: ${(e as Error).message}` });
        return;
      }
      const signature = btoa(String.fromCharCode(...signed.signature));
      const signedIn = await walletSignIn(account.address, new TextDecoder().decode(signed.signedMessage), signature);
      setSigning({ phase: "idle" });
      onSignedIn(signedIn);
    } catch (e) {
      setSigning({ phase: "failed", text: e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}` });
    }
  }

  const elsewhere = me?.creatorWallet && me.creatorWallet !== account.address ? me.creatorWallet : null;
  return (
    <div className="stack">
      {elsewhere && (
        <p className="note">
          This browser is signed in as <span className="mono">{shortAddress(elsewhere)}</span>. Connect that wallet, or sign in with this one.
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-go" disabled={signing.phase === "signing"} onClick={() => void signIn()}>
          {signing.phase === "signing" ? "Signing…" : "Sign in with this wallet"}
        </button>
        <span className="note">
          One signature from <span className="mono">{shortAddress(account.address)}</span>. No transaction, no fee.
        </span>
      </div>
      {signing.phase === "failed" && (
        <div className="verdict verdict-stop" role="alert">
          <b>You are not signed in</b>
          <span className="note">{signing.text}</span>
        </div>
      )}
    </div>
  );
}
