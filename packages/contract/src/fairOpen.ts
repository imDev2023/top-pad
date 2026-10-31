import { z } from "zod";
import { Signature } from "./earnings";
import { Address, RawAmount } from "./launch";

/** A Depositor tier (spec 2.1 step 9): how strongly a person has shown they are one person. */
export const DepositorTier = z.enum(["unverified", "scored", "verified"]);
export type DepositorTier = z.infer<typeof DepositorTier>;

/** Why a launch failed (spec 2.1 step 15). */
export const FairOpenFailure = z.enum(["below_lowest_rung", "min_raise_missed", "late"]);
export type FairOpenFailure = z.infer<typeof FairOpenFailure>;

/**
 * Where a Fair Open stands, by Heat's clock: `scheduled` before its window, `window` while deposits are taken, `due`
 * once the window has closed and the pot can open, `opened` once its coin exists and the pot has bought, `failing` once
 * anyone may mark it failed, `failed` once marked, with every deposit coming back, and `closed` once every seat is back
 * and the creator's rent too.
 */
export const FairOpenPhase = z.enum(["scheduled", "window", "due", "opened", "failing", "failed", "closed"]);
export type FairOpenPhase = z.infer<typeof FairOpenPhase>;

/** A level of the allocation, in the quote's raw units: each seat fills its ask or the level, whichever is less. */
export const FairOpenLevel = z.object({ level: RawAmount, filled: RawAmount, limited: z.boolean() });
export type FairOpenLevel = z.infer<typeof FairOpenLevel>;

/** What a wallet is admitted as in a Fair Open, or why it is not (spec 6.3). */
export const FairOpenAdmission = z.discriminatedUnion("admitted", [
  z.object({
    admitted: z.literal(true),
    tier: DepositorTier,
    /** The most the wallet's seat may hold, in the quote's raw units. */
    cap: RawAmount,
    /** How Heat knows the person: their linked X account, the Creator wallet of their record, or not at all. */
    via: z.enum(["x", "creator_wallet", "none"]),
    /** The X handle the tier comes from, when it does. */
    handle: z.string().nullable(),
  }),
  z.object({ admitted: z.literal(false), reason: z.string() }),
]);
export type FairOpenAdmission = z.infer<typeof FairOpenAdmission>;

/**
 * A wallet's seat, read from the chain: what it buys with and gets back, if the window closed now or, once the launch
 * has opened, what it bought.
 */
export const FairOpenSeat = z.object({
  address: Address,
  tier: DepositorTier,
  cap: RawAmount,
  deposit: RawAmount,
  /** The rent the seat and the coin account hold, both returned. */
  seatRent: RawAmount,
  coinRent: RawAmount,
  /** What its deposit spends of the rung, and its refund. */
  fill: RawAmount,
  refund: RawAmount,
  /** Once the launch has opened: the coins it bought, in the coin's raw units, and whether they and its refund are in its wallet. */
  coins: RawAmount.nullable(),
  delivered: z.boolean(),
});
export type FairOpenSeat = z.infer<typeof FairOpenSeat>;

