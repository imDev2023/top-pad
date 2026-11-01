"use client";

import type { Coin } from "@top-pad/contract";
import { sol, span } from "@/lib/format";
import styles from "./Coin.module.css";

/** The sniper tax `elapsed` seconds after the open, as a fraction: the config's linear fee scheduler (spec 3.2). */
export function taxRate(tax: Coin["tax"], elapsed: number) {
  const periods = Math.min(Math.max(Math.floor(elapsed / tax.periodSeconds), 0), tax.periods);
  return (Number(tax.cliffNumerator) - Number(tax.reductionPerPeriod) * periods) / Number(tax.denominator);
}

const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;

/**
 * The sniper tax as it falls (spec 9): yellow while it runs, with the rate a trade pays this second and how long until it
 * ends, then green. `now` is the API's clock, since a browser's own can be seconds off.
 */
export function TaxBand({ coin, now }: { coin: Coin; now: number }) {
  const windowSeconds = coin.tax.periods * coin.tax.periodSeconds;
  const elapsed = (now - Date.parse(coin.activatedAt)) / 1000;
  const running = elapsed < windowSeconds;

  const rate = taxRate(coin.tax, elapsed);
  const ending = taxRate(coin.tax, windowSeconds);
  // Spec 4: a Fair Open's depositors get it as their Tax Share; every other pool on Heat's configs pays it to Heat.
  const destination = coin.launchMode === "fair_open" ? "to the Fair Open's depositors as their Tax Share" : "to Heat";

  if (!running) {
    const claim = coin.windowClaim;
    const late = claim ? Math.round((Date.parse(claim.claimedAt) - Date.parse(claim.windowEndedAt)) / 1000) : 0;
    return (
      <section className={`${styles.taxBand} ${styles.taxDone}`} aria-label="Sniper tax">
        <div>
          <p className="eyebrow">Fee now</p>
          <p className={`num ${styles.taxRate}`}>{percent(ending)}</p>
        </div>
        <p className="note" data-testid="tax-outcome">
          The sniper tax ran for the coin&apos;s first minute and went {destination}, never to the creator.{" "}
          {coin.launchMode !== "fair_open" &&
            (claim ? (
              <>
                Heat&apos;s treasury was paid <b className="num">{sol(claim.amount, 9)}&nbsp;SOL</b> for that minute, claimed {span(late)} after it
                ended (
                <a href={claim.explorer} target="_blank" rel="noreferrer">
                  see the claim
                </a>
                ).{" "}
              </>
            ) : (
              <>Heat&apos;s claim of it shows here once it lands. </>
            ))}
          {coin.fairOpen?.taxShare &&
            (coin.fairOpen.taxShare.toTreasury ? (
              <>
                The creator was the only depositor, so Heat&apos;s treasury was paid it,{" "}
                <b className="num">{sol(coin.fairOpen.taxShare.total, 9)}&nbsp;SOL</b> (
                <a href={coin.fairOpen.taxShare.explorer} target="_blank" rel="noreferrer">
                  see the claim
                </a>
                ).{" "}
              </>
            ) : (
              <>
                The depositors&apos; Tax Share came to <b className="num">{sol(coin.fairOpen.taxShare.total, 9)}&nbsp;SOL</b> (
                <a href={coin.fairOpen.taxShare.explorer} target="_blank" rel="noreferrer">
                  see the claim
                </a>
                ).{" "}
              </>
            ))}
          Every trade now pays the {percent(ending)} trading fee.
        </p>
      </section>
    );
  }
  const left = Math.max(0, Math.ceil(windowSeconds - Math.max(elapsed, 0)));
  return (
    <section className={styles.taxBand} aria-label="Sniper tax" aria-live="off">
      <div>
        <p className="eyebrow">Sniper tax now</p>
        <p className={`num ${styles.taxRate}`}>{percent(rate)}</p>
      </div>
      <div className={styles.taxBody}>
        <div className={styles.taxTrack} aria-hidden="true">
          <i style={{ width: `${(left / windowSeconds) * 100}%` }} />
        </div>
        <p className="note">
          Falls every second to {percent(ending)} in <b className="num">{left}</b>&nbsp;s. Every buy and sell pays it, the creator&apos;s
          too. It goes {destination}, never to the creator.
        </p>
      </div>
    </section>
  );
}
