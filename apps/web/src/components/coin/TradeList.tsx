"use client";

import type { Trade } from "@top-pad/contract";
import { ago, coinAmount, shortAddress, solAmount } from "@/lib/format";
import styles from "./Coin.module.css";

/** A trade's fee as a share of what it moved before the fee. */
export const feeRate = (t: Pick<Trade, "fee" | "quoteAmount">) => Number(t.fee) / Number(t.quoteAmount);

/**
 * The coin's trades, newest first, each with the fee it paid (spec 9, screen 3): yellow for a trade inside the sniper
 * tax's minute, red above half the trade. Trades that arrive live flash once.
 */
export function TradeList({
  trades,
  fresh,
  now,
  taxEnds,
  decimals,
  explorerTx,
}: {
  trades: Trade[];
  /** Keys of the trades that arrived live. */
  fresh: ReadonlySet<string>;
  now: number;
  /** When the sniper tax's minute ended, in milliseconds: a trade before it paid the tax. */
  taxEnds: number;
  decimals: number;
  explorerTx: (signature: string) => string;
}) {
  if (!trades.length) return <p className={`note ${styles.empty}`}>No trades yet.</p>;
  return (
    <div className={styles.trades}>
      <table className={styles.tradeTable}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Side</th>
            <th scope="col" className={styles.right}>
              SOL
            </th>
            <th scope="col" className={`${styles.right} ${styles.wide}`}>
              Coins
            </th>
            <th scope="col" className={styles.right}>
              Fee paid
            </th>
            <th scope="col" className={styles.wide}>
              Wallet
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const key = `${t.signature}:${t.eventIndex}`;
            const rate = feeRate(t);
            const tone = rate > 0.5 ? styles.heavy : Date.parse(t.at) < taxEnds ? styles.taxed : "";
            return (
              <tr key={key} className={fresh.has(key) ? styles.fresh : undefined} data-trade={key}>
                <td>
                  <a href={explorerTx(t.signature)} target="_blank" rel="noreferrer" className="num" title={new Date(t.at).toLocaleString()}>
                    {ago(now - Date.parse(t.at))}
                  </a>
                </td>
                <td className={t.side === "buy" ? styles.buy : styles.sell}>{t.side === "buy" ? "Buy" : "Sell"}</td>
                <td className={`num ${styles.right}`}>{solAmount(t.quoteAmount)}</td>
                <td className={`num ${styles.right} ${styles.wide}`}>{coinAmount(t.baseAmount, decimals)}</td>
                <td className={`num ${styles.right} ${tone}`}>
                  {(rate * 100).toFixed(2)}% <span className={styles.feeSol}>· {solAmount(t.fee)}</span>
                </td>
                <td className={`mono ${styles.wide}`}>{shortAddress(t.trader)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