/** `GET /fair-opens/:launch?wallet=`: a Fair Open as its page shows it (spec 9, screen 2). */
export const FairOpen = z.object({
  launch: Address,
  creator: z.object({ wallet: Address, handle: z.string().nullable(), name: z.string().nullable(), avatarUrl: z.string().url().nullable() }),
  teaser: z.string().nullable(),
  /** The SHA-256 the coin's name, ticker and metadata URI are sealed behind, hex. */
  identityHash: z.string().regex(/^[0-9a-f]{64}$/),
  depositsOpenAt: z.iso.datetime(),
  opensAt: z.iso.datetime(),
  /** From when the open is refused and anyone may mark the launch failed. */
  lateAt: z.iso.datetime(),
  phase: FairOpenPhase,
  failure: FairOpenFailure.nullable(),
  /** Heat's clock when it answered, so a page counts down by it. */
  serverTime: z.iso.datetime(),
  quote: z.object({ symbol: z.string(), decimals: z.number().int().nonnegative() }),
  /** Every amount below is in the quote's raw units. */
  step: RawAmount,
  potCap: RawAmount,
  minRaise: RawAmount,
  lowestRung: RawAmount,
  /** Each tier's cap per Fair Open. */
  tierCaps: z.object({ unverified: RawAmount, scored: RawAmount, verified: RawAmount }),
  pot: z.object({ total: RawAmount, seats: z.number().int().nonnegative(), unverified: RawAmount, scored: RawAmount, verified: RawAmount }),
  /** If the window closed now (spec 2.1 step 11): what the pot would spend, each tier's level, and the rung it opens on. */
  allocation: z.object({ spend: RawAmount, others: FairOpenLevel, unverified: FairOpenLevel, rung: RawAmount.nullable() }),
  /**
   * Once it has opened (spec 2.1 step 10): its coin, revealed, and its pool; the rung the pot spent and the coins it
   * bought, in the coin's raw units; and how many seats have their coins and refund. The coin's name and ticker come
   * from the indexer, and are null until it has seen the open.
   */
  open: z
    .object({
      mint: Address,
      pool: Address,
      coin: z.object({ name: z.string(), ticker: z.string() }).nullable(),
      spent: RawAmount,
      coins: RawAmount,
      coinDecimals: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
    })
    .nullable(),
  /** What a new seat prepays beyond its deposit, all of it returned (spec 2.1 step 9). */
  rent: z.object({ seat: RawAmount, coinAccount: RawAmount }),
  /** The wallet asked about, with its admission and its seat. */
  you: z.object({ wallet: Address, admission: FairOpenAdmission, seat: FairOpenSeat.nullable() }).nullable(),
  explorer: z.string().url(),
});
export type FairOpen = z.infer<typeof FairOpen>;

/** `POST /fair-opens/:launch/deposit` and `/withdraw`: a wallet and an amount, in the quote's raw units. */
export const FairOpenMove = z.object({ wallet: Address, amount: RawAmount });
export type FairOpenMove = z.infer<typeof FairOpenMove>;

/** `POST /fair-opens/:launch/mark-failed`, `/refund` and `/claim`: the wallet that signs and pays the network fee. */
export const FairOpenSender = z.object({ wallet: Address });
export type FairOpenSender = z.infer<typeof FairOpenSender>;

/** A transaction for the wallet to sign and send: unsigned, base64, the wallet paying its network fee. */
export const PreparedFairOpenTransaction = z.object({
  transaction: z.string(),
  /** A deposit's admission, which the transaction carries. */
  admission: z.object({ tier: DepositorTier, cap: RawAmount }).nullable(),
});
export type PreparedFairOpenTransaction = z.infer<typeof PreparedFairOpenTransaction>;

/** A refusal before anything is signed, with the reason the page shows. */
export const FairOpenRefusal = z.object({
  error: z.string(),
  code: z.enum(["invalid", "not_found", "unavailable", "not_admitted", "window", "over_cap", "no_seat", "cannot_fail", "not_failed", "not_opened", "delivered", "creators_seat"]),
});
export type FairOpenRefusal = z.infer<typeof FairOpenRefusal>;

/** `POST /fair-opens/transactions`: a sent transaction's signature, settled against the chain. */
export const FairOpenSent = z.object({ signature: Signature });
export type FairOpenSent = z.infer<typeof FairOpenSent>;

export const FairOpenOutcome = z.object({
  signature: Signature,
  /** `pending` when it had not confirmed by the time the API stopped waiting. */
  status: z.enum(["landed", "failed", "pending"]),
  error: z.string().nullable(),
  explorer: z.string().url(),
});
export type FairOpenOutcome = z.infer<typeof FairOpenOutcome>;
