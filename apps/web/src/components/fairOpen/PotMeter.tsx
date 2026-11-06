"use client";

import type { FairOpen } from "@top-pad/contract";
import { quoteAmount, quoteText } from "@/lib/format";
import styles from "./FairOpen.module.css";
import { stepPlaces } from "./FairOpenPage";

/**
 * The pot filling against its cap (spec 9, screen 2): Unverified deposits from the left, everyone else's after them,
 * anything past the cap hatched, refunded at the open, and the dashed line past which Unverified deposits stop counting:
 * together they buy at most a quarter of what the pot spends (spec 2.1 step 9). Once the launch cannot open, it buys
 * nothing, and the pot shows only the deposits still to go back. Past the cap, the bar runs to the total. Every figure is
 * in the launch's quote.
 */
export function PotMeter({ view }: { view: FairOpen }) {
  const ended = view.phase === "failing" || view.phase === "failed" || view.phase === "closed";
  const cap = BigInt(view.potCap);
  const unverified = BigInt(view.pot.unverified);
  const others = BigInt(view.pot.scored) + BigInt(view.pot.verified);
  const total = unverified + others;
  const track = total > cap ? total : cap;
  const at = (amount: bigint) => `${(Number(amount) / Number(track)) * 100}%`;
  const { allocation } = view;
  // Where Unverified deposits stop counting: where they are cut now, or else the quarter of the spend they may fill.
  const line = allocation.unverified.limited ? BigInt(allocation.unverified.filled) : BigInt(allocation.spend) / 4n;
  const over = total > cap ? total - cap : 0n;
  const target = (cap * 100n) / 20n;
  const { quote } = view;
  // Deposits are whole steps, shown to every place they need; the cap, the line, the target and what passes the cap to a
  // step's places.
  const exact = (raw: bigint) => quoteAmount(raw, quote, quote.decimals);
  const places = stepPlaces(view.step, quote);
  const capText = quoteAmount(cap, quote, places);

  return (
    <section className={`panel ${styles.pot}`} aria-labelledby="pot-title">
      <div className="spread">
        <h2 id="pot-title" className={styles.sectionTitle}>
          The pot
        </h2>
        <span className="note">
          <span className="num">{exact(total)}</span> of <span className="num">{capText}</span> {quote.symbol}
        </span>
      </div>
      <div
        className={styles.track}
        role="img"
        aria-label={`${quoteText(total, quote, quote.decimals)} deposited against a ${quoteText(cap, quote, places)} cap${ended ? "" : `; Unverified deposits count up to ${quoteText(line, quote, places)}`}.`}
      >
        <i className={styles.fillUnverified} style={{ width: at(unverified) }} />
        <i className={styles.fillOthers} style={{ left: at(unverified), width: at(others) }} />
        {over > 0n && <i className={styles.over} style={{ left: at(cap), width: at(over) }} />}
        {!ended && allocation.unverified.limited && unverified > line && <i className={styles.cut} style={{ left: at(line), width: at(unverified - line) }} />}
        {!ended && total > 0n && <i className={styles.line} style={{ left: at(line) }} />}
        {over > 0n && <i className={styles.capMark} style={{ left: at(cap) }} />}
      </div>
      <div className={`spread note ${styles.scale}`}>
        <span className="num">0</span>
        {over > 0n ? (
          <span>
            <span className="num">{exact(total)}</span> {quote.symbol}
          </span>
        ) : (
          <span>
            <span className="num">{capText}</span> {quote.symbol} cap
          </span>
        )}
      </div>
      <ul className={styles.legend}>
        <li>
          <i className={styles.swatchUnverified} aria-hidden="true" />
          <span>
            Unverified <b className="num">{exact(unverified)}</b> {quote.symbol}
          </span>
        </li>
        <li>
          <i className={styles.swatchOthers} aria-hidden="true" />
          <span>
            Scored and Verified <b className="num">{exact(others)}</b> {quote.symbol}
          </span>
        </li>
        {!ended && (
          <li>
            <i className={styles.swatchLine} aria-hidden="true" />
            <span>
              Unverified deposits count up to <b className="num">{quoteAmount(line, quote, places)}</b> {quote.symbol}: together they buy at most a quarter of what the pot spends
            </span>
          </li>
        )}
        {over > 0n && (
          <li>
            <i className={styles.swatchOver} aria-hidden="true" />
            <span>
              Past the cap <b className="num">{quoteAmount(over, quote, places)}</b> {quote.symbol}, refunded
            </span>
          </li>
        )}
      </ul>
      {!ended && (
        <p className={`note ${styles.target}`}>
          The pot buys at most 20% of the <span className="num">{quoteAmount(target, quote, places)}</span> {quote.symbol} Graduation Target, so the public opens at most 1.25 times above the
          pot&apos;s price.
        </p>
      )}
    </section>
  );
}
