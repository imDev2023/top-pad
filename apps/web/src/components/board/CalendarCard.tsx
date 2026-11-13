import Link from "next/link";
import type { CalendarEntry } from "@top-pad/contract";
import { creatorName, CreatorMarks, graduationText } from "@/components/creator/CreatorSummaryCard";
import { quoteText, shortAddress } from "@/lib/format";
import styles from "./Board.module.css";

/** A countdown as a board writes it: 08:42 inside the hour, 3h 20m inside the day, 2d 4h beyond. */
export function countdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3_600) return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ${String(Math.floor((s % 3_600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3_600)}h`;
}

/** The time of day in UTC, so the server and the browser agree: 14:30 UTC. */
export const timeOf = (iso: string) => `${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

/**
 * A sealed calendar entry (spec 8, 9): the "?" tile, the time, the creator and their record summary, the terms and the
 * teaser. Live now, it shows the pot filling and counts down to the open; Up next, it counts down to the window.
 */
export function CalendarCard({ entry, now, live = false }: { entry: CalendarEntry; now: number; live?: boolean }) {
  const quote = entry.quote;
  const name = entry.record ? creatorName(entry.record, entry.creator.wallet) : entry.creator.handle ? `@${entry.creator.handle}` : shortAddress(entry.creator.wallet);
  const fill = Math.min(1, Number(BigInt(entry.pot.total)) / Math.max(1, Number(BigInt(entry.potCap))));
  const floor = Math.min(1, Number(BigInt(entry.minRaise)) / Math.max(1, Number(BigInt(entry.potCap))));
  const to = live ? entry.opensAt : entry.depositsOpenAt;
  return (
    <article
      className={`panel ${styles.entry} ${live ? styles.entryLive : ""} ${entry.featured ? styles.entryFeatured : ""}`}
      data-testid="calendar-entry"
      data-launch={entry.launch}
      aria-label={`Sealed Fair Open by ${name}, opening ${timeOf(entry.opensAt)}`}
    >
      <Link href={`/fair-open/${entry.launch}`} className={styles.coinLink} aria-label={`The Fair Open by ${name}`} />
      <div className={styles.entryHead}>
        <span className={styles.sealed} aria-hidden="true">
          ?
        </span>
        <div className={styles.entryWhen}>
          <span className="eyebrow">{live ? "Opens in" : "Deposits open in"}</span>
          <span className={`num ${styles.entryCountdown}`} data-testid="countdown" suppressHydrationWarning>
            {countdown(Date.parse(to) - now)}
          </span>
          <span className={styles.entryTime}>Opens {timeOf(entry.opensAt)}</span>
        </div>
        {entry.featured && (
          <span className={`chip chip-go ${styles.featuredChip}`} title="One of the day's three featured slots: earned by a good record, never sold" data-testid="featured">
            Featured
          </span>
        )}
      </div>
      {entry.teaser && <p className={styles.teaser}>&ldquo;{entry.teaser}&rdquo;</p>}
      {live && (
        <div className={styles.pot}>
          <div className={styles.potBar} role="img" aria-label={`The pot holds ${quoteText(entry.pot.total, quote)} of ${quoteText(entry.potCap, quote)}`}>
            <span className={styles.potFill} style={{ width: `${fill * 100}%` }} />
            {floor > 0 && <span className={styles.potFloor} style={{ left: `${floor * 100}%` }} title="The minimum raise" />}
          </div>
          <div className={styles.potFigures}>
            {entry.pot.seats ? (
              <span>
                <b className="num">{quoteText(entry.pot.total, quote)}</b> from {entry.pot.seats === 1 ? "1 person" : `${entry.pot.seats} people`}
              </span>
            ) : (
              <span>No deposits yet</span>
            )}
            <span className="num">{quoteText(entry.potCap, quote)} cap</span>
          </div>
        </div>
      )}
      <dl className={styles.terms}>
        <div>
          <dt>Minimum raise</dt>
          <dd className="num">{BigInt(entry.minRaise) > 0n ? quoteText(entry.minRaise, quote) : "None"}</dd>
        </div>
        <div>
          <dt>Pot cap</dt>
          <dd className="num">{quoteText(entry.potCap, quote)}</dd>
        </div>
      </dl>
      <div className={styles.entryCreator}>
        <span className={entry.record?.x || entry.creator.handle ? styles.creatorName : `mono ${styles.creatorName}`}>{name}</span>
        {entry.record ? (
          <>
            <span className={styles.recordLine}>{entry.record.coins === 0 ? "First launch" : `Graduated ${graduationText(entry.record)}`}</span>
            <span className={styles.marks}>
              <CreatorMarks summary={entry.record} />
            </span>
          </>
        ) : null}
      </div>
    </article>
  );
}
