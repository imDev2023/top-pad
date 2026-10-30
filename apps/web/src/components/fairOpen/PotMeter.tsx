"use client";

import type { FairOpen } from "@top-pad/contract";
import { sol } from "@/lib/format";
import styles from "./FairOpen.module.css";

/**
 * The pot filling against its cap (spec 9, screen 2): Unverified deposits from the left, everyone else's after them,
 * anything past the cap hatched, refunded at the open, and the dashed line past which Unverified deposits stop counting:
 * together they buy at most a quarter of what the pot spends (spec 2.1 step 9).
 */
export function PotMeter({ view }: { view: FairOpen }) {
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

  return (
    <section className={`panel ${styles.pot}`} aria-labelledby="pot-title">
      <div className="spread">
        <h2 id="pot-title" className={styles.sectionTitle}>
          The pot
        </h2>
        <span className="note">
          <span className="num">{sol(total, 2)}</span> of <span className="num">{sol(cap, 2)}</span> SOL
        </span>
      </div>
      <div
        className={styles.track}
        role="img"
        aria-label={`${sol(total, 2)} SOL deposited against a ${sol(cap, 2)} SOL cap; Unverified deposits count up to ${sol(line, 2)} SOL.`}
      >
        <i className={styles.fillUnverified} style={{ width: at(unverified) }} />
        <i className={styles.fillOthers} style={{ left: at(unverified), width: at(others) }} />
        {over > 0n && <i className={styles.over} style={{ left: at(cap), width: at(over) }} />}
        {allocation.unverified.limited && unverified > line && <i className={styles.cut} style={{ left: at(line), width: at(unverified - line) }} />}
        {total > 0n && <i className={styles.line} style={{ left: at(line) }} />}
        {over > 0n && <i className={styles.capMark} style={{ left: at(cap) }} />}
      </div>
      <div className={`spread note ${styles.scale}`}>
        <span className="num">0</span>
        <span>
          <span className="num">{sol(cap, 2)}</span> SOL cap
        </span>
      </div>
      <ul className={styles.legend}>
        <li>
          <i className={styles.swatchUnverified} aria-hidden="true" />
          <span>
            Unverified <b className="num">{sol(unverified, 2)}</b> SOL
          </span>
        </li>
        <li>
          <i className={styles.swatchOthers} aria-hidden="true" />
          <span>
            Scored and Verified <b className="num">{sol(others, 2)}</b> SOL
          </span>
        </li>
        <li>
          <i className={styles.swatchLine} aria-hidden="true" />
          <span>
            Unverified deposits count up to <b className="num">{sol(line, 2)}</b> SOL, a quarter of what the pot spends
          </span>
        </li>
        {over > 0n && (
          <li>
            <i className={styles.swatchOver} aria-hidden="true" />
            <span>
              Past the cap <b className="num">{sol(over, 2)}</b> SOL, refunded
            </span>
          </li>
        )}
      </ul>
      <p className={`note ${styles.target}`}>
        The pot buys at most 20% of the <span className="num">{sol(target, 2)}</span> SOL Graduation Target, so the public opens at most 1.25 times above the
        pot&apos;s price.
      </p>
    </section>
  );
}
