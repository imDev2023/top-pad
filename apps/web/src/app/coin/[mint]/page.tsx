import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CoinNotYet } from "@/components/coin/CoinNotYet";
import { CoinPage } from "@/components/coin/CoinPage";
import { countsInOrder } from "@top-pad/contract";
import { loadCoin, loadFairness } from "@/lib/api";

type Props = { params: Promise<{ mint: string }> };

// The title, the link card's tags and the page ask once between them.
const coinAt = cache(loadCoin);
const fairnessAt = cache(loadFairness);

/** Base58, 32 to 44 characters: what could be a coin's address at all. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { mint } = await params;
  if (!ADDRESS.test(mint)) return { title: "Nothing at this address" };
  const [coin, card] = await Promise.all([coinAt(mint), fairnessAt(mint)]);
  if (typeof coin !== "object") return { title: coin === "missing" ? "Looking for a coin" : "Coin" };
  const title = `$${coin.ticker} · ${coin.name}`;
  if (!card) return { title };
  // The Fairness card is the coin's link card on X (spec 9): its image, 2:1, and its counts and first rows as words.
  const counts = countsInOrder(card.counts)
    .map(({ flag, count }) => `${count} ${flag}`)
    .join(", ");
  const description = `Fairness card: ${counts}. ${card.rows
    .slice(0, 3)
    .map((r) => r.value)
    .join(". ")}.`;
  const image = { url: card.image, width: 1200, height: 600, alt: `The Fairness card of $${coin.ticker}: ${counts}` };
  return {
    title,
    description,
    openGraph: { type: "website", title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/**
 * A coin's page (spec 9, screen 3): its market, the sniper tax while it runs, its chart and its trades, live. An address
 * with no coin yet keeps looking for a while, since a coin launched moments ago is still being indexed.
 */
export default async function Page({ params }: Props) {
  const { mint } = await params;
  if (!ADDRESS.test(mint)) notFound();
  const [coin, fairness] = await Promise.all([coinAt(mint), fairnessAt(mint)]);
  return (
    <div className="page">
      {coin === "missing" ? (
        <CoinNotYet mint={mint} />
      ) : coin === "unavailable" ? (
        <div className="verdict verdict-stop" role="alert">
          <b>Heat&apos;s API did not answer</b>
          <span className="note">The coin could not be loaded just now. Reload the page in a moment.</span>
        </div>
      ) : (
        <CoinPage initial={coin} fairness={fairness} />
      )}
    </div>
  );
}
