"use client";

import { WalletButton } from "../WalletButton";
import { useWallet } from "../WalletProvider";
import styles from "./Creator.module.css";
import { EarningsPanel } from "./EarningsPanel";

/**
 * The creator's page (spec 9, screen 5): Creator Earnings follow a coin's DBC creator role, which a wallet holds, so the
 * page reads them for the connected wallet, whether or not it has linked X.
 */
export function CreatorPage() {
  const { account, chain } = useWallet();
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <p className="eyebrow">Your creator page</p>
        <h1>Creator Earnings</h1>
        <p className={styles.lead}>
          Half of every trading fee on each coin whose creator role your wallet holds, from the moment its sniper tax ends.
          It waits in Meteora&apos;s pool, never with Heat, until you claim it.
        </p>
      </header>
      {account ? (
        <EarningsPanel key={account.address} account={account} chain={chain} />
      ) : (
        <section className={`panel ${styles.connect}`} aria-labelledby="connect-title">
          <h2 id="connect-title" className={styles.connectTitle}>
            Connect your wallet
          </h2>
          <p className="muted">Connect the wallet that holds your coins&apos; creator role to see what waits for it.</p>
          <WalletButton variant="inline" />
        </section>
      )}
    </div>
  );
}
