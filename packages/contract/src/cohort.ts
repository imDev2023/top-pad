import { z } from "zod";
import { Address } from "./launch";

// The devnet cohort (spec 11.3, #63): a signed-in record joins it, and a member whose record linked X gets 1 devnet SOL
// once from the cohort tap (spec 10.2), sent to the record's Creator wallet.

/** A tap that went out: where the SOL went, how much, its transaction and whether it has landed. */
export const CohortTap = z.object({
  wallet: Address,
  lamports: z.string(),
  signature: z.string(),
  status: z.enum(["sending", "sent"]),
  at: z.iso.datetime(),
});
export type CohortTap = z.infer<typeof CohortTap>;

/** `GET /cohort`: the cohort as this browser's record stands in it; `null` when the browser is signed out. */
export const CohortStatus = z.object({
  member: z.boolean(),
  joinedAt: z.iso.datetime().nullable(),
  /** The record's linked X handle, which the tap asks for. */
  xHandle: z.string().nullable(),
  /** The record's Creator wallet, which the tap pays. */
  creatorWallet: Address.nullable(),
  /** The tap's own claim for this record, once made. */
  tap: CohortTap.nullable(),
  /** What the tap gives, in lamports, and whether it can pay now: false while it holds too little or is not set up here. */
  tapLamports: z.string(),
  tapOpen: z.boolean(),
});
export type CohortStatus = z.infer<typeof CohortStatus>;

export const CohortRefusal = z.object({
  error: z.string(),
  /**
   * `signed_out`: the browser is not signed in; `x_required`: the record linked no X account, so the tap gives nothing;
   * `no_wallet`: the record has no Creator wallet to pay; `claimed`: the record, its X account or its wallet had its SOL
   * already; `tap_empty`: the tap holds too little to pay; `tap_failed`: its transfer was refused or failed, nothing was
   * sent and the member may try again; `tap_closed`: there is no tap on this cluster.
   */
  code: z.enum(["signed_out", "x_required", "no_wallet", "claimed", "tap_empty", "tap_failed", "tap_closed"]),
  tap: CohortTap.nullable().optional(),
});
export type CohortRefusal = z.infer<typeof CohortRefusal>;
