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
 * A wallet's seat, read from the chain while it lasts: what it buys with and gets back, if the window closed now or, once
 * the launch has opened, what it bought. A seat closed after the open, by its Tax Share or the Creator lock, is told from
 * the indexer's record of it.
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
  /** The Tax Share it was paid as it closed (spec 2.1 step 14); null until then, and for the creator's seat. */
  taxShare: RawAmount.nullable(),
  /** Whether it has closed, its rent returned: by its Tax Share, or the creator's by the Creator lock. */
  closed: z.boolean(),
});
export type FairOpenSeat = z.infer<typeof FairOpenSeat>;

/**
 * The Creator lock (spec 2.1 step 13, ADR 0004): `none` when the Creator wallet holds no seat, `pending` until the lock
 * runs right after the open, and `locked` once its coins are in a Jupiter Lock escrow nobody can cancel, released from
 * `cliffAt` to `endsAt`. Coins are in the coin's raw units, the deposit in the quote's.
 */
export const CreatorLock = z.object({
  status: z.enum(["none", "pending", "locked"]),
  deposit: RawAmount.nullable(),
  coins: RawAmount.nullable(),
  escrow: Address.nullable(),
  cliffAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  /** The escrow on the explorer. */
  explorer: z.string().url().nullable(),
});
export type CreatorLock = z.infer<typeof CreatorLock>;

/**
 * The Tax Share (spec 2.1 step 14): what the first 60 s of trading paid in sniper tax, less the pot's own fee, with the
 * open's lamport dust, paid to every depositor but the creator in proportion to what they spent. Null on the page until
 * it is collected, at `windowEndsAt`. In the quote's raw units.
 */
export const TaxShare = z.object({
  total: RawAmount,
  fees: RawAmount,
  dust: RawAmount,
  /** Whether, with no depositor but the creator, it went to Heat's treasury. */
  toTreasury: z.boolean(),
  /** How many seats have been paid theirs, and what that came to. */
  paidSeats: z.number().int().nonnegative(),
  paid: RawAmount,
  collectedAt: z.iso.datetime(),
  explorer: z.string().url(),
});
export type TaxShare = z.infer<typeof TaxShare>;

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
      /** How many seats have their coins and refund, out of `seats`, every seat the open filled, which deposited `deposited`. */
      delivered: z.number().int().nonnegative(),
      seats: z.number().int().nonnegative(),
      deposited: RawAmount,
      /** When trading opened and when its Tax window ends, after which the Tax Share is collected. */
      openedAt: z.iso.datetime(),
      taxWindowEndsAt: z.iso.datetime(),
      lock: CreatorLock,
      taxShare: TaxShare.nullable(),
      /** Whether the launch is done and its account closed, its rent back to the creator. */
      closed: z.boolean(),
    })
    .nullable(),
  /** What a new seat prepays beyond its deposit, all of it returned (spec 2.1 step 9). */
  rent: z.object({ seat: RawAmount, coinAccount: RawAmount }),
  /**
   * How the creator signs the open (ADR 0005): `signed` when the whole ladder was signed at scheduling, `at_open` when
   * the Creator wallet must sign the rung the pot covers once the window has closed, and `at_open_signed` once it has;
   * null for a launch Heat did not schedule.
   */
  ladder: z.enum(["signed", "at_open", "at_open_signed"]).nullable(),
  /** The wallet asked about, with its admission and its seat. */
  you: z.object({ wallet: Address, admission: FairOpenAdmission, seat: FairOpenSeat.nullable() }).nullable(),
  explorer: z.string().url(),
});
export type FairOpen = z.infer<typeof FairOpen>;

/** `POST /fair-opens/:launch/deposit` and `/withdraw`: a wallet and an amount, in the quote's raw units. */
export const FairOpenMove = z.object({ wallet: Address, amount: RawAmount });
export type FairOpenMove = z.infer<typeof FairOpenMove>;

/**
 * `POST /fair-opens/:launch/open/submit`: the rung the pot covers, base64, signed by the Creator wallet at the open,
 * when it could not sign the ladder at scheduling.
 */
export const SubmitOpen = z.object({ transaction: z.string().max(4096) });
export type SubmitOpen = z.infer<typeof SubmitOpen>;

/** `POST /fair-opens/:launch/mark-failed`, `/refund`, `/claim` and `/open`: the wallet that signs. */
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
  code: z.enum(["invalid", "not_found", "unavailable", "not_admitted", "window", "over_cap", "no_seat", "cannot_fail", "not_failed", "not_opened", "delivered", "creators_seat", "not_the_creator", "not_due", "already_signed"]),
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
