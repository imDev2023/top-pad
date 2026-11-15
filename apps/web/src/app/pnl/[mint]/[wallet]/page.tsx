import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadPosition } from "@/lib/api";
import { coinAmount, momentOf, pnlPercentText, pnlText, shortAddress } from "@/lib/format";
import styles from "./page.module.css";

type Props = { params: Promise<{ mint: string; wallet: string }>; searchParams: Promise<{ at?: string | string[] }> };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ORDER_KEY = /^\d{1,30}$/;
const positionAt = cache(loadPosition);

async function asked({ params, searchParams }: Props) {
  const [{ mint, wallet }, { at }] = await Promise.all([params, searchParams]);
  const snapshot = typeof at === "string" && ORDER_KEY.test(at) ? at : null;
  return { mint, wallet, at: snapshot, valid: ADDRESS.test(mint) && ADDRESS.test(wallet) };
}

/** What the card says, in words: "+0.012 SOL (+12.5%) on $PIGEON". */
const headline = (p: Exclude<Awaited<ReturnType<typeof loadPosition>>, string>) =>
  `${pnlText(p.pnl, p.quote, { signed: true })}${p.pnlPercent === null ? "" : ` (${pnlPercentText(p.pnlPercent)})`} on $${p.ticker}`;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const q = await asked(props);
  if (!q.valid) return { title: "Nothing at this address" };
  const p = await positionAt(q.mint, q.wallet, q.at);
  if (typeof p !== "object") return { title: "P&L card" };
  // The card's image is the page's link card on X, as the Fairness card is the coin page's (spec 9).
  const title = `P&L card: ${headline(p)}`;
  const description = `Wallet ${shortAddress(p.wallet)}'s position in ${p.name} ($${p.ticker}) on Heat, as of ${momentOf(p.asOf)}, worked out from its trades on chain.`;
  const image = { url: p.card, width: 1200, height: 600, alt: title };
  return {
    title,
    description,
    openGraph: { type: "website", title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/**
 * A shared P&L card (spec 9): one wallet's position in one Heat coin as of a snapshot, which never changes, with the
 * figures it is worked out from and the way to the coin. A link without a snapshot shows the newest.
 */
export default async function Page(props: Props) {
  const q = await asked(props);
  if (!q.valid) notFound();
  const p = await positionAt(q.mint, q.wallet, q.at);
  if (p === "missing") notFound();
  if (p === "unavailable") {
    return (
      <div className="page">
        <div className="verdict verdict-stop" role="alert">
          <b>Heat&apos;s API did not answer</b>
          <span className="note">The P&amp;L card could not be loaded just now. Reload the page in a moment.</span>
        </div>
      </div>
    );
  }
  const tone = p.pnl.startsWith("-") ? styles.loss : p.pnl === "0" ? "" : styles.gain;
  return (
    <div className="page">
      <main className={styles.page} data-testid="pnl-page">
        <header className="stack">
          <p className="eyebrow">P&amp;L card</p>
          <h1 className={styles.title}>
            {p.name} <span className={styles.ticker}>${p.ticker}</span>
          </h1>
          <p className="muted">
            Wallet <span className="mono">{shortAddress(p.wallet)}</span>, as of {momentOf(p.asOf)}
            {p.latest ? "" : ", a snapshot that stays as it was"}.
          </p>
        </header>
        <img className={styles.image} src={p.card} width={1200} height={600} alt={`P&L card: ${headline(p)}`} data-testid="pnl-image" />
        <section className={`panel ${styles.figures}`} aria-label="How it adds up">
          <div>
            <span className="eyebrow">Profit and loss</span>
            <span className={`num ${styles.big} ${tone}`} data-testid="pnl-figure">
              {pnlText(p.pnl, p.quote, { signed: true })}
              {p.pnlPercent !== null && <span className={styles.percent}> {pnlPercentText(p.pnlPercent)}</span>}
            </span>
          </div>
          <dl className={styles.list}>
            <div>
              <dt>Spent</dt>
              <dd className="num">{pnlText(p.spent, p.quote)}</dd>
              <dd className="note">
                for {coinAmount(p.bought, p.decimals)} {p.ticker}, fees included
              </dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd className="num">{pnlText(p.received, p.quote)}</dd>
              <dd className="note">
                for {coinAmount(p.sold, p.decimals)} {p.ticker}, after fees
              </dd>
            </div>
            {BigInt(p.taxShare) > 0n && (
              <div>
                <dt>Tax Share</dt>
                <dd className="num">{pnlText(p.taxShare, p.quote)}</dd>
                <dd className="note">paid to the wallet&apos;s Fair Open seat</dd>
              </div>
            )}
            <div>
              <dt>Holding</dt>
              <dd className="num">
                {coinAmount(p.held, p.decimals)} {p.ticker}
              </dd>
              <dd className="note">worth {pnlText(p.value, p.quote)} at the last trade</dd>
            </div>
            <div>
              <dt>Fees paid</dt>
              <dd className="num">{pnlText(p.fees, p.quote)}</dd>
              <dd className="note">the sniper tax included</dd>
            </div>
          </dl>
          <p className="note">
            Worked out from the wallet&apos;s {p.swaps} {p.swaps === 1 ? "swap" : "swaps"}
            {p.fills ? ` and its Fair Open fill` : ""} as Heat indexed them from the chain, by average cost: profit is what was received, the Tax Share and
            what is held at the coin&apos;s last trade, less what was spent. Coins sent to or from the wallet are not counted.
          </p>
        </section>
        <p className="row">
          <Link className="btn btn-sm" href={`/coin/${p.mint}`}>
            ${p.ticker} on Heat
          </Link>
          {!p.latest && (
            <Link className="btn btn-sm btn-ghost" href={`/pnl/${p.mint}/${p.wallet}`}>
              The position now
            </Link>
          )}
        </p>
      </main>
    </div>
  );
}
