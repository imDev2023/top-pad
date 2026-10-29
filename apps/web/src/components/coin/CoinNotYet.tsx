"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "@/app/not-found.module.css";

/** How long a page looks for a coin before saying there is none: a coin is indexed seconds after it lands. */
const LOOK_MS = 30_000;
const EVERY_MS = 1_500;

/**
 * A coin address Heat has no coin at yet. One launched moments ago is still being indexed, so the page keeps looking
 * and shows the coin the moment it is there; only after half a minute does it say there is none. It looks by rendering
 * the page again on the server, which asks the API, so the browser never sees the API's 404 while it waits (and logs no
 * error for it); once the coin is there, the coin's page takes this one's place.
 */
export function CoinNotYet({ mint }: { mint: string }) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const look = setInterval(() => {
      if (Date.now() - started > LOOK_MS) {
        clearInterval(look);
        setGaveUp(true);
      } else {
        router.refresh();
      }
    }, EVERY_MS);
    return () => clearInterval(look);
  }, [mint, router]);

  if (gaveUp) {
    return (
      <section className={`panel ${styles.box}`} aria-labelledby="coin-missing-title">
        <span className="chip chip-caution flag">404</span>
        <h1 id="coin-missing-title">No coin at this address</h1>
        <p className="muted">Heat has no coin here. Check the address, or launch a coin of your own.</p>
        <div className="row">
          <Link href="/" className="btn">
            Home
          </Link>
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section className={`panel ${styles.box}`} aria-labelledby="coin-looking-title" role="status">
      <span className="chip chip-info flag">Looking</span>
      <h1 id="coin-looking-title">Looking for this coin</h1>
      <p className="muted">A coin launched moments ago appears here within seconds, and this page shows it as soon as it does.</p>
      <p className="mono note">{mint}</p>
    </section>
  );
}
