"use client";

// Vamp Shield's live verdict in the launch flow (spec 6.2, 9 screen 4): the ticker, the name and the image, each clear,
// "looks like" a Protected coin (it launches with that label) or refused, the coin it matched shown beside it; a refusal
// links to an appeal. The image is checked by the vision service, which sleeps when nobody is launching and can take
// some seconds to wake, so its wait says so.
import Link from "next/link";
import { useEffect, useState } from "react";
import type { FieldVerdict, ImageVerdict, LaunchRefusal, ProtectedMatch, VampShieldVerdict } from "@top-pad/contract";
import styles from "./Launch.module.css";

/** Where the image's check stands. */
export type ImageCheckState =
  | { state: "none" }
  | { state: "checking"; startedAt: number }
  | { state: "done"; verdict: ImageVerdict }
  | { state: "problem"; problem: string };

/** A Protected coin's name for a label: its ticker with a $, else its name. */
export const coinLabel = (m: ProtectedMatch) => (m.ticker ? `$${m.ticker.replace(/^\$/, "")}` : m.name);

/** How long an image check runs before the panel says the vision service is waking. */
const WAKING_AFTER_MS = 2_500;

export function VampVerdict({
  ready,
  text,
  textProblem,
  image,
  refusal,
  appealHref,
  onRetryImage,
}: {
  /** Whether the ticker and the name pass the rules typed so far, so the Protected coins are asked. */
  ready: boolean;
  text: VampShieldVerdict | null;
  textProblem: string | null;
  image: ImageCheckState;
  /** The launch service's refusal when the launch was prepared, which supersedes the live verdicts. */
  refusal: LaunchRefusal | null;
  appealHref: string;
  onRetryImage: () => void;
}) {
  const fields: [label: string, verdict: FieldVerdict | null, pending: string | null][] = [
    ["Ticker", refusal?.verdict?.verdicts.ticker ?? text?.verdicts.ticker ?? null, ready ? (textProblem ? "Not checked" : "Checking…") : "Waiting"],
    ["Name", refusal?.verdict?.verdicts.name ?? text?.verdicts.name ?? null, ready ? (textProblem ? "Not checked" : "Checking…") : "Waiting"],
    ["Image", refusal?.imageVerdict ?? (image.state === "done" ? image.verdict.verdict : null), image.state === "none" ? "Waiting" : image.state === "problem" ? "Not checked" : "Checking…"],
  ];
  const verdicts = fields.map(([, v]) => v);
  const refused = verdicts.find((v) => v?.status === "refused") ?? null;
  const near = verdicts.find((v) => v?.status === "looks_like") ?? null;
  const settled = verdicts.every((v) => v !== null);
  const tone = refused || refusal ? "stop" : near ? "caution" : settled ? "go" : textProblem || image.state === "problem" ? "caution" : "neutral";
  const headline =
    refused || refusal
      ? refused?.match
        ? `Refused: copies ${coinLabel(refused.match)}`
        : "Refused"
      : near?.match
        ? `Launches labelled "Looks like ${coinLabel(near.match)}"`
        : settled
          ? "Clear"
          : "Vamp Shield";

  return (
    <div className={`verdict verdict-${tone} ${styles.vamp}`} role="status" data-testid="vamp-verdict">
      <b data-testid="vamp-headline">{headline}</b>
      {!settled && !refusal && (
        <span className="note">Your ticker, name and image are checked against every protected coin before anything is signed.</span>
      )}
      {near && !refused && !refusal && (
        <span className="note">Close to a protected coin, not a copy of one: it can launch, and its page and rows say what it looks like.</span>
      )}
      <ul className={styles.checks}>
        {fields.map(([label, verdict, pending]) => (
          <CheckRow key={label} label={label} verdict={verdict} pending={pending} image={label === "Image" ? image : null} onRetryImage={onRetryImage} />
        ))}
      </ul>
      {textProblem && <span className="note">The ticker and name could not be checked: {textProblem}</span>}
      {refusal && !refused && <span className="note">{refusal.error}</span>}
      {(refused || refusal?.code === "vamp_shield") && (
        <span className={styles.appeal}>
          <Link href={appealHref} data-testid="vamp-appeal">
            Think this is wrong? Appeal
          </Link>
          <span className="note">Heat&apos;s operators answer within 48 hours. A relaunch or a community takeover passes by linking the original.</span>
        </span>
      )}
    </div>
  );
}

function CheckRow({
  label,
  verdict,
  pending,
  image,
  onRetryImage,
}: {
  label: string;
  verdict: FieldVerdict | null;
  pending: string | null;
  image: ImageCheckState | null;
  onRetryImage: () => void;
}) {
  const chip = verdict
    ? verdict.status === "clear"
      ? { tone: "go", text: "Clear" }
      : verdict.status === "looks_like"
        ? { tone: "caution", text: verdict.match ? `Looks like ${coinLabel(verdict.match)}` : "Looks like a protected coin" }
        : { tone: "stop", text: "Refused" }
    : { tone: "neutral", text: pending ?? "Waiting" };
  return (
    <li className={styles.check} data-testid={`vamp-${label.toLowerCase()}`}>
      <span className={styles.checkLabel}>{label}</span>
      <span className={`chip chip-${chip.tone} ${styles.checkChip}`}>{chip.text}</span>
      <span className={styles.checkBody}>
        {verdict?.reason && <span className={styles.checkReason}>{verdict.reason}</span>}
        {!verdict && image?.state === "checking" && <Waking startedAt={image.startedAt} />}
        {!verdict && image?.state === "problem" && (
          <span className={styles.checkReason}>
            {image.problem}{" "}
            <button type="button" className={styles.linkButton} onClick={onRetryImage}>
              Check again
            </button>
          </span>
        )}
        {verdict?.match && verdict.status !== "clear" && <Matched match={verdict.match} />}
      </span>
    </li>
  );
}

/** The protected coin a verdict names: its picture, where it is protected from, and a link to it. */
function Matched({ match }: { match: ProtectedMatch }) {
  const source = { jupiter_verified: "Verified on Jupiter", organic: "Real trading on Solana", trending: "Trending on Jupiter", coingecko_top: "CoinGecko top 1,000", heat: "A Heat coin" }[match.source];
  return (
    <a className={styles.matched} href={match.url} target="_blank" rel="noreferrer">
      {match.imageUrl ? (
        <img src={match.imageUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className={styles.matchedInitials} aria-hidden="true">
          {(match.ticker || match.name).replace(/^\$/, "").slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className={styles.matchedText}>
        <span>
          {match.name} <span className="mono">{coinLabel(match)}</span>
        </span>
        <span className="note">{source}</span>
      </span>
    </a>
  );
}

/** How long the image's check has run, and why a long one is waiting. */
function Waking({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, []);
  const ms = now - startedAt;
  if (ms < WAKING_AFTER_MS) return null;
  return <span className={`note ${styles.checkReason}`}>Waking Vamp Shield&apos;s image check, which sleeps while nobody is launching… {Math.floor(ms / 1000)} s</span>;
}
