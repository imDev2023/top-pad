"use client";

import { useSignMessage } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import type { DepositorTier, FairOpen, Me } from "@top-pad/contract";
import { useEffect, useState } from "react";
import { ApiProblem, getMe, linkXUrl, verifyMessage, verifyWallet } from "@/lib/api";
import { quoteAmount, quoteText, type QuoteUnit } from "@/lib/format";
import styles from "./FairOpen.module.css";

const SIGN_MESSAGE = "solana:signMessage";
const exact = (raw: string, quote: QuoteUnit) => quoteText(raw, quote, quote.decimals);
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

type Admitted = Extract<NonNullable<FairOpen["you"]>["admission"], { admitted: true }>;

const TIERS: { tier: DepositorTier; name: string; proof: string }[] = [
  { tier: "unverified", name: "Unverified", proof: "Any wallet. Together, Unverified seats buy at most a quarter of what the pot buys." },
  { tier: "scored", name: "Scored", proof: "A linked X account, verified once with this wallet's signature." },
  { tier: "verified", name: "Verified", proof: "World ID or Civic Uniqueness. Coming soon." },
];

/**
 * "Verify once" (spec 6.3): the Depositor tiers with their caps, the wallet's own marked, and how to move up: link X,
 * then sign one message with the wallet, which costs nothing and sends no transaction. The tier then holds in every Fair
 * Open. A wallet the linkage pipeline counts with others is told so, and why.
 */
export function VerifyOnce({ view, account, admission, onChanged }: { view: FairOpen; account: UiWalletAccount; admission: Admitted; onChanged: () => Promise<void> }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  const caps = view.tierCaps;
  const returnTo = `/fair-open/${view.launch}`;
  const canSign = account.features.includes(SIGN_MESSAGE);

  return (
    <div className={styles.verify} data-testid="fair-open-verify">
      <div className={styles.verifyHead}>
        <span className="eyebrow">Verify once</span>
        <span className="note">Your tier holds in every Fair Open.</span>
      </div>
      <ol className={styles.tiers} aria-label="Depositor tiers">
        {TIERS.map(({ tier, name, proof }) => {
          const yours = admission.tier === tier;
          return (
            <li key={tier} className={`${styles.tierRow} ${yours ? styles.tierYours : ""} ${tier === "verified" ? styles.tierSoon : ""}`} aria-current={yours ? "true" : undefined}>
              <span className={styles.tierName}>
                {name}
                {yours && <span className="chip chip-info">Yours</span>}
              </span>
              <span className={styles.tierCap}>
                up to <span className="num">{quoteAmount(caps[tier], view.quote, view.quote.decimals)}</span> {view.quote.symbol}
              </span>
              <span className={`note ${styles.tierProof}`}>{proof}</span>
            </li>
          );
        })}
      </ol>
      {admission.linked && (
        <p className="note" data-testid="fair-open-linked">
          {admission.linked}
        </p>
      )}
      {admission.tier === "unverified" ? (
        me === undefined ? null : me === null ? (
          <div className={styles.verifyAction}>
            <a className="btn btn-sm" href={linkXUrl(returnTo)}>
              Link X
            </a>
            <span className="note">Then sign once with this wallet to deposit up to {exact(caps.scored, view.quote)}.</span>
          </div>
        ) : canSign ? (
          <SignToVerify account={account} handle={me.x.handle} onVerified={onChanged} />
        ) : (
          <p className="note">Your wallet cannot sign a message, which verifying needs. Use Phantom, Solflare or Backpack.</p>
        )
      ) : (
        <p className="note" data-testid="fair-open-verified">
          {admission.via === "creator_wallet"
            ? `Scored through your Creator record's X account${admission.handle ? `, @${admission.handle}` : ""}.`
            : admission.via === "linked"
              ? `Scored as @${admission.handle}'s, by where this wallet's SOL came from.`
              : `Verified once for @${admission.handle}.`}
        </p>
      )}
    </div>
  );
}

type Signing = { phase: "idle" } | { phase: "signing" } | { phase: "failed"; text: string };

/** One message, signed by the wallet, ties it to the X account linked in this browser. */
function SignToVerify({ account, handle, onVerified }: { account: UiWalletAccount; handle: string; onVerified: () => Promise<void> }) {
  const signMessage = useSignMessage(account);
  const [signing, setSigning] = useState<Signing>({ phase: "idle" });

  async function verify() {
    setSigning({ phase: "signing" });
    try {
      const { message } = await verifyMessage(account.address);
      let signed: { signature: Uint8Array; signedMessage: Uint8Array };
      try {
        signed = await signMessage({ message: new TextEncoder().encode(message) });
      } catch (e) {
        setSigning({ phase: "failed", text: declined(e) ? "You declined in your wallet. Nothing was signed." : `Your wallet could not sign it: ${(e as Error).message}` });
        return;
      }
      const signature = btoa(String.fromCharCode(...signed.signature));
      await verifyWallet(account.address, new TextDecoder().decode(signed.signedMessage), signature);
      await onVerified();
      setSigning({ phase: "idle" });
    } catch (e) {
      setSigning({ phase: "failed", text: e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}` });
    }
  }

  return (
    <>
      <div className={styles.verifyAction}>
        <button type="button" className="btn btn-go btn-sm" disabled={signing.phase === "signing"} onClick={() => void verify()}>
          {signing.phase === "signing" ? "Signing…" : `Verify this wallet as @${handle}`}
        </button>
        <span className="note">One signature. No transaction, no fee.</span>
      </div>
      {signing.phase === "failed" && (
        <div className="verdict verdict-stop" role="alert">
          <b>It was not verified</b>
          <span className="note">{signing.text}</span>
        </div>
      )}
    </>
  );
}
