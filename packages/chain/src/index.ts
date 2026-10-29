// Heat's own addresses on chain, per cluster (spec 3 and 5): its two programs, the fee program's `fee_claimer` PDA that
// every config names, and the two DBC configs with the quote and Graduation Target they were built from. Kit only, so
// the API, the keeper and the indexer read them without web3.js.
import { address, type Address } from "@solana/kit";
import type { Cluster } from "@top-pad/contract";

/** The program ids, the same on devnet and mainnet (spec 5.1). */
export const FEE_PROGRAM_ADDRESS = address("HeatFEzySQiaWqxR7cDza9WP2B15AxMfsgSS5p6Bdn97");
export const FAIR_OPEN_PROGRAM_ADDRESS = address("HeatPiBAgiwq6VJr8eqyagQiQ2gvaK2y85q26bbBu4bo");

/**
 * The fee program's `fee_claimer` PDA (spec 5.2), seeded with `FEE_CLAIMER_SEED` alone: the partner, fee claimer and
 * leftover receiver on every Heat config, forever, since a config cannot be changed. Kept as a constant so it is read
 * without a derivation; the tests here and in `programs/fee` derive it again.
 */
export const FEE_CLAIMER_SEED = "fee_claimer";
export const FEE_CLAIMER_ADDRESS = address("4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko");

export const WSOL_MINT = address("So11111111111111111111111111111111111111112");

export type HeatCluster = {
  /** What every coin trades against: SOL in the prototype (spec 3.2), with its symbol and decimals for display. */
  quote: { mint: Address; symbol: string; decimals: number };
  /** The Graduation Target, in the quote's raw units (spec 3.2). */
  graduationTarget: bigint;
  /**
   * Curve A's starting square-root price for that target (spec 3.3), where every pool on the configs opens: what a coin
   * is priced at before its first trade. `@top-pad/meteora`'s tests check it against the generator.
   */
  sqrtStartPrice: bigint;
  /** Heat's two DBC configs, once created by `pnpm --filter @top-pad/meteora configs <cluster> --send`. */
  configs: { fairOpen: Address; instant: Address } | null;
  /**
   * Who the fee program's `FeeConfig` names (spec 5.2, 10.3), set by `pnpm --filter @top-pad/chain fee-config <cluster>`:
   * the treasury, which receives Heat's Platform Fee, and the keeper key, which is also the launch key that co-signs
   * launches and registers coins.
   */
  keys: { treasury: Address; keeper: Address } | null;
};

/**
 * Heat on each cluster. Localnet has none: Meteora's programs never run locally, since their binaries are never
 * loaded (spec 5.1); mainnet's configs belong to the mainnet effort.
 */
export const CLUSTERS: Record<Cluster, HeatCluster | null> = {
  localnet: null,
  devnet: {
    quote: { mint: WSOL_MINT, symbol: "SOL", decimals: 9 },
    graduationTarget: 8_500_000_000n,
    sqrtStartPrice: 35_525_023_424_642_174n,
    // Created on 2026-10-29 (#40).
    configs: {
      fairOpen: address("rPqMj6mwJp9qnZBMeawF8s2iC74EkhpbUSvhWd9XTnC"),
      instant: address("CMSi1oRQsZJbogjxajFCuGYze3NW9oieuKNrxGPjg8Mi"),
    },
    // Made on 2026-10-29 (#41): plain keys on devnet, kept outside the repo in ~/.config/top-pad/devnet.
    keys: {
      treasury: address("F7mn4DAccxre57wjoNoQzDgmk7H6mYG2NuWwG8Yt3oTG"),
      keeper: address("GpDvDUpEC9ynHTJBt3XaZcTvBUw1HaMnU9Wwox18xfNi"),
    },
  },
  mainnet: {
    quote: { mint: WSOL_MINT, symbol: "SOL", decimals: 9 },
    graduationTarget: 85_000_000_000n,
    sqrtStartPrice: 112_339_987_482_345_485n,
    configs: null,
    keys: null,
  },
};

export * from "./coin";
export * from "./dbc";
export * from "./launch";
export * from "./swap";
