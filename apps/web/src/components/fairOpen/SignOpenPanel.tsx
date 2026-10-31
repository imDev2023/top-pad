"use client";

// The creator's own panel when their wallet could not sign the ladder at scheduling (ADR 0005's fallback): once the
// window has closed, it asks the Creator wallet to sign the one open the pot covers, and Heat's keeper sends it.
import { useSignTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { useState } from "react";
import type { FairOpen } from "@top-pad/contract";
import { ApiProblem, prepareOpenSignature, submitOpenSignature } from "@/lib/api";
import type { SolanaChain } from "../WalletProvider";
import { clock } from "./FairOpenPage";
import styles from "./FairOpen.module.css";

const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

export function SignOpenPanel({ view, account, chain, at, onSigned }: { view: FairOpen; account: UiWalletAccount; chain: SolanaChain; at: number; onSigned: () => void }) {
  const signTransaction = useSignTransaction(account, chain);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const due = view.phase === "due";

  async function sign() {
    setBusy(true);
    setProblem(null);
    try {
      const rung = await prepareOpenSignature(view.launch, account.address);
      const { signedTransaction } = await signTransaction({ transaction: toBytes(rung.transaction) });
      const outcome = await submitOpenSignature(view.launch, toBase64(new Uint8Array(signedTransaction)));
      if (outcome.status === "failed") setProblem(`The open failed on chain: ${outcome.error}`);
      onSigned();
    } catch (e) {
      const error = e as { code?: number; message?: string };
      setProblem(
        e instanceof ApiProblem
          ? e.message
          : error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "")
            ? "You declined in your wallet. The coin cannot open until you sign."
            : `Your wallet could not sign: ${error?.message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`panel ${styles.signOpen}`} aria-labelledby="sign-open" data-testid="sign-open">
      <h2 id="sign-open" className={styles.sectionTitle}>
        Your open
      </h2>
      {view.ladder === "at_open_signed" ? (
        <div className="verdict verdict-go" role="status">
          <b>Signed</b>
          <span className="note">Heat&apos;s keeper is sending it: the coin opens in seconds.</span>
        </div>
      ) : due ? (
        <>
          <p className="note">
            The window has closed, so what the pot buys is known. Sign your open now: it must run by {clock(view.lateAt, at)}, or the launch fails and every
            deposit comes back.
          </p>
          <button type="button" className="btn btn-go" onClick={sign} disabled={busy}>
            {busy ? "Signing…" : "Sign your open"}
          </button>
        </>
      ) : (
        <p className="note">
          You chose to sign your open at the open. Keep this page open: at {clock(view.opensAt, at)}, when the window closes, it asks your wallet for one
          signature.
        </p>
      )}
      {problem && (
        <div className="verdict verdict-stop" role="alert">
          <b>The open is not signed</b>
          <span className="note">{problem}</span>
        </div>
      )}
    </section>
  );
}
