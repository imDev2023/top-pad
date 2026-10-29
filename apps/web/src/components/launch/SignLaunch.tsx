"use client";

import { useSignTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { useState } from "react";
import type { LaunchRefusal, LaunchStatus, PreparedLaunch } from "@top-pad/contract";
import { ApiProblem, getLaunch, prepareLaunch, submitLaunch } from "@/lib/api";
import { sol } from "@/lib/format";
import type { FittedImage } from "@/lib/image";
import type { SolanaChain } from "../WalletProvider";
import styles from "./Launch.module.css";

type Phase = "idle" | "preparing" | "signing" | "sending" | "confirming" | "failed";

const STAGES: { phase: Exclude<Phase, "idle" | "failed">; label: string }[] = [
  { phase: "preparing", label: "Checked and prepared" },
  { phase: "signing", label: "Signed in your wallet" },
  { phase: "sending", label: "Stored on Arweave and sent" },
  { phase: "confirming", label: "Confirmed on Solana" },
];

const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

/**
 * Prepares the launch with Heat's API, has the wallet sign it, and hands it back to be co-signed and sent. The wallet
 * is asked once; nothing reaches the chain until it has signed.
 */
export function SignLaunch({
  account,
  chain,
  coin,
  image,
  onLanded,
  onRefused,
}: {
  account: UiWalletAccount;
  chain: SolanaChain;
  coin: { name: string; ticker: string };
  image: FittedImage;
  onLanded: (status: LaunchStatus) => void;
  onRefused: (refusal: LaunchRefusal) => void;
}) {
  const signTransaction = useSignTransaction(account, chain);
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedLaunch | null>(null);
  const busy = phase !== "idle" && phase !== "failed";

  async function launch() {
    setProblem(null);
    try {
      setPhase("preparing");
      const ready = await prepareLaunch({ mode: "instant", name: coin.name, ticker: coin.ticker, wallet: account.address }, image.blob, image.name);
      setPrepared(ready);
      setPhase("signing");
      let signed: Uint8Array;
      try {
        ({ signedTransaction: signed } = await signTransaction({ transaction: toBytes(ready.transaction) }));
      } catch (e) {
        setPhase("idle");
        setProblem(declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not sign: ${(e as Error).message}`);
        return;
      }
      setPhase("sending");
      let status = await submitLaunch(ready.id, toBase64(new Uint8Array(signed)));
      setPhase("confirming");
      const until = Date.now() + 90_000;
      while (status.status === "sending" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        status = await getLaunch(ready.id);
      }
      if (status.status === "landed") return onLanded(status);
      setPhase("failed");
      setProblem(
        status.status === "expired"
          ? "The transaction expired before it landed, so nothing was spent. Launch again."
          : status.status === "sending"
            ? "The transaction has not confirmed yet. Check it on the explorer before launching again."
            : `The launch failed on chain: ${status.error ?? "no reason given"}.`,
      );
    } catch (e) {
      setPhase("idle");
      if (e instanceof ApiProblem) {
        setProblem(e.message);
        if (e.refusal?.code === "vamp_shield") onRefused(e.refusal);
      } else {
        setProblem(`Something went wrong: ${(e as Error).message}`);
      }
    }
  }

  const reached = STAGES.findIndex((s) => s.phase === phase);
  return (
    <div className="stack">
      <p className="note">
        {prepared
          ? `Your wallet pays ${sol(prepared.cost, 5)} SOL: the rent for the coin's pool and its record on Heat, and the network fee.`
          : "Your wallet pays the rent for the coin's pool and its record on Heat, about 0.02 SOL, and the network fee. It shows the exact amount before you approve."}
      </p>
      <div className="row">
        <button type="button" className="btn btn-go" onClick={launch} disabled={busy}>
          {busy ? "Launching…" : phase === "failed" ? "Launch again" : "Launch"}
        </button>
      </div>
      {phase !== "idle" && (
        <ol className={styles.progress} aria-label="Launch progress">
          {STAGES.map((stage, i) => {
            const state = phase === "failed" ? (i < reached || reached === -1 ? "done" : "pending") : i < reached ? "done" : i === reached ? "active" : "pending";
            return (
              <li key={stage.phase} className={styles[state]} aria-current={state === "active" ? "step" : undefined}>
                <span className={styles.progressMark} aria-hidden="true" />
                {stage.label}
              </li>
            );
          })}
        </ol>
      )}
      {problem && (
        <div className="verdict verdict-stop" role="alert">
          <b>The launch did not go through</b>
          <span className="note">{problem}</span>
        </div>
      )}
    </div>
  );
}
