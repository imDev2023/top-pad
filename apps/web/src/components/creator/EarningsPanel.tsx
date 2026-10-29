"use client";

import { getBase58Decoder } from "@solana/kit";
import { useSignAndSendTransactions } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ClaimOutcome, CreatorEarnings, EarningsCoin } from "@top-pad/contract";
import { ApiProblem, getEarnings, prepareClaim, reportClaim } from "@/lib/api";
import { shortAddress, sol } from "@/lib/format";
import type { SolanaChain } from "../WalletProvider";
import styles from "./Creator.module.css";

const SIGN_AND_SEND = "solana:signAndSendTransaction";
/** Every raw unit shows: a claim pays exactly what the page says, to the lamport. */
const amount = (lamports: string) => `${sol(lamports, 9)} SOL`;
const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

type Claim =
  | { phase: "idle" }
  | { phase: "preparing" | "signing" | "confirming" }
  | { phase: "done"; outcome: ClaimOutcome }
  | { phase: "failed"; problem: string };

/**
 * A wallet's Creator Earnings (spec 4, 7): what waits in each Heat coin whose creator role it holds, read from the chain,
 * and one claim of it all, which pays exactly the amounts shown. A claim the wallet signs is sent by the wallet, and the
 * API then reads what it paid from the chain.
 */
