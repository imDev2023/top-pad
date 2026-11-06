// Where a quote's latest price comes from (ADR 0007, the band): Jupiter's Price API for an xStock, a cluster's own DAMM v2
// pool for a quote with no market but devnet's, and none for SOL. A quote the source cannot price is left out, never
// guessed, and the band job then keeps that quote's settings as they are.
import type { Address, GetAccountInfoApi, Rpc } from "@solana/kit";
import { fetchEncodedAccount } from "@solana/kit";
import { parseDecimal, priceFromSqrtPrice, priceFromUsd, SOL_PRICE, WSOL_MINT, type Decimal, type HeatQuote, type QuotePrice } from "@top-pad/chain";
import { getPoolDecoder } from "@top-pad/clients/damm-v2";

/** A quote's price, or why there is none. */
export type PriceReading = { price: QuotePrice; source: string } | { price: null; reason: string };

/** Prices for a list of quotes, keyed by each quote's own mint. */
export type PriceSource = (quotes: HeatQuote[]) => Promise<Map<Address, PriceReading>>;

const JUPITER_PRICE = "https://api.jup.ag/price/v3";
const JUPITER_IDS_MAX = 50;
const FETCH_TIMEOUT_MS = 15_000;

type JupiterPrice = { usdPrice?: number; decimals?: number; scaledUiConfig?: { usdPricePrescaled?: number } | null } | null;

/**
 * Jupiter's Price API v3, in USD per whole token, by the price per unscaled token for a Scaled UI Amount mint (most
 * xStocks): Heat's amounts are raw units, and a wallet's shown amount is the raw amount times the multiplier. Asked with
 * the API key, the one call a run makes for every quote priced this way; SOL's price is in the same call.
 */
export async function jupiterUsdPrices(mints: Address[], apiKey: string | null, fetcher: typeof fetch = fetch): Promise<Map<Address, Decimal>> {
  const out = new Map<Address, Decimal>();
  for (let i = 0; i < mints.length; i += JUPITER_IDS_MAX) {
    const ids = mints.slice(i, i + JUPITER_IDS_MAX).join(",");
    const res = await fetcher(`${JUPITER_PRICE}?ids=${ids}`, {
      headers: { accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Jupiter's Price API answered ${res.status}`);
    const body = (await res.json()) as Record<string, JupiterPrice>;
    for (const [mint, p] of Object.entries(body ?? {})) {
      const price = parseDecimal(p?.scaledUiConfig?.usdPricePrescaled ?? p?.usdPrice ?? Number.NaN);
      if (price) out.set(mint as Address, price);
    }
  }
  return out;
}

/** A DAMM v2 pool of the quote and SOL, read from the chain: its square-root price, either way round. */
export async function dammV2Price(rpc: Rpc<GetAccountInfoApi>, pool: Address, quoteMint: Address): Promise<QuotePrice> {
  const account = await fetchEncodedAccount(rpc, pool, { commitment: "confirmed" });
  if (!account.exists) throw new Error(`the DAMM v2 pool ${pool} does not exist`);
  const decoded = getPoolDecoder().decode(account.data);
  const mints = [decoded.tokenAMint, decoded.tokenBMint];
  if (!mints.includes(WSOL_MINT) || !mints.includes(quoteMint)) throw new Error(`the DAMM v2 pool ${pool} does not pair ${quoteMint} with SOL`);
  if (decoded.sqrtPrice === 0n) throw new Error(`the DAMM v2 pool ${pool} has no price`);
  return priceFromSqrtPrice(decoded.sqrtPrice, decoded.tokenAMint === WSOL_MINT);
}

/**
 * The live price source: SOL as itself, Jupiter for the quotes it prices (one call), and each DAMM v2 pool from the
 * chain. Any source failing leaves its quotes unpriced, with the reason, and the others priced.
 */
export function livePrices(rpc: Rpc<GetAccountInfoApi>, jupiterKey: string | null, fetcher: typeof fetch = fetch): PriceSource {
  return async (quotes) => {
    const out = new Map<Address, PriceReading>();
    const byJupiter = quotes.filter((q) => q.price.kind === "jupiter");
    let usd: Map<Address, Decimal> | Error = new Map();
    if (byJupiter.length) {
      const mints = [WSOL_MINT, ...new Set(byJupiter.map((q) => (q.price.kind === "jupiter" ? q.price.mint : q.mint)))];
      usd = await jupiterUsdPrices(mints, jupiterKey, fetcher).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    }
    for (const q of quotes) {
      const p = q.price;
      if (p.kind === "sol") out.set(q.mint, { price: SOL_PRICE, source: "SOL" });
      else if (p.kind === "jupiter") {
        if (usd instanceof Error) {
          out.set(q.mint, { price: null, reason: usd.message });
          continue;
        }
        const quoteUsd = usd.get(p.mint);
        const solUsd = usd.get(WSOL_MINT);
        out.set(
          q.mint,
          quoteUsd && solUsd
            ? { price: priceFromUsd(quoteUsd, solUsd, q.decimals), source: p.mint === q.mint ? "Jupiter" : `Jupiter, as ${p.mint}` }
            : { price: null, reason: `Jupiter has no price for ${quoteUsd ? "SOL" : p.mint}` },
        );
      } else {
        const reading = await dammV2Price(rpc, p.pool, q.mint).then(
          (price): PriceReading => ({ price, source: `DAMM v2 pool ${p.pool}` }),
          (e: unknown): PriceReading => ({ price: null, reason: e instanceof Error ? e.message : String(e) }),
        );
        out.set(q.mint, reading);
      }
    }
    return out;
  };
}

/** A price source answering a fixed price for some quotes and the live one for the rest: the devnet demo's override. */
export function withOverrides(source: PriceSource, overrides: Map<Address, QuotePrice>): PriceSource {
  return async (quotes) => {
    const out = await source(quotes.filter((q) => !overrides.has(q.mint)));
    for (const q of quotes) {
      const price = overrides.get(q.mint);
      if (price) out.set(q.mint, { price, source: "override" });
    }
    return out;
  };
}
