"use client";

import type { Coin } from "@top-pad/contract";
import { coinAmount, quoteSmall, quoteText, shortAddress } from "@/lib/format";
import styles from "./Coin.module.css";

/**
 * A coin's way to Graduation and what came of it (spec 2.3, 9): the bar toward its Graduation Target while the curve
 * runs; a moment of "graduating" once the curve holds it; then the checkered flag, the DAMM v2 pool it trades on, its
 * fee falling as its price rises (spec 3.4), and both halves of its liquidity locked forever, each linked.
 */
export function GraduationPanel({ coin }: { coin: Coin }) {
  const target = coin.market.graduationTarget;
  const quote = coin.quote;
  const graduation = coin.graduation;
  const graduated = graduation?.graduated ?? null;

  if (graduated) {
    const fee = (graduated.feeBps / 100).toFixed(2);
    const day = new Date(graduated.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return (
      <section className={`panel ${styles.graduation} ${styles.graduated}`} aria-label="Graduation" data-testid="coin-graduated">
        <div className={styles.gradFlag}>
          <div className={`checkered ${styles.flagCloth}`} aria-hidden="true" />
          <div>
            <b>Graduated</b>
            <p className="note">
              At {quoteText(target, quote, 2)} on {day} UTC the coin moved to a Meteora DAMM v2 pool, where it trades now.
            </p>
          </div>
        </div>
        <dl className={styles.gradFacts}>
          <div>
            <dt>Liquidity</dt>
            <dd>
              100% locked forever:{" "}
              <a href={graduated.positions.creator.explorer} target="_blank" rel="noreferrer">
                the creator&apos;s half
              </a>{" "}
              and{" "}
              <a href={graduated.positions.heat.explorer} target="_blank" rel="noreferrer">
                Heat&apos;s half
              </a>
              . Nobody can withdraw it.
            </dd>
          </div>
          <div>
            <dt>Pool fee</dt>
            <dd>
              <span className="num" data-testid="coin-graduated-fee">
                {fee}%
              </span>{" "}
              <span className="note">from 1.25% at Graduation, down to 0.25% as the market cap rises to 100x.</span>
            </dd>
          </div>
          <div>
            <dt>On chain</dt>
            <dd className="row">
              <a href={graduated.explorer.pool} target="_blank" rel="noreferrer" title={graduated.pool}>
                Pool {shortAddress(graduated.pool)}
              </a>
              <a href={graduated.explorer.migration} target="_blank" rel="noreferrer">
                Migration
              </a>
              {graduated.leftoverBurnt !== null && BigInt(graduated.leftoverBurnt) > 0n && (
                <span className="note">
                  <span className="num">{coinAmount(graduated.leftoverBurnt, coin.decimals)}</span> {coin.ticker} left over, burnt
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  const reserve = coin.market.quoteReserve;
  const progress = Math.min(1, Number(reserve) / Number(target));
  const graduating = graduation !== null;
  return (
    <section className={`panel ${styles.graduation}`} aria-label="Graduation" data-testid={graduating ? "coin-graduating" : undefined}>
      <div className="spread">
        <b>{graduating ? "Graduating" : "To Graduation"}</b>
        <span className="num note">
          {Number(reserve) === 0 ? "0" : quoteSmall(reserve, quote, 3)} of {quoteText(target, quote, 2)}
        </span>
      </div>
      <div className={styles.gradBar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Toward Graduation">
        <div className={styles.gradTrack}>
          <i style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="checkered" title="Graduation" />
      </div>
      <p className="note">
        {graduating
          ? "The curve is complete. Heat's keeper is moving the coin to its Meteora pool, its liquidity locked forever; trading resumes there in moments."
          : `At ${quoteText(target, quote, 2)} the coin moves to a Meteora pool, its liquidity locked forever.`}
      </p>
    </section>
  );
}
