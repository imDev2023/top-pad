import Link from "next/link";
import styles from "./not-found.module.css";

/** An address with nothing behind it, in the site's own frame rather than the framework's. */
export default function NotFound() {
  return (
    <div className="page">
      <section className={`panel ${styles.box}`} aria-labelledby="not-found-title">
        <span className="chip chip-caution flag">404</span>
        <h1 id="not-found-title">Nothing at this address</h1>
        <p className="muted">The page may have moved, or the address has a typo.</p>
        <div className="row">
          <Link href="/" className="btn">
            Home
          </Link>
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </div>
      </section>
    </div>
  );
}
