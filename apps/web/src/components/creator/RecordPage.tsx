"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { CreatorEarnings, CreatorRecord, RecordCoin, RecordWallet, WalletChange } from "@top-pad/contract";
import { ApiProblem, getCreatorRecord, getEarnings } from "@/lib/api";
import { coinAmount, dayOf, momentOf, quoteText, shortAddress } from "@/lib/format";
import { useWallet } from "../WalletProvider";
import { LooksLikeChip } from "../vampShield/LooksLike";
import { CreatorMarks, creatorName, graduationText } from "./CreatorSummaryCard";
import { earned, EarningsPanel, QuoteAmounts } from "./EarningsPanel";
import styles from "./Record.module.css";
import { CancelChange, HandoverForm } from "./WalletChanges";

/**
 * A Creator record (spec 7; spec 9, screen 5): only facts anyone can recompute from the chain and Heat's database, with
 * no composite score. The coins it launched stay on it whoever holds their creator role; Creator Earnings follow the
 * role. Its Creator wallet changes by a handover both wallets sign, or by a rotation through X after a public cooldown.
 */
export function RecordPage({ initial }: { initial: CreatorRecord }) {
  const [record, setRecord] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const { account, chain } = useWallet();
  const reload = useCallback(async () => {
    try {
      setRecord(await getCreatorRecord(initial.summary.id));
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : (e as Error).message);
    }
  }, [initial.summary.id]);

  const { summary } = record;
  const name = creatorName(summary);
  const current = summary.wallet;
  const own = !!account && account.address === current;
  const pending = record.changes.find((c) => c.status === "pending") ?? null;
  const sells = record.coins.reduce((n, c) => n + c.sells.count, 0);
  const soldIn = record.coins.filter((c) => c.sells.count > 0).length;

  return (
    <div className={styles.page}>
      <header className={`panel ${styles.head}`}>
        <div className={styles.who}>
          {summary.x?.avatarUrl ? (
            <img src={summary.x.avatarUrl} alt="" width={56} height={56} className={styles.avatar} />
          ) : (
            <span className={styles.monogram} aria-hidden="true">
              {name.replace("@", "").slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className={styles.title}>
            <p className="eyebrow">Creator record</p>
            <h1 className={summary.x ? undefined : "mono"} data-testid="record-name">
              {name}
            </h1>
            <div className="row">
              <CreatorMarks summary={summary} />
              {summary.x && (
                <a href={`https://x.com/${summary.x.handle}`} target="_blank" rel="noreferrer" className="chip chip-info">
                  On X
                </a>
              )}
              <span className="note">Since {dayOf(summary.since)}</span>
            </div>
          </div>
        </div>
        <div className={styles.current}>
          <span className="eyebrow">Creator wallet</span>
          {current ? (
            <span className="mono" data-testid="record-wallet" title={current}>
              {shortAddress(current)}
            </span>
          ) : (
            <span className="muted">None yet</span>
          )}
          <span className="note">The only wallet that signs this record&apos;s launches.</span>
        </div>
      </header>

      {problem && (
        <div className="verdict verdict-stop" role="alert">
          <b>The record could not be read again</b>
          <span className="note">{problem}</span>
        </div>
      )}

      {pending && <PendingChange change={pending} current={current} onChanged={reload} />}

      <section className={`panel ${styles.facts}`} aria-labelledby="facts-title">
        <h2 id="facts-title" className="visually-hidden">
          The record&apos;s facts
        </h2>
        <dl className={styles.factGrid}>
          <div data-testid="fact-launches">
            <dt>Launches</dt>
            <dd className="num">
              <span className={styles.nowrap}>{record.launches.instant} Instant</span> ·{" "}
              <span className={styles.nowrap}>
                {record.launches.fairOpen.opened} Fair Open{record.launches.fairOpen.opened === 1 ? "" : "s"}
              </span>
            </dd>
            <dd className="note">
              {record.launches.fairOpen.failed} Fair Open{record.launches.fairOpen.failed === 1 ? "" : "s"} failed, {record.launches.fairOpen.scheduled} scheduled
            </dd>
          </div>
          <div data-testid="fact-graduations">
            <dt>Graduated</dt>
            <dd className="num">{graduationText(summary)}</dd>
          </div>
          <div data-testid="fact-handed-over">
            <dt>Coins handed over</dt>
            <dd className="num">{summary.handedOver}</dd>
          </div>
          <div data-testid="fact-quiet">
            <dt>Never graduated, went quiet</dt>
            <dd className="num">{summary.quiet}</dd>
            <dd className="note">No trade for 7 days</dd>
          </div>
          <div data-testid="fact-sells">
            <dt>Sells from the Creator wallet</dt>
            <dd className="num">{sells}</dd>
            <dd className="note">{sells ? `in ${soldIn} coin${soldIn === 1 ? "" : "s"}` : "None of its own coins"}</dd>
          </div>
          <div data-testid="fact-claimed">
            <dt>Creator Earnings claimed</dt>
            <dd className="num">
              <QuoteAmounts amounts={paidFigures(record.earnings).map((e) => ({ raw: e.claimed, quote: e.quote }))} />
            </dd>
            {paidFigures(record.earnings).map((e) => (
              <dd key={e.quote.mint} className="note">
                {earned(e.curve, e.quote)} curve, {earned(e.lp, e.quote)} LP fees
              </dd>
            ))}
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="earnings-title">
        <div className={styles.sectionHead}>
          <h2 id="earnings-title">Creator Earnings</h2>
          <p className="note">Half of every trading fee after the sniper tax, and a graduated coin&apos;s LP fees, waiting for whoever holds each coin&apos;s creator role.</p>
        </div>
        {own && account ? (
          <EarningsPanel key={account.address} account={account} chain={chain} onChanged={reload} />
        ) : current ? (
          <PublicEarnings wallet={current} claimed={record.earnings} />
        ) : (
          <p className="note">This record has no Creator wallet yet.</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="coins-title">
        <div className={styles.sectionHead}>
          <h2 id="coins-title">Coins launched</h2>
          <p className="note">Each stays on this record whoever holds its creator role now.</p>
        </div>
        {record.coins.length === 0 ? (
          <p className={`panel ${styles.empty}`}>No coin launched yet.</p>
        ) : (
          <ul className={`panel ${styles.coinList}`}>
            {record.coins.map((coin) => (
              <CoinRow key={coin.mint} coin={coin} />
            ))}
          </ul>
        )}
      </section>

      {record.received.length > 0 && (
        <section className={styles.section} aria-labelledby="received-title">
          <div className={styles.sectionHead}>
            <h2 id="received-title">Coins handed over to this record</h2>
            <p className="note">Launched by another record, which keeps them; their creator role, and its earnings, are this record&apos;s wallet&apos;s now.</p>
          </div>
          <ul className={`panel ${styles.coinList}`}>
            {record.received.map((coin) => (
              <li key={coin.mint} className={styles.coin} data-testid="received-coin">
                <CoinIdentity mint={coin.mint} name={coin.name} ticker={coin.ticker} imageUri={coin.imageUri} />
                <p className={styles.coinFacts}>
                  Handed over by{" "}
                  {coin.launcher ? (
                    <Link href={`/creator/${coin.launcher.id}`}>{coin.launcher.handle ? `@${coin.launcher.handle}` : shortAddress(coin.launcher.wallet ?? coin.holder)}</Link>
                  ) : (
                    "its launcher"
                  )}{" "}
                  to <span className="mono">{shortAddress(coin.holder)}</span> on{" "}
                  <a href={coin.explorer} target="_blank" rel="noreferrer">
                    {dayOf(coin.at)}
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-labelledby="wallets-title">
        <div className={styles.sectionHead}>
          <h2 id="wallets-title">Creator wallet history</h2>
          <p className="note">Every wallet with the signature that proves it. Expand one to check the message it signed.</p>
        </div>
        <ol className={`panel ${styles.history}`}>
          {[...record.wallets].reverse().map((w) => (
            <WalletRow key={`${w.wallet}-${w.from}`} wallet={w} change={record.changes.find((c) => c.id === w.change) ?? null} />
          ))}
        </ol>
        {record.changes.some((c) => c.status !== "completed" && c.status !== "pending") && (
          <ul className={`panel ${styles.history}`} aria-label="Changes that did not happen">
            {record.changes
              .filter((c) => c.status !== "completed" && c.status !== "pending")
              .map((c) => (
                <li key={c.id} className={styles.historyItem} data-testid="ended-change">
                  <div className={styles.historyLine}>
                    <span className="chip chip-neutral">{c.status === "cancelled" ? "Cancelled" : c.status === "expired" ? "Lapsed" : "Void"}</span>
                    <span>
                      {c.kind === "rotation" ? "Rotation through X" : "Handover"} to <span className="mono">{shortAddress(c.to)}</span>
                    </span>
                    <span className="note">
                      asked {dayOf(c.requestedAt)}
                      {c.endedAt ? `, ended ${dayOf(c.endedAt)}` : ""}
                    </span>
                  </div>
                  <SignedDetails change={c} />
                </li>
              ))}
          </ul>
        )}
      </section>

      {own && account && current && !pending && (
        <section className={styles.section} aria-labelledby="handover-title">
          <div className={styles.sectionHead}>
            <h2 id="handover-title">Hand over your Creator wallet</h2>
            <p className="note">
              The new wallet becomes this record&apos;s only launch signer once it signs the same message. Your coins stay on the record; their creator roles stay
              with the wallets holding them.
            </p>
          </div>
          <HandoverForm account={account} onOffered={reload} />
        </section>
      )}
    </div>
  );
}

/** A pending handover or rotation, in public, with the current Creator wallet's cancel. */
function PendingChange({ change, current, onChanged }: { change: WalletChange; current: string | null; onChanged: () => Promise<void> }) {
  const { account } = useWallet();
  const rotation = change.kind === "rotation";
  return (
    <section className={`verdict verdict-caution ${styles.pending}`} aria-label="A pending change of Creator wallet" data-testid="pending-change">
      <b>
        {rotation
          ? `A rotation through X to ${shortAddress(change.to)} takes effect on ${momentOf(change.effectiveAt!)}`
          : `A handover to ${shortAddress(change.to)} waits for that wallet's signature until ${momentOf(change.expiresAt!)}`}
      </b>
      <span className="note">
        {rotation
          ? `Asked through @${change.xHandle} on ${momentOf(change.requestedAt)}, for a lost Creator wallet. Until then ${shortAddress(change.from)} stays the Creator wallet and can cancel it.`
          : `Offered by ${shortAddress(change.from)} on ${momentOf(change.requestedAt)}. The new wallet takes it by signing the same message on its creator page.`}
      </span>
      <SignedDetails change={change} />
      {account && current && account.address === current && <CancelChange account={account} change={change} onCancelled={onChanged} />}
    </section>
  );
}

/** The message a change's wallets signed and their signatures, for anyone to check. */
function SignedDetails({ change }: { change: WalletChange }) {
  const signatures = [
    change.fromSignature && { who: change.from, label: "Old wallet's signature", signature: change.fromSignature },
    change.toSignature && { who: change.to, label: "New wallet's signature", signature: change.toSignature },
  ].filter((s): s is { who: string; label: string; signature: string } => !!s);
  return (
    <details className={styles.details}>
      <summary>The signed message</summary>
      <pre className={styles.message}>{change.message}</pre>
      <dl className={styles.signatures}>
        {signatures.map((s) => (
          <div key={s.label}>
            <dt>
              {s.label} ({shortAddress(s.who)})
            </dt>
            <dd className="mono">{s.signature}</dd>
          </div>
        ))}
        {change.cancelSignature && (
          <div>
            <dt>Cancelled by the Creator wallet&apos;s signature over</dt>
            <dd>
              <pre className={styles.message}>{change.cancelMessage}</pre>
              <span className="mono">{change.cancelSignature}</span>
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

const VIA: Record<RecordWallet["via"], string> = {
  sign_in: "Signed in",
  first_launch: "Signed its first launch",
  handover: "Handed over",
  rotation: "Rotated through X",
};

function WalletRow({ wallet, change }: { wallet: RecordWallet; change: WalletChange | null }) {
  return (
    <li className={styles.historyItem} data-testid="record-wallet-row">
      <div className={styles.historyLine}>
        <span className={wallet.until ? "chip chip-neutral" : "chip chip-go"}>{wallet.until ? "Past" : "Current"}</span>
        <a href={wallet.explorer} target="_blank" rel="noreferrer" className="mono" title={wallet.wallet}>
          {shortAddress(wallet.wallet)}
        </a>
        <span>{VIA[wallet.via]}</span>
        <span className="note">
          {dayOf(wallet.from)}
          {wallet.until ? ` to ${dayOf(wallet.until)}` : " to now"}
        </span>
      </div>
      {change ? (
        <SignedDetails change={change} />
      ) : wallet.proof.message ? (
        <details className={styles.details}>
          <summary>The signed message</summary>
          <pre className={styles.message}>{wallet.proof.message}</pre>
          <p className="mono note">{wallet.proof.signature}</p>
        </details>
      ) : wallet.proof.explorer ? (
        <a href={wallet.proof.explorer} target="_blank" rel="noreferrer" className="note">
          The launch it signed
        </a>
      ) : null}
    </li>
  );
}

function CoinIdentity({ mint, name, ticker, imageUri }: { mint: string; name: string; ticker: string; imageUri: string | null }) {
  return (
    <Link href={`/coin/${mint}`} className={styles.identity}>
      {imageUri ? (
        <img src={imageUri} alt="" width={40} height={40} className={styles.image} />
      ) : (
        <span className={styles.coinMonogram} aria-hidden="true">
          {ticker.slice(0, 1)}
        </span>
      )}
      <span className={styles.names}>
        <b>{name}</b>
        <span className="mono muted">{ticker}</span>
      </span>
    </Link>
  );
}

function CoinRow({ coin }: { coin: RecordCoin }) {
  const lock = coin.lock;
  return (
    <li className={styles.coin} data-testid="record-coin">
      <div className={styles.coinHead}>
        <CoinIdentity mint={coin.mint} name={coin.name} ticker={coin.ticker} imageUri={coin.imageUri} />
        <div className={styles.coinChips}>
          <span className="chip chip-neutral">{coin.launchMode === "fair_open" ? "Fair Open" : "Instant launch"}</span>
          {coin.state === "graduated" ? (
            <span className="chip chip-neutral">
              <i className={`checkered ${styles.checker}`} aria-hidden="true" />
              Graduated
            </span>
          ) : coin.state === "quiet" ? (
            <span className="chip chip-caution">Went quiet</span>
          ) : (
            <span className="chip chip-info">Trading</span>
          )}
          <LooksLikeChip labels={coin.looksLike} />
        </div>
      </div>
      <dl className={styles.coinFactsGrid}>
        <div>
          <dt>Launched</dt>
          <dd>{dayOf(coin.launchedAt)}</dd>
        </div>
        <div>
          <dt>Creator lock</dt>
          <dd>
            {!lock
              ? "None in an Instant launch"
              : lock.status === "locked"
                ? lock.coins && BigInt(lock.coins) > 0n
                  ? `${coinAmount(lock.coins)} ${coin.ticker} until ${lock.cliffAt ? dayOf(lock.cliffAt) : "its cliff"}`
                  : "Nothing locked"
                : lock.status === "pending"
                  ? "Locks right after the open"
                  : "The creator bought nothing"}
          </dd>
        </div>
        <div>
          <dt>Creator wallet sells</dt>
          <dd data-testid="coin-sells">
            {coin.sells.count === 0 ? "None" : `${coin.sells.count} · ${coinAmount(coin.sells.coins)} ${coin.ticker} for ${quoteText(coin.sells.quote, coin.quote)}`}
          </dd>
        </div>
        <div>
          <dt>Bundle Radar</dt>
          <dd className={styles.radar}>
            {coin.radar.linked > 0 && <span className="chip chip-stop flag">{coin.radar.linked} linked to the creator</span>}
            {coin.radar.labelled > 0 && <span className="chip chip-caution flag">{coin.radar.labelled} same-slot</span>}
            {coin.radar.linked === 0 && coin.radar.labelled === 0 && <span className="chip chip-go flag">Nothing labelled</span>}
            <Link href={`/coin/${coin.mint}#radar`} className="note">
              Evidence
            </Link>
          </dd>
        </div>
      </dl>
      {coin.role.handedOver ? (
        <p className={styles.handedOver} data-testid="handed-over">
          Creator role handed over to{" "}
          {coin.role.record ? (
            <Link href={`/creator/${coin.role.record.id}`}>{coin.role.record.handle ? `@${coin.role.record.handle}` : shortAddress(coin.role.holder)}</Link>
          ) : (
            <span className="mono">{shortAddress(coin.role.holder)}</span>
          )}
          {coin.role.at && (
            <>
              {" "}
              on{" "}
              <a href={coin.role.explorer!} target="_blank" rel="noreferrer">
                {dayOf(coin.role.at)}
              </a>
            </>
          )}
          . Its Creator Earnings go to that wallet now.
        </p>
      ) : coin.role.at ? (
        <p className="note">
          Creator role moved to this record&apos;s wallet <span className="mono">{shortAddress(coin.role.holder)}</span> on {dayOf(coin.role.at)}.
        </p>
      ) : null}
    </li>
  );
}

/** What claims paid in each quote a claim paid in, or SOL's nothing when none has. */
const paidFigures = (earnings: CreatorRecord["earnings"]) => {
  const paid = earnings.filter((e) => BigInt(e.claimed) > 0n);
  return paid.length ? paid : earnings.slice(0, 1);
};

/** What waits for the record's Creator wallet in each quote, read from the chain, beside what its claims paid. */
function PublicEarnings({ wallet, claimed }: { wallet: string; claimed: CreatorRecord["earnings"] }) {
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    getEarnings(wallet)
      .then(setEarnings)
      .catch((e) => setProblem(e instanceof ApiProblem ? e.message : (e as Error).message));
  }, [wallet]);
  const owed = earnings?.quotes.filter((q) => BigInt(q.waiting) > 0n) ?? [];
  return (
    <div className={`panel ${styles.publicEarnings}`}>
      <dl className={styles.earningsFigures}>
        <div>
          <dt className="eyebrow">Waiting for the Creator wallet</dt>
          <dd className="num" data-testid="record-waiting">
            {earnings ? (
              <QuoteAmounts amounts={(owed.length ? owed : earnings.quotes.slice(0, 1)).map((q) => ({ raw: q.waiting, quote: q.quote }))} />
            ) : problem ? (
              "Not read"
            ) : (
              "Reading…"
            )}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Claimed so far</dt>
          <dd className="num">
            <QuoteAmounts amounts={paidFigures(claimed).map((e) => ({ raw: e.claimed, quote: e.quote }))} />
          </dd>
        </div>
      </dl>
      <p className="note">{problem ?? "Only the wallet holding each coin's creator role can claim; connect the Creator wallet to claim here."}</p>
    </div>
  );
}
