import Link from "next/link";
import styles from "./page.module.css";

/** Home, until the board of live Fair Opens and trending coins takes this place (spec 8). */
export default function Home() {
  return (
    <div className="page">
      <section className={`panel ${styles.hero}`} aria-labelledby="home-title">
        <span className="eyebrow">A fair-launch launchpad on Solana</span>
        <h1 id="home-title" className={styles.title}>
          Everyone starts together.
        </h1>
        <p className={styles.lead}>
          A coin on Heat opens to everyone at once. For its first minute every buy and sell pays a sniper tax that falls
          from 99% to 1.25%, and none of it goes to the coin&apos;s creator. Every launch carries its creator&apos;s X
          account.
        </p>
        <div className="row">
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </div>
      </section>

      <ul className={styles.facts}>
        <li className="panel pad">
          <span className="chip chip-caution flag">Sniper tax</span>
          <p>
            99% in the creation slot, falling each second to 1.25% at one minute. It lives in Meteora&apos;s settings for
            the coin, so it taxes every route the same.
          </p>
        </li>
        <li className="panel pad">
          <span className="chip chip-go flag">Creator record</span>
          <p>Each launch needs its creator&apos;s X account, and one Creator wallet signs all of that account&apos;s launches.</p>
        </li>
        <li className="panel pad">
          <span className="chip chip-stop flag">Vamp Shield</span>
          <p>A launch that copies a protected coin&apos;s ticker or name, even with lookalike letters, is refused before it exists.</p>
        </li>
      </ul>
    </div>
  );
}
