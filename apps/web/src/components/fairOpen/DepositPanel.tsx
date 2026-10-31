"use client";

import { getBase58Decoder } from "@solana/kit";
import { useSignAndSendTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import type { FairOpen, FairOpenOutcome } from "@top-pad/contract";
import { useState } from "react";
import { ApiProblem, linkXUrl, prepareFairOpen, reportFairOpen } from "@/lib/api";
import { coinAmount, sol } from "@/lib/format";
import { WalletButton } from "../WalletButton";
import { useWallet, type SolanaChain } from "../WalletProvider";
import styles from "./FairOpen.module.css";

const SIGN_AND_SEND = "solana:signAndSendTransaction";
const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

/** SOL as typed, in whole 0.01 SOL steps: its lamports, or null when it is not such an amount. */
export function lamportsOf(text: string): bigint | null {
  const match = /^(\d{0,6})(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!match || (match[1] === "" && !match[2])) return null;
  const lamports = BigInt(match[1] || "0") * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(2, "0")) * 10_000_000n;
  return lamports > 0n ? lamports : null;
}

/** The program's refusals a page can meet, in its words (programs/fair_open, `FairOpenError`). */
const REFUSALS: Record<number, string> = {
  6011: "The launch is no longer taking deposits.",
  6012: "The window has not opened yet.",
  6013: "The window closed before your transaction landed.",
  6018: "Your admission expired before the transaction landed. Try again.",
  6020: "This person's seat is held by another wallet.",
  6021: "That would be over your cap.",
  6029: "The pot can still open, so it cannot be marked failed yet.",
  6048: "Your coins and refund were already on their way: they are in your wallet.",
};

function refusalOf(outcome: FairOpenOutcome) {
  if (outcome.status === "pending") return "It has not confirmed yet. Check it on the explorer before trying again.";
  const custom = /"Custom":(\d+)/.exec(outcome.error ?? "")?.[1];
  return (custom && REFUSALS[Number(custom)]) || `It failed on chain: ${outcome.error ?? "no reason given"}.`;
}

/** What connecting a wallet is for, as the launch stands. */
const CONNECT: Record<FairOpen["phase"], string> = {
  scheduled: "Connect a wallet to deposit. Your tier sets your cap: Unverified 0.1 SOL, Scored 0.5 SOL, Verified 2 SOL.",
  window: "Connect a wallet to deposit. Your tier sets your cap: Unverified 0.1 SOL, Scored 0.5 SOL, Verified 2 SOL.",
  due: "The window has closed. Connect a wallet to see your seat.",
  opened: "Connect a wallet to see your coins and refund.",
  failing: "Connect a wallet to see your seat and take back your SOL.",
  failed: "Connect a wallet to see your seat and take back your SOL.",
  closed: "Every deposit and rent has gone back.",
};

type Action = "deposit" | "withdraw" | "mark-failed" | "refund" | "claim";

/** What a landed transaction did, in words. */
function doneText(action: Action, lamports: bigint | undefined, seated: boolean) {
  switch (action) {
    case "deposit":
      return `Deposited ${sol(lamports ?? 0n, 2)} SOL.`;
    case "withdraw":
      return `Took back ${sol(lamports ?? 0n, 2)} SOL.`;
    case "mark-failed":
      return seated ? "Marked failed, and your deposit and both rents are back in your wallet." : "Marked failed: every depositor can now take their SOL back.";
    case "refund":
      return "Your deposit and both rents are back in your wallet.";
    case "claim":
      return "Your coins and refund are in your wallet.";
  }
}
type Sending = { phase: "idle" } | { phase: "preparing" | "signing" | "confirming"; action: Action } | { phase: "done"; text: string; explorer: string } | { phase: "failed"; text: string };

const TIER_NAMES = { unverified: "Unverified", scored: "Scored", verified: "Verified" } as const;

/**
 * The visitor's deposit (spec 2.1 step 9): their Depositor tier and cap, what their seat holds and the rent it keeps,
 * and deposits or withdrawals in 0.01 SOL steps while the window is open; after it, marking a launch that cannot open
 * failed, and taking everything back once it has. Heat's API builds each transaction, a deposit with its admission, and
 * the wallet signs and sends it.
 */
