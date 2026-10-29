import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CoinPage } from "@/components/coin/CoinPage";
import { loadCoin } from "@/lib/api";

type Props = { params: Promise<{ mint: string }> };

// The title and the page ask once between them.
const coinAt = cache(loadCoin);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const coin = await coinAt((await params).mint);
  return { title: typeof coin === "object" ? `$${coin.ticker} · ${coin.name}` : "Coin" };
}

/** A coin's page (spec 9, screen 3): its market, the sniper tax while it runs, its chart and its trades, live. */
export default async function Page({ params }: Props) {
  const coin = await coinAt((await params).mint);
  if (coin === "missing") notFound();
  return (
    <div className="page">
      {coin === "unavailable" ? (
        <div className="verdict verdict-stop" role="alert">
          <b>Heat&apos;s API did not answer</b>
          <span className="note">The coin could not be loaded just now. Reload the page in a moment.</span>
        </div>
      ) : (
        <CoinPage initial={coin} />
      )}
    </div>
  );
}
