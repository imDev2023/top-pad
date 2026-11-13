"use client";

import { useCallback, useEffect, useState } from "react";
import type { CreatorSummary, Me } from "@top-pad/contract";
import { ApiProblem, getCreatorRecord, getMe } from "@/lib/api";
import { WalletButton } from "../WalletButton";
import { useWallet } from "../WalletProvider";
import styles from "./Creator.module.css";
import { CreatorSummaryCard } from "./CreatorSummaryCard";
import { EarningsPanel } from "./EarningsPanel";
import { HandoverOffersPanel, RotationPanel } from "./WalletChanges";

/**
 * The creator's page (spec 9, screen 5): for the connected wallet, the Creator record it is the Creator wallet of, any
 * handover offered to it, the rotation of a lost Creator wallet to it through X, and the Creator Earnings it can claim,
 * which follow a coin's DBC creator role, so they are read for the wallet, whether or not it has a record.
 */
export function CreatorPage() {
  const { account, chain } = useWallet();
  const [record, setRecord] = useState<CreatorSummary | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState(0);
  const address = account?.address ?? null;

  const load = useCallback(async () => {
    setMe(await getMe().catch(() => null));
    if (!address) return setRecord(undefined);
    try {
      const found = await getCreatorRecord(address);
      // A wallet that was a record's Creator wallet once and is no longer has no record of its own here.
      setRecord(found.summary.wallet === address ? found.summary : null);
    } catch (e) {
      setRecord(e instanceof ApiProblem && e.status === 404 ? null : undefined);
    }
  }, [address]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const changed = () => setVersion((v) => v + 1);

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
        <>
          <HandoverOffersPanel key={`offers-${account.address}-${version}`} account={account} onTaken={changed} />
          {me && <RotationPanel key={`rotation-${account.address}`} account={account} me={me} onRequested={changed} />}
          {record && <CreatorSummaryCard summary={record} label="Your Creator record" />}
          <EarningsPanel key={account.address} account={account} chain={chain} onChanged={async () => changed()} />
        </>
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
