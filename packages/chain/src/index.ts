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
/** Circle's devnet USDC, an SPL Token mint DBC takes as a quote with no badge (ADR 0007, #88). */
export const DEVNET_USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SPL_TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * The rehearsal config's Graduation Target, 0.25 SOL: its curve A, solved like the real one's, leaves one raw coin over,
 * so every rehearsal also burns a leftover.
 */
export const REHEARSAL_GRADUATION_TARGET = 250_000_000n;

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
   * launches and registers coins; and who the Fair Open program's `ProgramConfig` names besides the keeper, set by
   * `fair-open-config`: the admission signer, which signs each deposit's admission and holds no funds.
   */
  keys: {
    treasury: Address;
    keeper: Address;
    admission: Address;
    /** Writes each quote's `QuoteSettings` in the Fair Open program (ADR 0007 decision 4), and holds no funds. */
    quoteManager: Address;
  } | null;
  /**
   * Devnet's rehearsal config, made by `pnpm --filter @top-pad/meteora configs devnet --rehearsal --send`: the Instant
   * config's every value but its Graduation Target, `REHEARSAL_GRADUATION_TARGET`, so `tests/devnet` graduates a coin
   * for a few hundredths of a SOL (spec 11.4). Its coins are never Heat's: the indexer watches only `configs`.
   */
  rehearsal: Address | null;
  /**
   * Heat's shared address lookup table, which every open's creation transaction and every push compresses its common
   * accounts through (spec 2.1 step 10), made and frozen by `pnpm --filter @top-pad/chain lookup-table <cluster>`.
   */
  lookupTable: Address | null;
  /**
   * The quotes besides SOL whose mint, and TokenBadge when DBC takes the mint only with one, the shared lookup table
   * holds (ADR 0007, #88): a creation transaction in a Token-2022 quote names its mint, Token-2022 and the badge, which
   * came to exactly the 1,232-byte limit for the longest coin, with no room for a compute unit price, until the table
   * held them. A quote not listed still fits a creation, 32 bytes more an address; a quote added means a new table.
   */
  tableQuotes: { mint: Address; tokenProgram: Address; badge: boolean }[];
  /**
   * Every quote Heat offers on the cluster, SOL first (ADR 0007): the band job keeps each one's `QuoteSettings` naming a
   * config pair within the band at its latest price, and a quote is offered once it has them. The rules take any mint
   * DBC accepts, so this list is a product choice; a quote DBC does not yet take (the stand-in xStock, until Meteora
   * badges it on devnet) is listed and waits.
   */
  quotes: HeatQuote[];
  /**
   * Wallets the linkage pipeline never ties anyone through (spec 6.3), besides Heat's own keys, any wallet too busy to
   * read back (a full page of history) and the operator's `linkage_hubs`: funding sources everyone on the cluster shares,
   * as Heat's devnet bank, which funds every test wallet, the creators' included.
   */
  linkageHubs: Address[];
};

/**
 * Where a quote's latest price comes from (ADR 0007, the band): SOL needs none; an xStock is priced by Jupiter's Price
 * API in USD against SOL's, by the price per unscaled token, named by its mainnet mint (devnet's stand-in is priced as
 * NVDAx); a quote with no market but a cluster's own pools, such as Circle's devnet USDC, is priced by a DAMM v2 pool of
 * it and SOL there, read from the chain.
 */
export type QuotePriceSource = { kind: "sol" } | { kind: "jupiter"; mint: Address } | { kind: "dammV2"; pool: Address };

/** A quote Heat offers: its mint, token program and decimals as the chain holds them, and where its price comes from. */
export type HeatQuote = { symbol: string; mint: Address; tokenProgram: Address; decimals: number; price: QuotePriceSource };

const SOL: HeatQuote = { symbol: "SOL", mint: WSOL_MINT, tokenProgram: SPL_TOKEN, decimals: 9, price: { kind: "sol" } };

/**
 * The cohort's 22 xStocks (ADR 0007, settled question 3: more than $100K of liquidity by EmberCurve's figures on
 * 2026-11-02), each a Token-2022 mint of 8 decimals with a DBC TokenBadge on mainnet; their mints and symbols checked
 * against Jupiter's token list on 2026-11-06, and against the chain by `pnpm --filter @top-pad/chain quote-check`.
 */