export function EarningsPanel({ account, chain }: { account: UiWalletAccount; chain: SolanaChain }) {
  const wallet = account.address;
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim>({ phase: "idle" });

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setEarnings(await getEarnings(wallet));
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : `Your earnings could not be read: ${(e as Error).message}`);
    }
  }, [wallet]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!earnings) {
    return (
      <section className={`panel ${styles.panel}`} aria-busy={!problem} aria-label="Creator Earnings">
        {problem ? (
          <div className="verdict verdict-stop" role="alert">
            <b>Your earnings could not be read</b>
            <span className="note">{problem}</span>
            <button type="button" className={`btn btn-sm ${styles.retry}`} onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted">Reading what waits for {shortAddress(wallet)} from the chain…</p>
        )}
      </section>
    );
  }

  const claimable = earnings.coins.filter((coin) => BigInt(coin.waiting) > 0n);
  const busy = claim.phase === "preparing" || claim.phase === "signing" || claim.phase === "confirming";
  return (
    <>
      <section className={`panel ${styles.summary}`} aria-label="Your Creator Earnings">
        <dl className={styles.figures}>
          <div>
            <dt className="eyebrow">Waiting for you</dt>
            <dd className={`num ${styles.waiting}`} data-testid="earnings-waiting">
              {amount(earnings.waiting)}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Claimed so far</dt>
            <dd className={`num ${styles.claimed}`}>{amount(earnings.claimed)}</dd>
          </div>
        </dl>
        <div className={styles.action}>
          {account.features.includes(SIGN_AND_SEND) ? (
            <ClaimButton account={account} chain={chain} coins={claimable} total={earnings.waiting} busy={busy} onClaim={setClaim} onClaimed={load} />
          ) : (
            <p className="note">Your wallet can sign but not send a transaction from a page, which a claim needs. Claim with Phantom, Solflare or Backpack.</p>
          )}
        </div>
        <ClaimStatus claim={claim} />
      </section>

      {earnings.coins.length === 0 ? (
        <section className={`panel ${styles.empty}`}>
          <p>
            No Heat coin&apos;s creator role is held by <span className={`mono ${styles.address}`}>{shortAddress(wallet)}</span>. A coin you launch, or one whose
            creator role is handed to this wallet, shows here.
          </p>
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </section>
      ) : (
        <section className={`panel ${styles.coins}`} aria-label="Your coins">
          <div className={styles.columns} aria-hidden="true">
            <span>Coin</span>
            <span>Waiting</span>
            <span>Claimed</span>
          </div>
          <ul className={styles.list}>
            {earnings.coins.map((coin) => (
              <CoinRow key={coin.mint} coin={coin} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function CoinRow({ coin }: { coin: EarningsCoin }) {
  return (
    <li className={styles.coin} data-testid="earnings-coin">
      <Link href={`/coin/${coin.mint}`} className={styles.identity}>
        {coin.imageUri ? (
          <img src={coin.imageUri} alt="" width={40} height={40} className={styles.image} />
        ) : (
          <span className={styles.monogram} aria-hidden="true">
            {coin.ticker.slice(0, 1)}
          </span>
        )}
        <span className={styles.names}>
          <b>{coin.name}</b>
          <span className="mono muted">{coin.ticker}</span>
        </span>
      </Link>
      <span className={styles.cell}>
        <span className={`eyebrow ${styles.label}`}>Waiting</span>
        {coin.windowClaimed ? (
          <span className="num">{amount(coin.waiting)}</span>
        ) : (
          <span className="chip chip-caution" title="Heat's keeper claims the first minute's tax for the treasury when the minute ends; your half of every fee after it waits here from then.">
            First minute&apos;s claim pending
          </span>
        )}
      </span>
      <span className={styles.cell}>
        <span className={`eyebrow ${styles.label}`}>Claimed</span>
        <span className="num muted">{amount(coin.claimed)}</span>
      </span>
    </li>
  );
}

/**
 * The claim: built by Heat's API for exactly the amounts shown, signed and sent by the wallet in one request however
 * many transactions it takes, then read back from the chain.
 */
function ClaimButton({
  account,
  chain,
  coins,
  total,
  busy,
  onClaim,
  onClaimed,
}: {
  account: UiWalletAccount;
  chain: SolanaChain;
  coins: EarningsCoin[];
  total: string;
  busy: boolean;
  onClaim: (claim: Claim) => void;
  onClaimed: () => Promise<void>;
}) {
  const signAndSend = useSignAndSendTransactions(account, chain);

  async function claimAll() {
    try {
      onClaim({ phase: "preparing" });
      const prepared = await prepareClaim(
        account.address,
        coins.map((coin) => ({ mint: coin.mint, partnerFees: coin.partnerFees })),
      );
      if (prepared.pays !== total) throw new Error(`the claim would pay ${amount(prepared.pays)}, not the ${amount(total)} shown`);
      onClaim({ phase: "signing" });
      let sent;
      try {
        sent = await signAndSend(...prepared.transactions.map((transaction) => ({ transaction: toBytes(transaction) })));
      } catch (e) {
        onClaim({ phase: "failed", problem: declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not send the claim: ${(e as Error).message}` });
        return;
      }
      onClaim({ phase: "confirming" });
      const outcome = await reportClaim(sent.map(({ signature }) => getBase58Decoder().decode(signature)));
      onClaim(outcome.transactions.every((t) => t.status === "landed") ? { phase: "done", outcome } : { phase: "failed", problem: unlanded(outcome) });
      await onClaimed();
    } catch (e) {
      onClaim({ phase: "failed", problem: e instanceof ApiProblem ? e.message : `The claim did not go through: ${(e as Error).message}` });
      if (e instanceof ApiProblem && e.status === 409) await onClaimed();
    }
  }

  const nothing = coins.length === 0;
  return (
    <button type="button" className="btn btn-go" onClick={claimAll} disabled={busy || nothing}>
      {busy ? "Claiming…" : nothing ? "Nothing to claim yet" : `Claim ${amount(total)}`}
    </button>
  );
}

const unlanded = (outcome: ClaimOutcome) => {
  const failed = outcome.transactions.find((t) => t.status === "failed");
  return failed
    ? `The claim failed on chain: ${failed.error ?? "no reason given"}.`
    : "The claim has not confirmed yet. Check it on the explorer before claiming again.";
};

const STEPS = [
  { phase: "preparing", label: "Built for the amounts shown" },
  { phase: "signing", label: "Signed and sent by your wallet" },
  { phase: "confirming", label: "Confirmed on Solana" },
] as const;

function ClaimStatus({ claim }: { claim: Claim }) {
  if (claim.phase === "idle") return null;
  if (claim.phase === "done") {
    const { outcome } = claim;
    return (
      <div className={`verdict verdict-go ${styles.status}`} role="status">
        <b>Claimed {amount(outcome.paid)}</b>
        <span className="note">
          It is in your wallet as SOL.{" "}
          {outcome.transactions.map((t, i) => (
            <a key={t.signature} href={t.explorer} target="_blank" rel="noreferrer">
              {outcome.transactions.length > 1 ? `Transaction ${i + 1}` : "See it on the explorer"}
            </a>
          ))}
        </span>
      </div>
    );
  }
  if (claim.phase === "failed") {
    return (
      <div className={`verdict verdict-stop ${styles.status}`} role="alert">
        <b>The claim did not go through</b>
        <span className="note">{claim.problem}</span>
      </div>
    );
  }
  const reached = STEPS.findIndex((s) => s.phase === claim.phase);
  return (
    <ol className={`${styles.steps} ${styles.status}`} aria-label="Claim progress">
      {STEPS.map((step, i) => {
        const state = i < reached ? "done" : i === reached ? "active" : "pending";
        return (
          <li key={step.phase} className={styles[state]} aria-current={state === "active" ? "step" : undefined}>
            <span className={styles.mark} aria-hidden="true" />
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}
