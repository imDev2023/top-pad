// Devnet's rehearsal configs, by quote (spec 11.4, #91): every value of Heat's configs but a Graduation Target of 0.25
// SOL's worth, so `tests/devnet` graduates a coin for a few hundredths of a SOL rather than 8.5 SOL's worth. Their coins
// are never Heat's on the site: the indexer watches only `CLUSTERS.<cluster>.configs` and the band job's pairs, and no
// listed quote's `QuoteSettings` names any of these, but T22Q's, which nothing lists.
import { address, type Address } from "@solana/kit";
import { DEVNET_USDC, SOL_QUOTE, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type QuoteToken } from "@top-pad/chain";
import { DEVNET_TOKEN_2022_TEST_QUOTE } from "@top-pad/chain/quotes";
import { devnet } from "./devnet";

export type Rehearsal = {
  symbol: string;
  quote: QuoteToken;
  decimals: number;
  /** The Instant rehearsal config. */
  instant: Address;
  /** The Fair Open rehearsal config, which the quote's `QuoteSettings` must name for a Fair Open to be scheduled on it. */
  fairOpen: Address | null;
};

export const REHEARSALS = {
  /** SOL's, made on 2026-11-02 (#51) by `pnpm --filter @top-pad/meteora configs devnet --rehearsal --send`. */
  sol: { symbol: "SOL", quote: SOL_QUOTE, decimals: 9, instant: devnet.rehearsal!, fairOpen: null },
  /**
   * Circle's devnet USDC, at 2.5 USDC (0.25 SOL at devnet's 10 USDC a SOL), made on 2026-11-13 by `configs devnet --quote
   * <USDC> --target 2500000 --send`; USDC's `QuoteSettings` are the band job's, so its Fair Open config stays unused.
   */
  usdc: {
    symbol: "USDC",
    quote: { mint: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    decimals: 6,
    instant: address("A8HQmBaCdvoSm7ZTGpfqbABibrHsig5SHc5LpH2VnT2S"),
    fairOpen: address("5dQYHcoA4A7xaVqEMZ1kZYSRKqwTG7r2Y4UL1Aa9FnZb"),
  },
  /**
   * Devnet's Token-2022 test quote, T22Q, at 25 of it, one T22Q standing for 0.01 SOL, made on 2026-11-13 by `configs
   * devnet --quote <T22Q> --target 2500000000 --send`; its `QuoteSettings` name both, at a step of one T22Q.
   */
  token2022: {
    symbol: "T22Q",
    quote: { mint: DEVNET_TOKEN_2022_TEST_QUOTE, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    decimals: 8,
    instant: address("CW7oy3aQj2wJEShskRt764Y9UbSHivYw4PEfRZE4X76b"),
    fairOpen: address("EouRaXH2zU9R7XqgB3CFRgc7eQ5oaXKetiHNQeTvxnKR"),
  },
} as const satisfies Record<string, Rehearsal>;

export type RehearsalName = keyof typeof REHEARSALS;

/** The rehearsal `GRADUATION_QUOTE` names (sol, usdc or token2022), SOL's by default. */
export function rehearsalOf(name = process.env.GRADUATION_QUOTE ?? "sol"): Rehearsal {
  if (!(name in REHEARSALS)) throw new Error(`GRADUATION_QUOTE is sol, usdc or token2022, not ${name}`);
  return REHEARSALS[name as RehearsalName];
}
