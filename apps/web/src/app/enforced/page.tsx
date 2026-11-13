import type { Metadata } from "next";
import { loadEnforcementCounts } from "@/lib/api";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How this is enforced" };

/**
 * "How this is enforced" (spec 9, screen 6): each promise, what keeps it, and who could still change it. This build
 * states how a confirmed creator bundle bars a creator, with the counts of bars, appeals and overturned findings (spec
 * 6.5), and what Heat cannot prevent in a coin priced in a stock (ADR 0007, Consequences); the page's other promises
 * come with #59.
 */
export default async function Enforced() {
  const counts = await loadEnforcementCounts();
  return (
    <div className="page">
      <main className={styles.page}>
        <header className="stack">
          <p className="eyebrow">Heat</p>
          <h1 className={styles.title}>How this is enforced</h1>
          <p className="muted">What keeps each of Heat&apos;s promises, and who could still change it.</p>
        </header>

        <section id="bars" className={`panel ${styles.section}`} aria-labelledby="bars-title">
          <h2 id="bars-title" className={styles.heading}>
            Bundling and Bars
          </h2>
          <p>
            Bundle Radar labels every coin&apos;s early buyers, with the evidence linked, and labels never move a coin. A case opens only when wallets directly
            linked to the Creator wallet bought 1% of supply or more; a person at Heat confirms it or dismisses it, and nothing is barred automatically.
          </p>
          <ul className={styles.list}>
            <li>
              <b>A confirmed creator bundle bars the creator at once.</b> Heat&apos;s launch key co-signs none of their launches, from their Creator record, its
              Creator wallet or its X account, and their Fair Opens not yet taking deposits are cancelled and refunded.
            </li>
            <li>
              <b>The finding is private for 72 hours</b>: the creator sees the evidence on their record and can reply. Then their record, the coin&apos;s page
              and its Fairness card show it.
            </li>
            <li>
              <b>One appeal within 30 days</b>, decided within 48 hours by someone other than the person who confirmed it; another only with new evidence. An
              upheld appeal lifts the Bar and takes the finding off every public page. Heat&apos;s audit log keeps every finding and decision, and nobody can
              edit it.
            </li>
            <li>
              <b>A Bar never expires and only stops new launches.</b> The creator&apos;s coins keep trading, their Creator Earnings keep flowing, their Creator
              lock keeps vesting, and they can still trade and deposit in other creators&apos; Fair Opens.
            </li>
          </ul>
          {counts ? (
            <dl className={styles.counts} data-testid="enforcement-counts">
              <div>
                <dt>Creators barred</dt>
                <dd className="num" data-testid="count-bars">
                  {counts.bars}
                </dd>
              </div>
              <div>
                <dt>Appeals filed</dt>
                <dd className="num" data-testid="count-appeals">
                  {counts.appeals}
                </dd>
              </div>
              <div>
                <dt>Findings overturned</dt>
                <dd className="num" data-testid="count-overturned">
                  {counts.overturned}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="note">The counts could not be read just now.</p>
          )}
          <p className="note">Counted once a finding is published or overturned; a finding still in its private 72 hours is in no count.</p>
        </section>

        <section id="quotes" className={`panel ${styles.section}`} aria-labelledby="quotes-title">
          <h2 id="quotes-title" className={styles.heading}>
            Coins priced in a stock
          </h2>
          <p>
            A coin can be priced in SOL or in a tokenized stock, an xStock, that Meteora&apos;s curves take as a quote. Each
            xStock&apos;s issuer keeps powers over every token of it, everywhere it sits, and Heat cannot prevent any of
            them. The coin&apos;s page, the launch form and the deposit page list the powers each quote&apos;s mint holds,
            read from the chain.
          </p>
          <ul className={styles.list}>
            <li>
              <b>The issuer can pause every transfer.</b> While a quote is paused, its coins&apos; curves and graduated
              pools take no trades, and a Fair Open in it can neither refund, push its coins nor pay its Tax Share out of
              its vault until the issuer resumes transfers. Heat refuses to schedule a launch in a paused quote, and a
              paused quote fails the open.
            </li>
            <li>
              <b>The issuer can move or burn tokens from any account.</b> A permanent delegate can take the quote out of
              any wallet, out of a curve&apos;s or a graduated pool&apos;s quote vault, and out of a Fair Open&apos;s vault,
              without anyone&apos;s signature.
            </li>
            <li>
              <b>The issuer can freeze accounts</b>, a wallet&apos;s or a vault&apos;s, which stops it sending or receiving
              the quote until thawed.
            </li>
            <li>
              <b>The issuer changes how balances read.</b> On a split or a dividend it sets a new Scaled UI Amount
              multiplier. Heat stores every amount as the chain does and shows every price, balance and market cap through
              the multiplier in force now, so a change rescales a chart as a whole and never breaks it.
            </li>
          </ul>
          <p className="muted">
            Heat never takes a quote that charges a transfer fee or whose issuer could add one, whose transfer hook names a
            program, or whose new accounts start frozen. A coin&apos;s Graduation Target is fixed in its quote when it
            launches, about 8.5 SOL&apos;s worth on devnet at the stock&apos;s price then.
          </p>
        </section>
      </main>
    </div>
  );
}
