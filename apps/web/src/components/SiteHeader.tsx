import Link from "next/link";
import type { Cluster } from "@top-pad/contract";
import { Mark } from "./Mark";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";
import styles from "./SiteHeader.module.css";

/** Every page's head: the mark and name, then the light-or-dark toggle and the wallet. */
export function SiteHeader({ cluster }: { cluster: Cluster }) {
  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <Link href="/" className={styles.brand} aria-label="Heat, home">
          <Mark className={styles.mark} />
          <span className={styles.name}>Heat</span>
          {cluster !== "mainnet" && <span className={`chip chip-caution ${styles.cluster}`}>{cluster}</span>}
        </Link>
        <nav className={styles.nav} aria-label="Sections">
          <Link href="/launch" className={styles.link}>
            Launch a coin
          </Link>
        </nav>
        <div className={styles.actions}>
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
