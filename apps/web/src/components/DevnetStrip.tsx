import type { Cluster } from "@top-pad/contract";
import styles from "./DevnetStrip.module.css";

/** Above everything off mainnet: the coins here are tests, worth nothing. */
export function DevnetStrip({ cluster }: { cluster: Cluster }) {
  return (
    <div className={styles.strip}>
      <p className={styles.inner}>
        <b>{cluster === "devnet" ? "Devnet prototype" : "Local build"}</b>
        <span>Every coin here is a test coin on Solana {cluster}, with no value.</span>
      </p>
    </div>
  );
}
