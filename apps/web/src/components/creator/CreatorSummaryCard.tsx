import Link from "next/link";
import type { CreatorSummary } from "@top-pad/contract";
import { shortAddress } from "@/lib/format";
import styles from "./Record.module.css";

/** A record's name as pages write it: its X handle when linked, else its Creator wallet, shortened. */
export function creatorName(summary: Pick<CreatorSummary, "x" | "wallet">, fallbackWallet?: string) {
  if (summary.x) return `@${summary.x.handle}`;
  const wallet = summary.wallet ?? fallbackWallet;
  return wallet ? shortAddress(wallet) : "A creator";
}

/** The graduation rate as a sentence says it: 1 of 3 (33%), or none yet. */
export const graduationText = (summary: Pick<CreatorSummary, "coins" | "graduations" | "graduationRate">) =>
  summary.graduationRate === null ? "No coin yet" : `${summary.graduations} of ${summary.coins} (${Math.round(summary.graduationRate * 100)}%)`;

/** The record's marks: a published Bar, verified creator for a good record, verified human with World ID (spec 6.5, 7). */
export function CreatorMarks({ summary }: { summary: Pick<CreatorSummary, "marks" | "barred"> }) {
  return (
    <>
      {summary.barred && (
        <span
          className="chip chip-stop flag"
          title={`An operator confirmed a creator bundle in $${summary.barred.ticker}: Heat's launch key co-signs none of this record's launches.`}
          data-testid="barred-mark"
        >
          Barred
        </span>
      )}
      {summary.marks.verifiedCreator && (
        <span className="chip chip-go flag" title="At least one graduated Heat coin, no Bar and no open bundling case." data-testid="verified-creator">
          Verified creator
        </span>
      )}
      {summary.marks.verifiedHuman && <span className="chip chip-info">Verified human</span>}
    </>
  );
}

/**
 * The record summary (spec 7, 9): what the coin page, the calendar and the Fairness card show of a coin's creator, each
 * figure one the record itself lists, with the way to the whole record.
 */
export function CreatorSummaryCard({ summary, fallbackWallet, label = "Creator" }: { summary: CreatorSummary; fallbackWallet?: string; label?: string }) {
  const name = creatorName(summary, fallbackWallet);
  return (
    <section className={`panel ${styles.summaryCard}`} aria-label="The creator's record" data-testid="creator-summary">
      <div className={styles.summaryWho}>
        {summary.x?.avatarUrl ? (
          <img src={summary.x.avatarUrl} alt="" width={36} height={36} className={styles.avatarSmall} />
        ) : (
          <span className={styles.monogramSmall} aria-hidden="true">
            {name.replace("@", "").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className={styles.summaryName}>
          <span className="eyebrow">{label}</span>
          <Link href={`/creator/${summary.id}`} className={summary.x ? styles.handle : `mono ${styles.handle}`}>
            {name}
          </Link>
        </div>
        <div className={styles.summaryMarks}>
          <CreatorMarks summary={summary} />
        </div>
      </div>
      <dl className={styles.summaryFigures}>
        <div>
          <dt>Coins</dt>
          <dd className="num">{summary.coins}</dd>
        </div>
        <div>
          <dt>Graduated</dt>
          <dd className="num">{graduationText(summary)}</dd>
        </div>
        <div>
          <dt>Handed over</dt>
          <dd className="num">{summary.handedOver}</dd>
        </div>
        <div>
          <dt>Went quiet</dt>
          <dd className="num">{summary.quiet}</dd>
        </div>
      </dl>
      <Link href={`/creator/${summary.id}`} className={styles.summaryLink}>
        See the Creator record
      </Link>
    </section>
  );
}
