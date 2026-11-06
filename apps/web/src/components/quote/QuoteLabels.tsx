"use client";

// Quote Risk Labels (ADR 0007 decision 5): what a coin's quote lets its issuer do to everyone holding it, read from its
// mint, in Stoker's words and placement (Stoker `CONTEXT.md`): further information about the quote, on the launch form,
// the coin's page and the deposit page, never a chip beside its name. Labels inform; they never refuse anything. A
// quote no issuer holds a power over, SOL among them, shows none.
import type { QuoteInfo } from "@top-pad/contract";
import styles from "./QuoteLabels.module.css";

/** Where the labels sit, which decides their opening sentence. */
type Place = "launch" | "coin" | "deposit";

const LEAD: Record<Place, (symbol: string) => string> = {
  launch: (s) => `A coin priced in ${s} trades, deposits and pays out in ${s}, so its issuer's powers over ${s} reach your coin too.`,
  coin: (s) => `This coin is priced in ${s}: every trade, its curve and its Graduation run in ${s}, so its issuer's powers over ${s} reach this coin.`,
  deposit: (s) => `This Fair Open takes deposits in ${s}, and refunds and pays its Tax Share in ${s}, so its issuer's powers over ${s} reach the pot.`,
};

/** A quote's labels as a section of its own, with what Heat cannot prevent one link away. */
export function QuoteLabels({ quote, place }: { quote: QuoteInfo; place: Place }) {
  if (quote.labels.length === 0) return null;
  return (
    <section className={`panel ${styles.labels}`} aria-labelledby={`quote-labels-${place}`} data-testid="quote-labels">
      <h2 id={`quote-labels-${place}`} className="eyebrow">
        About {quote.symbol}
      </h2>
      <p className={styles.lead}>{LEAD[place](quote.symbol)}</p>
      <ul className={styles.list}>
        {quote.labels.map((label) => (
          <li key={label.kind} className={styles.label} data-kind={label.kind}>
            <span className={`chip ${label.severity === "caution" ? "chip-caution" : "chip-info"}`}>{label.title}</span>
            <span className={styles.detail}>{label.detail}</span>
          </li>
        ))}
      </ul>
      <p className="note">
        Read from <a href={quote.explorer} target="_blank" rel="noreferrer">{quote.symbol}&apos;s mint</a> on chain. Heat cannot prevent any of
        this: <a href="/enforced#quotes">how this is enforced</a>.
      </p>
    </section>
  );
}
