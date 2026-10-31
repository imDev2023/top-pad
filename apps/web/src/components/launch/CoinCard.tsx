import { sol } from "@/lib/format";
import styles from "./Launch.module.css";
import { when } from "./Schedule";

/** A coin as traders will see it on its row: its picture, ticker and name, and the facts that travel with it. */
export function CoinCard({
  ticker,
  name,
  imageUrl,
  handle,
  mode,
}: {
  ticker: string;
  name: string;
  imageUrl: string | null;
  handle: string | null;
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
          {handle && <span className="chip chip-info">@{handle}</span>}
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
  handle,
  teaser,
  opensAt,
  minRaise,
  potCap,
}: {
  handle: string | null;
  teaser: string;
  /** When the coin opens, in milliseconds, once a valid window is set. */
  opensAt: number | null;
  minRaise: bigint;
  potCap: string | null;
}) {
  return (
    <div className={`${styles.coinCard} ${styles.sealedCard}`}>
      <span className={styles.sealed} aria-hidden="true">
        ?
      </span>
      <div className={styles.coinText}>
        <b className={teaser ? styles.teaser : `${styles.teaser} ${styles.teaserEmpty}`}>{teaser || "Your one-line teaser"}</b>
        <span className="note">
          {opensAt ? `Opens ${when(opensAt)}. ` : ""}The name, ticker and image stay sealed until the open.
        </span>
        <span className="row">
          <span className="chip chip-neutral">10-minute window</span>
          {potCap && <span className="chip chip-neutral">pot up to {sol(potCap, 2)} SOL</span>}
          {minRaise > 0n && <span className="chip chip-neutral">min {sol(minRaise, 2)} SOL</span>}
          {handle && <span className="chip chip-info">@{handle}</span>}
        </span>
      </div>
    </div>
  );
}
