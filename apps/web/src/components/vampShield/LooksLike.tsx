"use client";

// Vamp Shield's "looks like X" label (spec 6.2, 9): a coin launched close to a protected coin, a derivative or a near
// copy, carries a yellow flag on its rows and its page, so traders can tell the two apart. The page's flag opens why.
import type { LooksLike } from "@top-pad/contract";
import styles from "./LooksLike.module.css";

/**
 * One entry per protected coin as a trader names it, its reasons together: a coin near $BONK by ticker and by image says
 * both, even when two sources list Bonk under two ids.
 */
function byCoin(labels: LooksLike[]) {
  const grouped = new Map<string, { label: LooksLike; reasons: string[] }>();
  for (const l of labels) {
    const key = l.label.toLowerCase();
    const held = grouped.get(key);
    if (held) held.reasons.push(l.reason);
    else grouped.set(key, { label: l, reasons: [l.reason] });
  }
  return [...grouped.values()];
}

/** The flag on a coin row: the label alone. */
export function LooksLikeChip({ labels }: { labels: LooksLike[] }) {
  const first = byCoin(labels)[0];
  if (!first) return null;
  return (
    <span className={`chip chip-caution flag ${styles.chip}`} title={first.reasons.join(" ")} data-testid="looks-like-chip">
      {first.label.label}
    </span>
  );
}

/** The flag on a coin's page, which opens LooksLikePanel below the page's head. */
export function LooksLikeFlag({ labels, open, onToggle, controls }: { labels: LooksLike[]; open: boolean; onToggle: () => void; controls: string }) {
  const coins = byCoin(labels);
  if (coins.length === 0) return null;
  return (
    <button
      type="button"
      className={`chip chip-caution flag ${styles.chip} ${styles.toggle}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-testid="looks-like-flag"
    >
      {coins[0]!.label.label}
      {coins.length > 1 ? ` +${coins.length - 1}` : ""}
    </button>
  );
}

/** What a coin looks like and why, with a link to each protected coin. */
export function LooksLikePanel({ labels, open, id }: { labels: LooksLike[]; open: boolean; id: string }) {
  const coins = byCoin(labels);
  if (coins.length === 0) return null;
  return (
    <div id={id} hidden={!open} className={`verdict verdict-caution ${styles.panel}`} data-testid="looks-like-panel">
      <b>Vamp Shield: close to a protected coin, not that coin</b>
      <ul className={styles.list}>
        {coins.map(({ label, reasons }) => (
          <li key={label.label} className={styles.item}>
            <a className={styles.coin} href={label.coin.url} target="_blank" rel="noreferrer">
              {label.coin.imageUrl ? (
                <img src={label.coin.imageUrl} alt="" width={32} height={32} referrerPolicy="no-referrer" loading="lazy" />
              ) : (
                <span className={styles.initials} aria-hidden="true">
                  {(label.coin.ticker || label.coin.name).replace(/^\$/, "").slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className={styles.coinText}>
                <span>{label.coin.name}</span>
                <span className="note">{label.label}</span>
              </span>
            </a>
            <span className={styles.reasons}>{reasons.join(" ")}</span>
          </li>
        ))}
      </ul>
      <span className="note">Heat labels a launch this close to a protected coin rather than refusing it: derivatives are a genre of their own.</span>
    </div>
  );
}
