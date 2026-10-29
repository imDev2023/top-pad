import styles from "./Launch.module.css";

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