export function DepositPanel({ view, onChanged }: { view: FairOpen; onChanged: () => Promise<void> }) {
  const { account, chain } = useWallet();
  return (
    <section className={`panel ${styles.deposit}`} aria-labelledby="your-deposit">
      <div className="spread">
        <h2 id="your-deposit" className={styles.sectionTitle}>
          Your deposit
        </h2>
        {view.you?.admission.admitted && (
          <span className="chip chip-info" data-testid="fair-open-tier">
            {TIER_NAMES[view.you.admission.tier]} · cap {sol(view.you.admission.cap, 2)} SOL
          </span>
        )}
      </div>
      {!account ? (
        <>
          <p className="muted">{CONNECT[view.phase]}</p>
          {view.phase !== "closed" && <WalletButton variant="inline" />}
        </>
      ) : !view.you || view.you.wallet !== account.address ? (
        <p className="muted">Reading your seat from the chain…</p>
      ) : account.features.includes(SIGN_AND_SEND) ? (
        <Seated view={view} account={account} chain={chain} onChanged={onChanged} />
      ) : (
        <p className="note">Your wallet can sign but not send a transaction from a page, which a deposit needs. Use Phantom, Solflare or Backpack.</p>
      )}
    </section>
  );
}

function Seated({ view, account, chain, onChanged }: { view: FairOpen; account: UiWalletAccount; chain: SolanaChain; onChanged: () => Promise<void> }) {
  const you = view.you!;
  const seat = you.seat;
  const signAndSend = useSignAndSendTransaction(account, chain);
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [text, setText] = useState("");
  const [sending, setSending] = useState<Sending>({ phase: "idle" });
  const busy = sending.phase === "preparing" || sending.phase === "signing" || sending.phase === "confirming";
  // A deposit's or withdrawal's outcome belongs to the window: once it closes, what the panel offers is another phase's.
  const windowOpen = view.phase === "window";
  const [wasOpen, setWasOpen] = useState(windowOpen);
  if (wasOpen !== windowOpen) {
    setWasOpen(windowOpen);
    if (!busy) setSending({ phase: "idle" });
  }

  const held = seat ? BigInt(seat.deposit) : 0n;
  const cap = you.admission.admitted ? BigInt(you.admission.cap) : 0n;
  const max = mode === "deposit" ? (cap > held ? cap - held : 0n) : held;
  const amount = lamportsOf(text);
  const invalid = text !== "" && (amount === null || amount > max);

  async function send(action: Action, lamports?: bigint) {
    try {
      setSending({ phase: "preparing", action });
      const prepared = await prepareFairOpen(view.launch, action, { wallet: account.address, ...(lamports ? { amount: `${lamports}` } : {}) });
      setSending({ phase: "signing", action });
      let signature: Uint8Array;
      try {
        ({ signature } = await signAndSend({ transaction: toBytes(prepared.transaction) }));
      } catch (e) {
        setSending({ phase: "failed", text: declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not send it: ${(e as Error).message}` });
        return;
      }
      setSending({ phase: "confirming", action });
      const outcome = await reportFairOpen(getBase58Decoder().decode(signature));
      if (outcome.status !== "landed") {
        setSending({ phase: "failed", text: refusalOf(outcome) });
      } else {
        setSending({ phase: "done", text: doneText(action, lamports, seat !== null), explorer: outcome.explorer });
        setText("");
      }
      await onChanged();
    } catch (e) {
      setSending({ phase: "failed", text: e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}` });
    }
  }

  const rent = BigInt(view.rent.seat) + BigInt(view.rent.coinAccount);
  const seatRent = seat ? BigInt(seat.seatRent) + BigInt(seat.coinRent) : 0n;

  return (
    <div className={styles.seated}>
      <Tier view={view} />
      {seat ? (
        <dl className={styles.holding}>
          <div>
            <dt className="eyebrow">Your seat holds</dt>
            <dd className={styles.held} data-testid="fair-open-held">
              <span className="num">{sol(seat.deposit, 2)}</span> SOL
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Rent kept for you</dt>
            <dd>
              <span className="num">{sol(seatRent, 6)}</span> SOL
            </dd>
          </div>
        </dl>
      ) : (
        you.admission.admitted && (
          <p className="note">{view.phase === "failed" || view.phase === "closed" ? "You hold no seat here." : "You hold no seat here yet."}</p>
        )
      )}

      {view.phase === "window" && you.admission.admitted && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (amount !== null && !invalid) void send(mode, amount);
          }}
        >
          <div className={styles.modes} role="radiogroup" aria-label="Deposit or withdraw">
            {(["deposit", "withdraw"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={`${styles.mode} ${mode === m ? styles.modeOn : ""}`}
                disabled={m === "withdraw" && held === 0n}
                onClick={() => {
                  setMode(m);
                  setText("");
                }}
              >
                {m === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="fair-open-amount">Amount (SOL, in steps of 0.01)</label>
            <div className={styles.amount}>
              <input
                id="fair-open-amount"
                className="input mono"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={text}
                aria-invalid={invalid}
                onChange={(e) => setText(e.target.value)}
              />
              <button type="button" className="btn btn-sm" disabled={max === 0n} onClick={() => setText(sol(max, 2))}>
                Max
              </button>
            </div>
            {invalid && (
              <span className={`note ${styles.invalid}`}>
                {amount === null ? "Enter SOL in steps of 0.01." : mode === "deposit" ? `You can add at most ${sol(max, 2)} SOL.` : `Your seat holds ${sol(max, 2)} SOL.`}
              </span>
            )}
          </div>
          <button type="submit" className={`btn ${mode === "deposit" ? "btn-go" : ""}`} disabled={busy || amount === null || invalid}>
            {busy ? (mode === "deposit" ? "Depositing…" : "Withdrawing…") : `${mode === "deposit" ? "Deposit" : "Withdraw"}${amount && !invalid ? ` ${sol(amount, 2)} SOL` : ""}`}
          </button>
          {mode === "deposit" && !seat && (
            <p className="note">Your first deposit also puts up {sol(rent, 6)} SOL of rent for your seat and the coin account the open fills. All of it comes back.</p>
          )}
        </form>
      )}

      {view.phase === "opened" && seat?.coins != null && (
        <dl className={styles.holding}>
          <div>
            <dt className="eyebrow">Your coins</dt>
            <dd className={styles.held} data-testid="fair-open-coins">
              <span className="num">{coinAmount(seat.coins, view.open?.coinDecimals)}</span>
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Your refund</dt>
            <dd>
              <span className="num">{sol(seat.refund, 9)}</span> SOL
            </dd>
          </div>
        </dl>
      )}
      {view.phase === "opened" &&
        seat &&
        (seat.delivered ? (
          <p className="note" data-testid="fair-open-in-wallet">
            In your wallet: Heat&apos;s keeper sent them right after the open.
          </p>
        ) : you.wallet === view.creator.wallet ? (
          <p className="note">As the creator, your coins go into the Creator lock, which comes in Heat&apos;s next build.</p>
        ) : (
          <button type="button" className="btn btn-go" disabled={busy} onClick={() => void send("claim")}>
            Claim my coins and refund
          </button>
        ))}
      {view.phase === "scheduled" && <p className="note">Deposits open with the window. Your cap and your seat show here.</p>}
      {view.phase === "due" && seat && (
        <p className="note">Your deposit is locked until the open. If the coin is not created in time, the launch fails and you take everything back.</p>
      )}
      {view.phase === "failing" && (
        <button type="button" className="btn btn-go" disabled={busy} onClick={() => void send("mark-failed")}>
          {seat ? "Mark it failed and take back my SOL" : "Mark it failed"}
        </button>
      )}
      {view.phase === "failed" && seat && (
        <button type="button" className="btn btn-go" disabled={busy} onClick={() => void send("refund")}>
          Take back {sol(BigInt(seat.deposit) + seatRent, 6)} SOL
        </button>
      )}

      <Status sending={sending} />
    </div>
  );
}

/** The tier and how Heat knows it, or why this wallet may not deposit. */
function Tier({ view }: { view: FairOpen }) {
  const admission = view.you!.admission;
  if (!admission.admitted) {
    return (
      <div className="verdict verdict-stop" role="alert">
        <b>This wallet cannot deposit here</b>
        <span className="note">{admission.reason}</span>
      </div>
    );
  }
  if (admission.tier === "unverified") {
    return (
      <p className="note">
        Unverified wallets deposit up to 0.1 SOL, and all of them together get at most a quarter of the pot&apos;s buy.{" "}
        <a href={linkXUrl(`/fair-open/${view.launch}`)}>Link X</a> to deposit up to 0.5 SOL.
      </p>
    );
  }
  const how = admission.via === "creator_wallet" ? "your Creator record's X account" : "your linked X account";
  return (
    <p className="note">
      {TIER_NAMES[admission.tier]} through {how}
      {admission.handle ? ` @${admission.handle}` : ""}. Verifying once, for up to 2 SOL in every Fair Open, comes in a later build.
    </p>
  );
}

const STEPS = [
  { phase: "preparing", label: "Built by Heat, with your admission" },
  { phase: "signing", label: "Signed and sent by your wallet" },
  { phase: "confirming", label: "Confirmed on Solana" },
] as const;

function Status({ sending }: { sending: Sending }) {
  if (sending.phase === "idle") return null;
  if (sending.phase === "done") {
    return (
      <div className="verdict verdict-go" role="status" data-testid="fair-open-done">
        <b>{sending.text}</b>
        <a className="note" href={sending.explorer} target="_blank" rel="noreferrer">
          See it on the explorer
        </a>
      </div>
    );
  }
  if (sending.phase === "failed") {
    return (
      <div className="verdict verdict-stop" role="alert">
        <b>It did not go through</b>
        <span className="note">{sending.text}</span>
      </div>
    );
  }
  const reached = STEPS.findIndex((s) => s.phase === sending.phase);
  return (
    <ol className={styles.progress} aria-label="Progress">
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
