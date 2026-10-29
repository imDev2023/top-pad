import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CoinNotYet } from "@/components/coin/CoinNotYet";
import { CoinPage } from "@/components/coin/CoinPage";
import { loadCoin } from "@/lib/api";

type Props = { params: Promise<{ mint: string }> };

// The title and the page ask once between them.
const coinAt = cache(loadCoin);

/** Base58, 32 to 44 characters: what could be a coin's address at all. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { mint } = await params;
  if (!ADDRESS.test(mint)) return { title: "Nothing at this address" };
  const coin = await coinAt(mint);
  return { title: typeof coin === "object" ? `$${coin.ticker} · ${coin.name}` : coin === "missing" ? "Looking for a coin" : "Coin" };
}

/**
 * A coin's page (spec 9, screen 3): its market, the sniper tax while it runs, its chart and its trades, live. An address
 * with no coin yet keeps looking for a while, since a coin launched moments ago is still being indexed.
 */
export default async function Page({ params }: Props) {
  const { mint } = await params;
  if (!ADDRESS.test(mint)) notFound();
  const coin = await coinAt(mint);
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
        <CoinPage initial={coin} />
      )}
    </div>
  );
}
