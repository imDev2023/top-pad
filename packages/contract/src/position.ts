import { z } from "zod";
import { Decimal, OrderKey } from "./coin";
import { Address, RawAmount } from "./launch";
import { QuoteInfo } from "./quote";

// A trader's position in a Heat coin and its P&L (spec 9: the P&L share card, one of the brief's trading basics), worked
// out from Heat's indexed rows alone: the wallet's trades on the curve and the graduated pool, and its Fair Open fills.
// A position is always stated as of one trade of the coin, its snapshot, so the card a trader shares says the same
// thing forever, whatever the price does after.

/** A signed amount in raw units: a gain or a loss. */
export const SignedRawAmount = z.string().regex(/^-?\d+$/);
export type SignedRawAmount = z.infer<typeof SignedRawAmount>;

export const Position = z.object({
  mint: Address,
  wallet: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().nullable(),
  launchMode: z.enum(["fair_open", "instant"]).nullable(),
  /** The coin's decimals; every coin amount below is in its raw units. */
  decimals: z.number().int().nonnegative(),
  /** The coin's quote; every quote amount below is in its raw units, shown through its multiplier in force now. */
  quote: QuoteInfo,
  /**
   * The snapshot: the position counts every trade with an order key up to this one and every Fair Open fill in a slot up
   * to its slot, and is priced at the coin's last trade up to it.
   */
  at: OrderKey,
  /** Whether `at` is the newest snapshot there is, the coin's latest trade or the wallet's latest fill. */
  latest: z.boolean(),
  /** When the snapshot's last counted event happened, by the chain's clock. */
  asOf: z.string().datetime(),
  /** The quote a whole coin cost at the snapshot's price, unscaled. */
  price: Decimal,
  /** Coins bought (swaps' coins out, Fair Open fills' coins) and the quote spent on them, fees included. */
  bought: RawAmount,
  spent: RawAmount,
  /** Coins sold and the quote received for them, after fees. */
  sold: RawAmount,
  received: RawAmount,
  /** The Fair Open Tax Share paid to the wallet's seat, in the quote. */
  taxShare: RawAmount,
  /** Every fee the wallet's swaps paid, in the quote, the sniper tax included; already inside `spent` and `received`. */
  fees: RawAmount,
  /** Coins the counted trades and fills leave, never below nothing, and what they are worth at the snapshot's price. */
  held: RawAmount,
  value: RawAmount,
  /** What the held coins cost, by average cost. */
  costHeld: RawAmount,
  /** Received and Tax Share less what the sold coins cost; value less what the held coins cost; and the two together. */
  realized: SignedRawAmount,
  unrealized: SignedRawAmount,
  pnl: SignedRawAmount,
  /** `pnl` as a share of `spent`, in percent; null when nothing was spent. */
  pnlPercent: z.number().nullable(),
  /** How many swaps and Fair Open fills it counts. */
  swaps: z.number().int().nonnegative(),
  fills: z.number().int().nonnegative(),
  firstAt: z.string().datetime(),
  /** The P&L card image for this snapshot (1200 x 600 PNG), absolute. */
  card: z.string().url(),
});
export type Position = z.infer<typeof Position>;