const XSTOCKS = {
  SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  CRCLx: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  QQQx: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  MSTRx: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  SPCXx: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  HOODx: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
  MSFTx: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
  COINx: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
  MCDx: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2",
  GLDx: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re",
  GMEx: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc",
  STRCx: "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH",
  METAx: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
  KOx: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ",
  GOOGLx: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  AMZNx: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
  "BRK.Bx": "Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x",
  DFDVx: "Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy",
  PLTRx: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4",
} as const;

/** An xStock on mainnet: priced by Jupiter under its own mint. */
const xstock = (symbol: keyof typeof XSTOCKS): HeatQuote => {
  const mint = address(XSTOCKS[symbol]);
  return { symbol, mint, tokenProgram: TOKEN_2022, decimals: 8, price: { kind: "jupiter", mint } };
};

/** NVDAx's mainnet mint, by whose price devnet's stand-in xStock is priced. */
export const NVDAX_MINT = address(XSTOCKS.NVDAx);

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
    // Made on 2026-10-29 (#41), the admission signer on 2026-10-30 (#45): plain keys on devnet, kept outside the repo in
    // ~/.config/top-pad/devnet.
    keys: {
      treasury: address("F7mn4DAccxre57wjoNoQzDgmk7H6mYG2NuWwG8Yt3oTG"),
      keeper: address("GpDvDUpEC9ynHTJBt3XaZcTvBUw1HaMnU9Wwox18xfNi"),
      admission: address("2LH1VzF3rbCKdfSZDBXkbbwXbZZsbYkP8qkVRP9rgzuJ"),
      // Made on 2026-11-04 (#84), in ~/.config/top-pad/devnet/quote-manager.json.
      quoteManager: address("639kdfnCQ762Rio8jdVXm66pqMx3uRHWeuiZpY5wwmWq"),
    },
    // Made and frozen on 2026-11-04 (#88), the table of 2026-10-31 (#46, B2XYd5qp7wyT5Dnvg3CJh6aZxoiiAAX4QRvLLMsgxMHT,
    // which ladders signed before it still name) with Token-2022 and the listed quotes added.
    lookupTable: address("CLBppnGVZCKyFNLudC6vebLVTXHxjUr6wcmxEJSnS4Y7"),
    // Created on 2026-11-02 (#51).
    rehearsal: address("FpBAjo24FLrxj69qfu92NodVvWJE8zSPPxPxmearft27"),
    tableQuotes: [
      { mint: DEVNET_USDC, tokenProgram: SPL_TOKEN, badge: false },
      // `DEVNET_XSTOCK_STAND_IN`, with every xStock extension: DBC takes it once Meteora badges it (#91).
      { mint: address("Wm7nXsHnoHJm3NemWaLbnxd7QkmeHLALucsFC4qTUNK"), tokenProgram: TOKEN_2022, badge: true },
    ],
    quotes: [
      SOL,
      // Priced by Meteora's deepest devnet DAMM v2 pool of SOL and USDC, at devnet's own price (about 10 USDC a SOL), the
      // pool `devnet-usdc` swaps through: Circle's faucet asks for a captcha, so the bank buys its USDC there (#88).
      { symbol: "USDC", mint: DEVNET_USDC, tokenProgram: SPL_TOKEN, decimals: 6, price: { kind: "dammV2", pool: address("A7sYJqmWsqyKzkyEZg8fQrMWFKdrFpQA4E1Msa9Pnvur") } },
      // The stand-in xStock, priced as NVDAx (both 8 decimals): DBC takes it once Meteora badges it on devnet (#91).
      { symbol: "NVDAx", mint: address("Wm7nXsHnoHJm3NemWaLbnxd7QkmeHLALucsFC4qTUNK"), tokenProgram: TOKEN_2022, decimals: 8, price: { kind: "jupiter", mint: NVDAX_MINT } },
    ],
    // Heat's devnet bank (~/.config/top-pad/devnet/bank.json), which pays for every test, script and deploy.
    linkageHubs: [address("Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933")],
  },
  mainnet: {
    quote: { mint: WSOL_MINT, symbol: "SOL", decimals: 9 },
    graduationTarget: 85_000_000_000n,
    sqrtStartPrice: 112_339_987_482_345_485n,
    configs: null,
    keys: null,
    lookupTable: null,
    rehearsal: null,
    tableQuotes: [],
    quotes: [SOL, ...(Object.keys(XSTOCKS) as (keyof typeof XSTOCKS)[]).map(xstock)],
    linkageHubs: [],
  },
};

export * from "./afterOpen";
export * from "./band";
export * from "./claims";
export * from "./coin";
export * from "./dbc";
export * from "./fairOpen";
export * from "./graduation";
export * from "./launch";
export * from "./open";
export * from "./swap";
