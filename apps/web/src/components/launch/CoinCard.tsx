import { quoteText, shortAddress, type QuoteUnit } from "@/lib/format";
import styles from "./Launch.module.css";
import { when } from "./Schedule";

/** Who made a coin, as its card names them: their linked X handle, else their Creator wallet (ADR 0008). */
export type CardCreator = { handle: string | null; wallet: string | null };

function CreatorChip({ creator }: { creator: CardCreator }) {
  if (creator.handle) return <span className="chip chip-info">@{creator.handle}</span>;
  if (creator.wallet) return <span className="chip chip-info mono">{shortAddress(creator.wallet)}</span>;
  return null;
}

/** A coin as traders will see it on its row: its picture, ticker and name, and the facts that travel with it. */
export function CoinCard({
  ticker,
  name,
  imageUrl,
  creator,
  mode,
}: {
  ticker: string;
  name: string;
  imageUrl: string | null;
  creator: CardCreator;
  mode: "instant" | "fairOpen";
}) {
  const initials = (ticker || name || "?").slice(0, 2).toUpperCase();
  return (
    <div className={styles.coinCard}>
      {imageUrl ? (
        <img src={imageUrl} alt="" className={styles.coinImage} width={48} height={48} />
      ) : (
        <span className={styles.coinInitials} aria-hidden="true">
          {initials}
        </span>
      )}
      <div className={styles.coinText}>
        <b className={styles.coinTicker}>{ticker ? `$${ticker}` : "$TICKER"}</b>
        <span className={styles.coinName}>{name || "Your coin's name"}</span>
        <span className="row">
          <span className="chip chip-neutral">{mode === "instant" ? "Instant launch" : "Fair Open"}</span>
          <CreatorChip creator={creator} />
        </span>
      </div>
    </div>
  );
}

/**
 * A Fair Open on the launch calendar before its open (spec 2.1 step 8): sealed, so only the "?" tile, the teaser, the
 * time, the creator and the terms show.
 */
export function SealedCard({
  creator,
  teaser,
  opensAt,
  minRaise,
  potCap,
  quote,
  scheduled = false,
}: {
  creator: CardCreator;
  teaser: string;
  /** Once scheduled, a launch with no teaser shows none rather than the placeholder that invites one. */
  scheduled?: boolean;
  /** When the coin opens, in milliseconds, once a valid window is set. */
  opensAt: number | null;
  minRaise: bigint;
  potCap: string | null;
  /** The quote the pot fills in, which its cap and minimum raise read in. */
  quote: QuoteUnit;
}) {
  return (
    <div className={`${styles.coinCard} ${styles.sealedCard}`}>
      <span className={styles.sealed} aria-hidden="true">
        ?
      </span>
      <div className={styles.coinText}>
        {(teaser || !scheduled) && <b className={teaser ? styles.teaser : `${styles.teaser} ${styles.teaserEmpty}`}>{teaser || "Your one-line teaser"}</b>}
        <span className="note">
          {opensAt ? `Opens ${when(opensAt)}. ` : ""}The name, ticker and image stay sealed until the open.
        </span>
        <span className="row">
          <span className="chip chip-neutral">10-minute window</span>
          {potCap && <span className="chip chip-neutral">pot up to {quoteText(potCap, quote, 2)}</span>}
          {minRaise > 0n && <span className="chip chip-neutral">min {quoteText(minRaise, quote, 2)}</span>}
          <CreatorChip creator={creator} />
        </span>
      </div>
    </div>
  );
}
