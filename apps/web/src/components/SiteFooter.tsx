import Link from "next/link";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <span>Heat, a fair-launch launchpad on Solana, built on Meteora.</span>
        <span className={styles.links}>
          <Link href="/status">Status</Link>
          <a href="https://github.com/imDev2023/top-pad" target="_blank" rel="noreferrer">
            Source
          </a>
        </span>
      </div>
    </footer>
  );
}
