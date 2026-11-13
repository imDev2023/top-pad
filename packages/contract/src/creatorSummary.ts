import { z } from "zod";
import { Address } from "./launch";

// The Creator record's summary (spec 7, 9): what other pages show of a coin's creator. Apart from the record itself, so
// the Fair Open's and the coin's shapes can carry it.

/** A record's linked X account, as X last gave it. */
export const CreatorX = z.object({ handle: z.string(), name: z.string(), avatarUrl: z.string().url().nullable() });
export type CreatorX = z.infer<typeof CreatorX>;

/** Another record, as a record names it: by its X handle when linked, else by its Creator wallet. */
export const CreatorRef = z.object({ id: z.uuid(), handle: z.string().nullable(), wallet: Address.nullable() });
export type CreatorRef = z.infer<typeof CreatorRef>;

export const CreatorMarks = z.object({
  /** A good record (spec 7): at least one graduated Heat coin, no Bar and no open bundling case. */
  verifiedCreator: z.boolean(),
  /** World ID Orb's "verified human" mark, which comes with the Verified tier (#95): false until then. */
  verifiedHuman: z.boolean(),
});
export type CreatorMarks = z.infer<typeof CreatorMarks>;

/**
 * The record summary (spec 7, 9): what the coin page, the calendar and the Fairness card show of a coin's creator, each
 * figure one the record itself lists.
 */
export const CreatorSummary = z.object({
  id: z.uuid(),
  /** The current Creator wallet; null for a record that linked X and has never had one. */
  wallet: Address.nullable(),
  x: CreatorX.nullable(),
  /** Heat coins the record launched, in both modes. */
  coins: z.number().int().nonnegative(),
  graduations: z.number().int().nonnegative(),
  /** Graduations over coins; null for a record with no coin. */
  graduationRate: z.number().min(0).max(1).nullable(),
  /** Coins whose creator role is now held outside the record. */
  handedOver: z.number().int().nonnegative(),
  /** Coins that never graduated and went quiet: no trade for 7 days. */
  quiet: z.number().int().nonnegative(),
  marks: CreatorMarks,
  /** When the record started. */
  since: z.iso.datetime(),
});
export type CreatorSummary = z.infer<typeof CreatorSummary>;
