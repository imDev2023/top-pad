import { z } from "zod";
import { ApiError, Cluster } from "./health";

/** A Solana address, base58. */
export const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
export type Address = z.infer<typeof Address>;

/** An amount in a token's raw units (lamports for SOL), as a decimal string so no precision is lost. */
export const RawAmount = z.string().regex(/^\d+$/);

/** `GET /platform`: what a page needs to know about this deployment. */
export const Platform = z.object({
  cluster: Cluster,
  /** Whether a creator can link X here: the X app's client is configured. */
  xLinking: z.boolean(),
  /** Whether a coin can be launched here now, by mode: Fair Open arrives with its own tickets (spec 14). */
  launchModes: z.object({ instant: z.boolean(), fairOpen: z.boolean() }),
  /** The largest coin image the launch service takes, in bytes. */
  maxImageBytes: z.number().int().positive(),
  /** The image types it takes. */
  imageTypes: z.array(z.string()),
});
export type Platform = z.infer<typeof Platform>;

/** `GET /me`: the Creator this browser is signed in as, by the X account it linked (spec 7). 401 when none. */
export const Me = z.object({
  x: z.object({ handle: z.string(), name: z.string(), avatarUrl: z.string().url().nullable() }),
  /** The record's Creator wallet; null until the record's first launch makes the wallet that signs it the one. */
  creatorWallet: Address.nullable(),
  launches: z.number().int().nonnegative(),
});
export type Me = z.infer<typeof Me>;

/** A Protected coin a launch was found to copy. */
export const ProtectedMatch = z.object({ mint: Address, ticker: z.string(), name: z.string() });

/** Vamp Shield's verdict on one field of a launch (spec 6.2): clear, or refused with the reason the creator reads. */
export const FieldVerdict = z.object({
  status: z.enum(["clear", "refused"]),
  reason: z.string().nullable(),
  match: ProtectedMatch.nullable(),
});
export type FieldVerdict = z.infer<typeof FieldVerdict>;

/** `POST /vamp-shield/check`: the live text verdicts the launch flow shows as the creator types (spec 9, screen 4). */
export const VampShieldCheck = z.object({ ticker: z.string().max(64), name: z.string().max(256) });
export type VampShieldCheck = z.infer<typeof VampShieldCheck>;

export const VampShieldVerdict = z.object({
  /** The ticker as it would go on chain: NFKC, trimmed, uppercased. */
  ticker: z.string(),
  name: z.string(),
  verdicts: z.object({ ticker: FieldVerdict, name: FieldVerdict }),
  /** Whether nothing refuses the launch. */
  clear: z.boolean(),
});
export type VampShieldVerdict = z.infer<typeof VampShieldVerdict>;

/**
 * Why the launch service refused a launch, for the launch flow to show (an `ApiError` with a code). Every refusal is
 * our launch key declining to co-sign: nothing on chain refuses a launch (spec 6.2).
 */
export const LaunchRefusal = ApiError.extend({
  code: z.enum([
    "not_linked",
    "unavailable",
    "invalid",
    "vamp_shield",
    "image",
    "not_the_creator_wallet",
    "wallet_taken",
    "too_many_pending",
    "simulation_failed",
    "not_found",
    "transaction_changed",
    "signature_invalid",
    "expired",
    "send_failed",
    "metadata_upload_failed",
  ]),
  verdict: VampShieldVerdict.optional(),
});
export type LaunchRefusal = z.infer<typeof LaunchRefusal>;

/**
 * `POST /launches`, a multipart form with `mode`, `name`, `ticker`, `wallet` and the `image` file: an Instant launch's
 * creation transaction (spec 2.2), signed by the coin's mint key, for the Creator wallet to sign next.
 */
export const LaunchForm = z.object({
  mode: z.literal("instant"),
  name: z.string().max(256),
  ticker: z.string().max(64),
  wallet: Address,
});
export type LaunchForm = z.infer<typeof LaunchForm>;

export const PreparedLaunch = z.object({
  id: z.uuid(),
  mint: Address,
  pool: Address,
  /** The creation transaction, base64, with the mint key's signature; the Creator wallet signs it next. */
  transaction: z.string(),
  /** After this block height the transaction can no longer land, and the launch must be prepared again. */
  lastValidBlockHeight: RawAmount,
  /** What the Creator wallet pays, in lamports, as simulated: the pool's and the coin record's rent and the fees. */
  cost: RawAmount,
});
export type PreparedLaunch = z.infer<typeof PreparedLaunch>;

/** `POST /launches/:id/submit`: the creation transaction, base64, once the Creator wallet has signed it. */
export const SubmitLaunch = z.object({ transaction: z.string().max(4096) });
export type SubmitLaunch = z.infer<typeof SubmitLaunch>;

/** `GET /launches/:id` and the answer to a submit: where the launch stands. */
export const LaunchStatus = z.object({
  id: z.uuid(),
  status: z.enum(["prepared", "sending", "landed", "failed", "expired"]),
  name: z.string(),
  ticker: z.string(),
  mint: Address,
  pool: Address,
  coinRecord: Address,
  metadataUri: z.string().url(),
  imageUri: z.string().url(),
  /** The creation transaction's signature, once submitted. */
  signature: z.string().nullable(),
  error: z.string().nullable(),
  explorer: z.object({ transaction: z.string().url().nullable(), mint: z.string().url() }),
});
export type LaunchStatus = z.infer<typeof LaunchStatus>;
