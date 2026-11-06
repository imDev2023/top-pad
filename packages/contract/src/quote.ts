import { z } from "zod";
import { Address, RawAmount } from "./launch";

/**
 * A Quote Risk Label (ADR 0007 decision 5): one fact about a coin's quote a creator or trader should know before using
 * it, read from the quote's mint, in Stoker's words. Labels inform; they never refuse a launch or a trade. Pages show
 * them as further information, never beside the quote's name (Stoker `CONTEXT.md`).
 */
export const QuoteLabel = z.object({
  kind: z.enum(["freeze", "permanent_delegate", "pausable", "transfer_hook", "default_frozen", "scaled_balance"]),
  /** `caution` for a power someone holds over the quote or its holders, `info` for a fact about how it reads. */
  severity: z.enum(["caution", "info"]),
  /** Short enough for a chip: "Can pause transfers". */
  title: z.string(),
  /** A sentence or two on what it means. */
  detail: z.string(),
  /** The key that holds the power, null for a fact no key holds. */
  holder: Address.nullable(),
});
export type QuoteLabel = z.infer<typeof QuoteLabel>;

/**
 * A coin's quote as pages show it: what it is called, its decimals and the multiplier its raw amounts are shown through.
 * Every amount the API answers stays in the quote's raw units, and every price and market cap unscaled, so a split or a
 * dividend changes no stored figure; pages show them all through `multiplier`, the quote's Scaled UI Amount multiplier
 * in force now (1 for a mint without one), so a chart rescales as a whole and never steps (ADR 0007 decision 5).
 */
export const QuoteInfo = z.object({
  mint: Address,
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
  multiplier: z.number().positive(),
  /** Its Quote Risk Labels, cautions first; empty for SOL and for a mint no issuer holds any power over. */
  labels: z.array(QuoteLabel),
  /** Its mint on the explorer. */
  explorer: z.string().url(),
});
export type QuoteInfo = z.infer<typeof QuoteInfo>;

/**
 * A quote Heat lists on this cluster (ADR 0007), as the launch form's picker offers it: it is offered once the band job
 * has written its `QuoteSettings` and Heat's rules still take its mint, read from the chain as the list is asked for.
 */
export const ListedQuote = QuoteInfo.extend({
  /** Whether a coin can be launched in it now. */
  offered: z.boolean(),
  /** Why it is not offered, a sentence; null when it is. */
  waiting: z.string().nullable(),
  /** What its `QuoteSettings` name now, in its raw units; null until the band job writes them. */
  settings: z
    .object({
      fairOpenConfig: Address,
      instantConfig: Address,
      /** A Fair Open's deposit step: 0.01 SOL's worth when the pair was made. */
      step: RawAmount,
      /** Both configs' Graduation Target: 8.5 SOL's worth on devnet. */
      graduationTarget: RawAmount,
      /** A Fair Open pot's cap: 20% of the target. */
      potCap: RawAmount,
      /** A Fair Open ladder's 64 rungs in the quote, largest first (spec 2.1 step 6). */
      rungs: z.array(RawAmount),
    })
    .nullable(),
});
export type ListedQuote = z.infer<typeof ListedQuote>;

/** `GET /quotes`: every quote Heat lists on this cluster, SOL first. */
export const QuoteList = z.object({ quotes: z.array(ListedQuote) });
export type QuoteList = z.infer<typeof QuoteList>;
