import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How this is enforced" };

/**
 * "How this is enforced" (spec 9, screen 6): each promise, what keeps it, and who could still change it. This build
 * states what Heat cannot prevent in a coin priced in a stock (ADR 0007, Consequences); the page's other promises, with
 * the counts of bars, appeals and overturned findings, come with #59.
 */
export default function Enforced() {
  return (
    <div className="page">
      <main className={styles.page}>
        <header className="stack">
          <p className="eyebrow">Heat</p>
          <h1 className={styles.title}>How this is enforced</h1>
          <p className="muted">What keeps each of Heat&apos;s promises, and who could still change it.</p>
        </header>

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
