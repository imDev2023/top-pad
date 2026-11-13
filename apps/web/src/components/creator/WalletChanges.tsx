"use client";

// Changing a record's Creator wallet from the pages (spec 7): the handover the old wallet offers and the new wallet takes,
// each signing the same message; the rotation of a lost wallet through the record's X account, which the new wallet
// signs and which waits out a public 7-day cooldown; and the current Creator wallet's cancel of either.
import type { UiWalletAccount } from "@wallet-standard/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { HandoverOffer, Me, WalletChange } from "@top-pad/contract";
import { acceptHandover, ApiProblem, cancelChange, cancelMessage, getHandoverOffers, handoverMessage, linkXUrl, offerHandover, requestRotation, rotationMessage } from "@/lib/api";
import { momentOf, shortAddress } from "@/lib/format";
import styles from "./Record.module.css";
import { declined, SIGN_MESSAGE, useSignText } from "./useSignText";

/** Base58, 32 to 44 characters: what could be a wallet's address at all. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Step = { phase: "idle" } | { phase: "working" } | { phase: "failed"; text: string };

const problemText = (e: unknown, what: string) => (e instanceof ApiProblem ? e.message : `${what}: ${(e as Error).message}`);
const walletText = (e: unknown) => (declined(e) ? "You declined in your wallet. Nothing was signed." : `Your wallet could not sign it: ${(e as Error).message}`);

function Failure({ step }: { step: Step }) {
  if (step.phase !== "failed") return null;
  return (
    <div className="verdict verdict-stop" role="alert">
      <b>It did not go through</b>
      <span className="note">{step.text}</span>
    </div>
  );
}

function CannotSign() {
  return (
    <div className="verdict verdict-caution" role="status">
      <b>This wallet cannot sign a message</b>
      <span className="note">A change of Creator wallet needs one. Use Phantom, Solflare or Backpack.</span>
    </div>
  );
}

/** The current Creator wallet offers its record to another wallet: one signature, then the new wallet's. */
export function HandoverForm({ account, onOffered }: { account: UiWalletAccount; onOffered: () => Promise<void> }) {
  const sign = useSignText(account);
  const [to, setTo] = useState("");
  const [step, setStep] = useState<Step>({ phase: "idle" });
  if (!account.features.includes(SIGN_MESSAGE)) return <CannotSign />;
  const valid = ADDRESS.test(to.trim()) && to.trim() !== account.address;

  async function offer() {
    setStep({ phase: "working" });
    try {
      const { message } = await handoverMessage(account.address, to.trim());
      let signature: string;
      try {
        signature = await sign(message);
      } catch (e) {
        setStep({ phase: "failed", text: walletText(e) });
        return;
      }
      await offerHandover(account.address, message, signature);
      setStep({ phase: "idle" });
      setTo("");
      await onOffered();
    } catch (e) {
      setStep({ phase: "failed", text: problemText(e, "The handover was not offered") });
    }
  }

  return (
    <form
      className={`panel ${styles.form}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void offer();
      }}
    >
      <div className="field">
        <label htmlFor="handover-to">New Creator wallet</label>
        <input
          id="handover-to"
          className="input mono"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Its address"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={to.trim() !== "" && !valid}
        />
        {to.trim() !== "" && !valid && <span className="note">{to.trim() === account.address ? "That is the Creator wallet already." : "That is not a Solana address."}</span>}
      </div>
      <div className="row">
        <button type="submit" className="btn btn-go" disabled={!valid || step.phase === "working"}>
          {step.phase === "working" ? "Signing…" : "Sign the handover"}
        </button>
        <span className="note">
          One signature from <span className="mono">{shortAddress(account.address)}</span>. No transaction, no fee. The offer stands for a day.
        </span>
      </div>
      <Failure step={step} />
    </form>
  );
}

/** The current Creator wallet cancels a pending handover or rotation with one signature. */
export function CancelChange({ account, change, onCancelled }: { account: UiWalletAccount; change: WalletChange; onCancelled: () => Promise<void> }) {
  const sign = useSignText(account);
  const [step, setStep] = useState<Step>({ phase: "idle" });
  if (!account.features.includes(SIGN_MESSAGE)) return <CannotSign />;

  async function cancel() {
    setStep({ phase: "working" });
    try {
      const { message } = await cancelMessage(change.id);
      let signature: string;
      try {
        signature = await sign(message);
      } catch (e) {
        setStep({ phase: "failed", text: walletText(e) });
        return;
      }
      await cancelChange(change.id, account.address, message, signature);
      setStep({ phase: "idle" });
      await onCancelled();
    } catch (e) {
      setStep({ phase: "failed", text: problemText(e, "It was not cancelled") });
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => void cancel()} disabled={step.phase === "working"}>
          {step.phase === "working" ? "Signing…" : change.kind === "rotation" ? "Cancel this rotation" : "Cancel this handover"}
        </button>
        <span className="note">You hold the Creator wallet: one signature cancels it.</span>
      </div>
      <Failure step={step} />
    </div>
  );
}

/** Handovers offered to the connected wallet: it takes one by signing the same message the old wallet signed. */
export function HandoverOffersPanel({ account, onTaken }: { account: UiWalletAccount; onTaken: () => void }) {
  const sign = useSignText(account);
  const [offers, setOffers] = useState<HandoverOffer[]>([]);
  const [step, setStep] = useState<Step>({ phase: "idle" });
  const [taken, setTaken] = useState<HandoverOffer | null>(null);
  useEffect(() => {
    getHandoverOffers(account.address)
      .then((o) => setOffers(o.offers))
      .catch(() => setOffers([]));
  }, [account.address]);

  if (taken) {
    return (
      <div className="verdict verdict-go" role="status">
        <b>This wallet is the Creator wallet of {recordName(taken)} now</b>
        <span className="note">
          It signs that record&apos;s launches from now on. <Link href={`/creator/${taken.record.id}`}>See the record</Link>
        </span>
      </div>
    );
  }
  if (!offers.length) return null;
  const canSign = account.features.includes(SIGN_MESSAGE);

  async function take(offer: HandoverOffer) {
    setStep({ phase: "working" });
    try {
      let signature: string;
      try {
        signature = await sign(offer.change.message);
      } catch (e) {
        setStep({ phase: "failed", text: walletText(e) });
        return;
      }
      await acceptHandover(offer.change.id, signature);
      setStep({ phase: "idle" });
      setTaken(offer);
      onTaken();
    } catch (e) {
      setStep({ phase: "failed", text: problemText(e, "The handover was not taken") });
    }
  }

  return (
    <section className={`panel ${styles.offer}`} aria-labelledby="offer-title" data-testid="handover-offer">
      <h2 id="offer-title" className={styles.offerTitle}>
        A Creator wallet handover waits for this wallet
      </h2>
      {offers.map((offer) => (
        <div key={offer.change.id} className="stack">
          <p>
            <span className="mono">{shortAddress(offer.change.from)}</span>, the Creator wallet of {recordName(offer)}, offers this wallet its place until{" "}
            {momentOf(offer.change.expiresAt!)}. Signing the same message makes <span className="mono">{shortAddress(account.address)}</span> the only wallet
            that signs that record&apos;s launches.
          </p>
          <details className={styles.details}>
            <summary>The message both wallets sign</summary>
            <pre className={styles.message}>{offer.change.message}</pre>
          </details>
          {canSign ? (
            <div className="row">
              <button type="button" className="btn btn-go" onClick={() => void take(offer)} disabled={step.phase === "working"}>
                {step.phase === "working" ? "Signing…" : "Take the Creator wallet"}
              </button>
              <span className="note">One signature. No transaction, no fee.</span>
            </div>
          ) : (
            <CannotSign />
          )}
        </div>
      ))}
      <Failure step={step} />
    </section>
  );
}

const recordName = (offer: HandoverOffer) => (offer.record.handle ? `@${offer.record.handle}` : `the record of ${shortAddress(offer.change.from)}`);

/**
 * A lost Creator wallet, rotated through the record's X account to the connected wallet: offered to a browser signed in
 * as a record that linked X whose Creator wallet is another. X must have said so in the last 15 minutes; the rotation
 * then waits out a public 7-day cooldown, which the lost wallet's holder can cancel.
 */
export function RotationPanel({ account, me, onRequested }: { account: UiWalletAccount; me: Me; onRequested: () => void }) {
  const sign = useSignText(account);
  const [step, setStep] = useState<Step>({ phase: "idle" });
  const [requested, setRequested] = useState<WalletChange | null>(null);
  if (!me.x || !me.creatorWallet || me.creatorWallet === account.address) return null;

  if (requested) {
    return (
      <div className="verdict verdict-caution" role="status" data-testid="rotation-requested">
        <b>Rotation asked: {shortAddress(account.address)} becomes the Creator wallet on {momentOf(requested.effectiveAt!)}</b>
        <span className="note">
          It is public on your record from now on, and {shortAddress(requested.from)} can cancel it until then.
        </span>
      </div>
    );
  }

  async function rotate() {
    setStep({ phase: "working" });
    try {
      const { message } = await rotationMessage(account.address);
      let signature: string;
      try {
        signature = await sign(message);
      } catch (e) {
        setStep({ phase: "failed", text: walletText(e) });
        return;
      }
      setRequested(await requestRotation(account.address, message, signature));
      setStep({ phase: "idle" });
      onRequested();
    } catch (e) {
      const stale = e instanceof ApiProblem && /X again/.test(e.message);
      setStep({ phase: "failed", text: stale ? `${e.message}` : problemText(e, "The rotation was not asked for") });
    }
  }

  return (
    <section className={`panel ${styles.offer}`} aria-labelledby="rotation-title" data-testid="rotation-panel">
      <h2 id="rotation-title" className={styles.offerTitle}>
        Lost your Creator wallet?
      </h2>
      <p>
        This browser is signed in as @{me.x.handle}&apos;s record, whose Creator wallet is <span className="mono">{shortAddress(me.creatorWallet)}</span>. If
        that wallet is lost, rotate the record to <span className="mono">{shortAddress(account.address)}</span> through X. It takes effect after a public
        7-day cooldown, which <span className="mono">{shortAddress(me.creatorWallet)}</span> can cancel.
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={() => void rotate()} disabled={step.phase === "working" || !account.features.includes(SIGN_MESSAGE)}>
          {step.phase === "working" ? "Signing…" : "Rotate to this wallet"}
        </button>
        <a href={linkXUrl("/creator")} className="note">
          Confirm @{me.x.handle} at X again
        </a>
      </div>
      <p className="note">X must confirm the account in the last 15 minutes. The new wallet signs one message; nothing is sent.</p>
      <Failure step={step} />
    </section>
  );
}
