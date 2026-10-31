"use client";

// "Sign your open in advance: one approval" (spec 2.1 step 6, ADR 0005): the wallet signs the schedule and every rung of
// the ladder in one request, so Heat's keeper opens the coin at its time with nobody online. The rungs sit behind a
// details link. A wallet that cannot sign a batch signs the schedule alone, and the creator signs the open at the open.
import { useSignTransactions } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import { useState } from "react";
import type { LaunchRefusal, LaunchStatus, PreparedLaunch } from "@top-pad/contract";
import { ApiProblem, getLaunch, prepareLaunch, renewLaunch, submitLaunch } from "@/lib/api";
import { sol } from "@/lib/format";
import type { FittedImage } from "@/lib/image";
import type { SolanaChain } from "../WalletProvider";
import styles from "./Launch.module.css";
import { when } from "./Schedule";

type Phase = "idle" | "preparing" | "signing" | "sending" | "failed";
type FairOpenPrepared = Extract<PreparedLaunch, { mode: "fair_open" }>;

const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

export type FairOpenRequest = { name: string; ticker: string; depositsOpenAt: number; minRaise: bigint; teaser: string };

export function SignFairOpen({
  account,
  chain,
  coin,
  image,
  rungs,
  onScheduled,
  onRefused,
}: {
  account: UiWalletAccount;
  chain: SolanaChain;
  coin: FairOpenRequest;
  image: FittedImage;
  /** The ladder's rungs, largest first, in lamports, from the platform's terms. */
  rungs: string[];
  onScheduled: (status: LaunchStatus) => void;
  onRefused: (refusal: LaunchRefusal) => void;
}) {
  const signTransactions = useSignTransactions(account, chain);
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<{ title: string; text: string } | null>(null);
  const [atOpen, setAtOpen] = useState(false);
  const [batchFailed, setBatchFailed] = useState(false);
  const [prepared, setPrepared] = useState<FairOpenPrepared | null>(null);
  const busy = phase === "preparing" || phase === "signing" || phase === "sending";
  const count = rungs.length;

  async function sign(input: string[]) {
    const outputs = await signTransactions(...input.map((t) => ({ transaction: toBytes(t) })));
    return outputs.map((o) => toBase64(new Uint8Array(o.signedTransaction)));
  }

  async function schedule(signAtOpen: boolean) {
    setProblem(null);
    try {
      setPhase("preparing");
      // A second try renews the launch already prepared, whose ticker it holds, rather than preparing another.
      const ready = prepared
        ? await renewLaunch(prepared.id)
        : await prepareLaunch(
            { mode: "fair_open", ...coin, wallet: account.address, depositsOpenAt: `${coin.depositsOpenAt}`, minRaise: `${coin.minRaise}` },
            image.blob,
            image.name,
          );
      if (ready.mode !== "fair_open") throw new Error("the API prepared another kind of launch");
      if (!prepared) setPrepared(ready);
      setPhase("signing");
      let schedule: string;
      let ladder: string[] | null = null;
      try {
        if (signAtOpen) [schedule] = (await sign([ready.transaction])) as [string];
        else [schedule, ...ladder] = (await sign([ready.transaction, ...ready.rungs.map((r) => r.transaction)])) as [string, ...string[]];
      } catch (e) {
        setPhase("idle");
        if (declined(e)) {
          setProblem({ title: "Nothing was scheduled", text: "You declined in your wallet." });
        } else if (!signAtOpen) {
          // A wallet that cannot take the batch: offer the schedule alone, the open to be signed at the open.
          setBatchFailed(true);
          setProblem({ title: `Your wallet could not sign ${count + 1} transactions at once`, text: (e as Error).message });
        } else {
          setProblem({ title: "Your wallet could not sign", text: (e as Error).message });
        }
        return;
      }
      setPhase("sending");
      let status: LaunchStatus;
      try {
        status = await submitLaunch(ready.id, schedule, ladder);
      } catch (e) {
        if (!(e instanceof ApiProblem && e.refusal?.code === "expired")) throw e;
        // The schedule's blockhash ran out while the wallet was open: only the schedule is signed again.
        const renewed = await renewLaunch(ready.id);
        if (renewed.mode !== "fair_open") throw new Error("the API renewed another kind of launch", { cause: e });
        setPhase("signing");
        [schedule] = (await sign([renewed.transaction])) as [string];
        setPhase("sending");
        status = await submitLaunch(ready.id, schedule, ladder);
      }
      const until = Date.now() + 90_000;
      while (status.status === "sending" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        status = await getLaunch(ready.id);
      }
      if (status.status === "landed") return onScheduled(status);
      setPhase("failed");
      setProblem({
        title: "The schedule did not go through",
        text:
          status.status === "expired"
            ? "It expired before it landed, so nothing was spent. Schedule again."
            : status.status === "sending"
              ? "It has not confirmed yet. Check your wallet's activity before scheduling again."
              : `It failed on chain: ${status.error ?? "no reason given"}.`,
      });
    } catch (e) {
      setPhase("idle");
      if (e instanceof ApiProblem) {
        setProblem({ title: "The schedule did not go through", text: e.message });
        if (e.refusal && ["vamp_shield", "ticker_reserved", "teaser", "schedule"].includes(e.refusal.code)) onRefused(e.refusal);
      } else {
        setProblem({ title: "Something went wrong", text: (e as Error).message });
      }
    }
  }

  const stages = [
    { phase: "preparing", label: "Checked, sealed and prepared" },
    { phase: "signing", label: atOpen ? "Schedule signed in your wallet" : "Schedule and open signed in your wallet" },
    { phase: "sending", label: "Scheduled on Solana" },
  ] as const;
  const reached = stages.findIndex((s) => s.phase === phase);
  const opensAt = (coin.depositsOpenAt + 600) * 1000;

  return (
    <div className="stack">
      {!atOpen ? (
        <>
          <p className="muted">
            One approval in your wallet schedules the window and signs your coin&apos;s open in advance, so Heat&apos;s keeper opens it at{" "}
            <b>{when(opensAt)}</b> even if you are offline.
          </p>
          <details className={styles.rungs}>
            <summary>What you sign: the schedule and {count} versions of the open</summary>
            <p className="note">
              What the pot buys is only known when the window closes, so you sign one open for each amount it could spend, 5% apart, all on one
              key only Heat&apos;s keeper can use. At the open the keeper sends the largest the pot covers; using it voids every other, and whatever the
              pot holds above it is refunded.
            </p>
            <ol className={styles.rungList}>
              {rungs.map((r, i) => (
                <li key={r}>
                  <span className="muted">Open {i + 1}</span>
                  <span>
                    the pot buys <span className="num">{sol(r, 4)}</span> SOL
                  </span>
                </li>
              ))}
            </ol>
            <button type="button" className={styles.linkButton} onClick={() => setAtOpen(true)} disabled={busy}>
              My wallet cannot sign them all at once
            </button>
          </details>
        </>
      ) : (
        <div className="verdict verdict-caution">
          <b>You sign your open at the open</b>
          <span className="note">
            You sign the schedule now, and your open when the window closes at <b>{when(opensAt)}</b>, from the Fair Open&apos;s page. Until you do, the
            coin cannot open; if it has not opened 15 minutes later, the launch fails and every deposit comes back.
          </span>
          <span>
            <button type="button" className={styles.linkButton} onClick={() => setAtOpen(false)} disabled={busy}>
              Sign the open in advance instead
            </button>
          </span>
        </div>
      )}

      <p className="note">
        {prepared
          ? `Your wallet pays ${sol(prepared.cost, 5)} SOL now: rent for the launch and the coin's pool, nearly all of it returned, and the network fee.`
          : "Your wallet prepays about 0.03 SOL of rent, nearly all of it returned, and the network fee. It shows the exact amount before you approve."}
      </p>
      <div className="row">
        <button type="button" className="btn btn-go" onClick={() => schedule(atOpen)} disabled={busy}>
          {busy ? "Scheduling…" : atOpen ? "Sign the schedule" : phase === "failed" ? "Schedule again" : "Sign your open in advance"}
        </button>
        {!atOpen && <span className="note">One approval</span>}
      </div>

      {phase !== "idle" && (
        <ol className={styles.progress} aria-label="Scheduling progress">
          {stages.map((stage, i) => {
            const state = phase === "failed" ? "done" : i < reached ? "done" : i === reached ? "active" : "pending";
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
          <b>{problem.title}</b>
          <span className="note">{problem.text}</span>
          {batchFailed && !atOpen && (
            <span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setAtOpen(true);
                  void schedule(true);
                }}
              >
                Sign the schedule only, and the open at its time
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
