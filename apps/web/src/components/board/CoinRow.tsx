"use client";

import Link from "next/link";
import { useState } from "react";
import type { BoardCoin } from "@top-pad/contract";
import { ago, compactNumber, scaledFigure, shareOf, shortAddress } from "@/lib/format";
import styles from "./Board.module.css";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A coin's picture, or its initials when it has none or it fails to load. */
export function CoinImage({ coin }: { coin: Pick<BoardCoin, "imageUri" | "ticker" | "name"> }) {
  const [failed, setFailed] = useState(false);
  if (coin.imageUri && !failed) {
    return <img src={coin.imageUri} alt="" width={44} height={44} className={styles.thumb} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return (
    <span className={`${styles.thumb} ${styles.initials}`} aria-hidden="true">
      {(coin.ticker || coin.name).slice(0, 2).toUpperCase()}
    </span>
  );
}

/**
 * A coin row's flags (spec 8, 9): Bundle Radar's red and yellow flags, Vamp Shield's "looks like" labels and a published
 * confirmed creator bundle. Labels only mark; only the confirmed bundle has moved the coin, out of Trending.
 */
export function CoinFlags({ coin }: { coin: BoardCoin }) {
  const { flags } = coin;
  const chips = [];
  if (flags.confirmedBundle) {
    chips.push(
      <span key="bundle" className="chip chip-stop flag" data-testid="flag-confirmed" title="An operator confirmed a creator bundle in this coin.">
        Confirmed creator bundle
      </span>,
    );
  }
  if (flags.linked.wallets > 0) {
    chips.push(
      <span key="linked" className="chip chip-stop flag" data-testid="flag-linked" title="Wallets Bundle Radar links directly to the Creator wallet, and what they bought.">
        {plural(flags.linked.wallets, "wallet", "wallets")} linked · {shareOf(flags.linked.coins, coin.supply)}
      </span>,
    );
  }
  if (flags.earlyBuys > 0) {
    chips.push(
      <span key="early" className="chip chip-caution flag" data-testid="flag-early" title="Buys in the creation slot by wallets Bundle Radar does not link to the creator: timing alone.">
        {plural(flags.earlyBuys, "same-slot buy", "same-slot buys")}
      </span>,
    );
  }
  for (const label of flags.looksLike) {
    chips.push(
      <span key={`${label.field}-${label.coin.mint}`} className="chip chip-caution flag" title={label.reason}>
        {label.label}
      </span>,
    );
  }
  if (!chips.length) return null;
  return <span className={styles.flags}>{chips}</span>;
}

/** One coin on the board or in search: its picture, name, flags, and its market cap and way to Graduation. */
export function CoinRow({ coin, rank, now, show = "listed" }: { coin: BoardCoin; rank?: number; now: number; show?: "listed" | "graduated" | "trending" }) {
  const cap = scaledFigure(coin.marketCap, coin.quote);
  const progress = coin.graduatedAt ? 1 : Math.min(1, Number(BigInt(coin.quoteReserve)) / Math.max(1, Number(BigInt(coin.graduationTarget))));
  const when = show === "graduated" && coin.graduatedAt ? coin.graduatedAt : coin.listedAt;
  const creator = coin.creator.handle ? `@${coin.creator.handle}` : shortAddress(coin.creator.wallet);
  return (
    <li className={styles.coinRow} data-testid="coin-row" data-mint={coin.mint}>
      <Link href={`/coin/${coin.mint}`} className={styles.coinLink} aria-label={`${coin.name}, $${coin.ticker}`} />
      {rank !== undefined && (
        <span className={styles.rank} aria-hidden="true">
          {rank}
        </span>
      )}
      <CoinImage coin={coin} />
      <div className={styles.coinMain}>
        <div className={styles.coinName}>
          <b>{coin.name}</b>
          <span className={styles.ticker}>${coin.ticker}</span>
        </div>
        <div className={styles.coinMeta}>
          <span>{coin.launchMode === "fair_open" ? "Fair Open" : "Instant"}</span>
          <span aria-hidden="true">·</span>
          <span className={coin.creator.handle ? undefined : "mono"}>{creator}</span>
          <span aria-hidden="true">·</span>
          <span className="num" title={when}>
            {show === "graduated" ? `graduated ${ago(now - Date.parse(when))} ago` : ago(now - Date.parse(when))}
          </span>
        </div>
        <CoinFlags coin={coin} />
      </div>
      <div className={styles.coinFigures}>
        {show === "trending" && coin.trending && (
          <span className={styles.buyers} title="Unique net buyers in the last hour, none of them the creator's wallets or known bots" data-testid="buyers">
            <b className="num">{coin.trending.buyers}</b> {coin.trending.buyers === 1 ? "buyer" : "buyers"}
          </span>
        )}
        <span className={styles.cap}>
          <span className="num">{compactNumber(cap, 4)}</span> <span className={styles.unit}>{coin.quote.symbol}</span>
        </span>
        {coin.graduatedAt ? (
          <span className={`checkered ${styles.checkered}`} title="Graduated: its liquidity is locked in a Meteora pool forever" aria-label="Graduated" />
        ) : (
          <span className={styles.progress} title={`${Math.floor(progress * 100)}% of the way to Graduation`} aria-label={`${Math.floor(progress * 100)}% to Graduation`}>
            <span style={{ width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%` }} />
          </span>
        )}
      </div>
    </li>
  );
}
