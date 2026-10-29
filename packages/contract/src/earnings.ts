import { z } from "zod";
import { Address, RawAmount } from "./launch";

/** A transaction's signature, base58. */
export const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "not a transaction signature");

/** One coin's Creator Earnings for the wallet that holds its DBC creator role (spec 4, 7). */
export const EarningsCoin = z.object({
  mint: Address,
  pool: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().url().nullable(),
  /**
   * The pool's partner fees waiting, in the quote's raw units: half of them, rounded down, are the wallet's. A claim
   * asks for exactly this much, so it pays exactly `waiting` however much accrues meanwhile.
   */
  partnerFees: RawAmount,
  /** The wallet's half of `partnerFees`: what a claim pays it now. */
  waiting: RawAmount,
  /**
   * Whether the coin's window claim has run (spec 4): until it has, whatever the pool holds may be its Tax window's
   * fees, which never reach the creator, so nothing waits for the wallet yet.
   */
  windowClaimed: z.boolean(),
  /** What this wallet has been paid from the coin so far, by claims the indexer has seen. */
  claimed: RawAmount,
});
export type EarningsCoin = z.infer<typeof EarningsCoin>;

/** `GET /earnings/:wallet`: the Creator Earnings waiting for a wallet in each Heat coin whose creator role it holds. */
export const CreatorEarnings = z.object({
  wallet: Address,
  quote: z.object({ symbol: z.string(), decimals: z.number().int().nonnegative() }),
  /** Most waiting first. */
  coins: z.array(EarningsCoin),
  /** The sum of the coins' `waiting` and `claimed`. */
  waiting: RawAmount,
  claimed: RawAmount,
});
export type CreatorEarnings = z.infer<typeof CreatorEarnings>;

/** `POST /earnings/:wallet/claim`: the coins to claim, each with the partner fees the page showed. */
export const ClaimRequest = z.object({
  claims: z.array(z.object({ mint: Address, partnerFees: RawAmount })).min(1).max(40),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/**
 * The claim, for the wallet to sign and send: as few transactions as hold it, usually one (`@top-pad/chain`'s
 * `creatorClaimMessages`), each unsigned, base64, with the wallet paying its network fee.
 */
export const PreparedClaim = z.object({
  transactions: z.array(z.string()).min(1),
  /** What the claim pays the wallet, in all and by coin: exactly what the page showed. */
  pays: RawAmount,
  coins: z.array(z.object({ mint: Address, pays: RawAmount })),
});
export type PreparedClaim = z.infer<typeof PreparedClaim>;

/** `POST /earnings/claims`: the signatures of a claim's transactions, once the wallet has sent them. */
export const ClaimSent = z.object({ signatures: z.array(Signature).min(1).max(20) });
export type ClaimSent = z.infer<typeof ClaimSent>;

/** What a sent claim did on chain, read from the fee program's events in its landed transactions. */
export const ClaimOutcome = z.object({
  transactions: z.array(
    z.object({
      signature: Signature,
      /** `pending` when the transaction had not confirmed by the time the API stopped waiting. */
      status: z.enum(["landed", "failed", "pending"]),
      error: z.string().nullable(),
      explorer: z.string().url(),
    }),
  ),
  /** What the landed transactions paid the creator role holder, in all and by coin. */
  paid: RawAmount,
  coins: z.array(z.object({ mint: Address, paid: RawAmount })),
});
export type ClaimOutcome = z.infer<typeof ClaimOutcome>;

/** A coin's window claim (spec 4): what its Tax window paid the treasury, and when the claim ran. */
export const WindowClaim = z.object({
  amount: RawAmount,
  /** When the window ended and when the claim ran: a claim that ran late also paid the seconds between. */
  windowEndedAt: z.iso.datetime(),
  claimedAt: z.iso.datetime(),
  explorer: z.string().url(),
});
export type WindowClaim = z.infer<typeof WindowClaim>;
