import { z } from "zod";
import { ApiError, Cluster } from "./health";
import { FieldVerdict, VampShieldVerdict } from "./vampShield";

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
  /** Whether a coin can be launched here now, by mode. */
  launchModes: z.object({ instant: z.boolean(), fairOpen: z.boolean() }),
  /** A Fair Open's fixed terms here (spec 2.1 step 4, 12), or null where Heat runs none; its pot's cap is its quote's. */
  fairOpen: z
    .object({
      windowSeconds: z.number().int().positive(),
      /** How far ahead a window may start. */
      maxAheadSeconds: z.number().int().positive(),
      teaserMaxLength: z.number().int().positive(),
    })
    .nullable(),
  /** The largest coin image the launch service takes, in bytes. */
  maxImageBytes: z.number().int().positive(),
  /** The image types it takes. */
  imageTypes: z.array(z.string()),
});
export type Platform = z.infer<typeof Platform>;

/**
 * `GET /me`: the Creator this browser is signed in as (spec 7, ADR 0008), by its wallet or by the X account it linked;
 * `null` when it is signed in neither way, an answer rather than an error, so a first visit logs nothing in the browser's
 * console.
 */
export const Me = z.object({
  /** The X account linked to the record, which shows on it and in its coins' metadata; null when none is. */
  x: z.object({ handle: z.string(), name: z.string(), avatarUrl: z.string().url().nullable() }).nullable(),
  /** The wallet this browser signed in with; null for a browser signed in by linking X. */
  wallet: Address.nullable(),
  /** The record's Creator wallet; null only for a record that linked X and has had no wallet sign in or launch yet. */
  creatorWallet: Address.nullable(),
  launches: z.number().int().nonnegative(),
});
export type Me = z.infer<typeof Me>;

/**
 * Why the launch service refused a launch, for the launch flow to show (an `ApiError` with a code). Every refusal is
 * our launch key declining to co-sign: nothing on chain refuses a launch (spec 6.2).
 */
export const LaunchRefusal = ApiError.extend({
  code: z.enum([
    "signed_out",
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
    "ticker_reserved",
    "quote",
    "teaser",
    "schedule",
    "barred",
  ]),
  /** The text's verdict, when Vamp Shield refused the ticker or the name. */
  verdict: VampShieldVerdict.optional(),
  /** The image's verdict, when Vamp Shield refused it or could not check it, and the hash of the image it judged. */
  imageVerdict: FieldVerdict.optional(),
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type LaunchRefusal = z.infer<typeof LaunchRefusal>;

/** Unix seconds, as a decimal string. */
export const UnixSeconds = z.string().regex(/^\d{1,12}$/);

/**
 * `POST /launches`, a multipart form with `mode`, `name`, `ticker`, `wallet`, the `quote` mint the coin is priced in (one
 * `GET /quotes` offers; SOL's wrapped mint when left out) and the `image` file, and for a Fair Open its schedule (spec
 * 2.1 step 4): when its window starts, its minimum raise in the quote's raw units, and the calendar's teaser.
 */
export const LaunchForm = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("instant"), name: z.string().max(256), ticker: z.string().max(64), wallet: Address, quote: Address }),
  z.object({
    mode: z.literal("fair_open"),
    name: z.string().max(256),
    ticker: z.string().max(64),
    wallet: Address,
    quote: Address,
    depositsOpenAt: UnixSeconds,
    minRaise: RawAmount,
    teaser: z.string().max(1024),
  }),
]);
export type LaunchForm = z.infer<typeof LaunchForm>;

/** A rung of a Fair Open's ladder: what the pot spends on it, and its creation transaction, base64. */
export const LadderRung = z.object({ rung: RawAmount, transaction: z.string() });
export type LadderRung = z.infer<typeof LadderRung>;

/** What the Creator wallet signs next, and what it pays. */
export const PreparedLaunch = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("instant"),
    id: z.uuid(),
    mint: Address,
    pool: Address,
    /** The creation transaction, base64, with the mint key's signature; the Creator wallet signs it next. */
    transaction: z.string(),
    /** After this block height the transaction can no longer land, and the launch must be prepared again. */
    lastValidBlockHeight: RawAmount,
    /** What the Creator wallet pays, in lamports, as simulated: the pool's and the coin record's rent and the fees. */
    cost: RawAmount,
  }),
  z.object({
    mode: z.literal("fair_open"),
    id: z.uuid(),
    /** The launch's account, at the PDA of its durable nonce: its Fair Open page's address. */
    launch: Address,
    nonce: Address,
    /** The schedule, base64: the Creator wallet signs it, and the launch key co-signs it last and sends it. */
    transaction: z.string(),
    lastValidBlockHeight: RawAmount,
    /**
     * The ladder (ADR 0005): the coin's creation transaction for each rung, largest first, on the launch's durable nonce
     * and signed by the coin's mint key. The Creator wallet signs all of them with the schedule, in one approval, or,
     * if it cannot, only the rung the pot covers, at the open.
     */
    rungs: z.array(LadderRung),
    /** What the schedule costs the Creator wallet, in lamports, as simulated: rent, most of it returned, and the fee. */
    cost: RawAmount,
    depositsOpenAt: z.iso.datetime(),
    opensAt: z.iso.datetime(),
  }),
]);
export type PreparedLaunch = z.infer<typeof PreparedLaunch>;

/**
 * `POST /launches/:id/submit`: the transaction, base64, once the Creator wallet has signed it, and for a Fair Open the
 * ladder's rungs it signed with it, in the order prepared, or null when it signs the open at the open instead.
 */
export const SubmitLaunch = z.object({ transaction: z.string().max(4096), rungs: z.array(z.string().max(4096)).max(64).nullable().optional() });
export type SubmitLaunch = z.infer<typeof SubmitLaunch>;

/** `GET /launches/:id` and the answer to a submit: where the launch stands. */
export const LaunchStatus = z.object({
  id: z.uuid(),
  mode: z.enum(["instant", "fair_open"]),
  status: z.enum(["prepared", "sending", "landed", "failed", "expired"]),
  name: z.string(),
  ticker: z.string(),
  mint: Address,
  pool: Address,
  coinRecord: Address,
  /** The mint the coin is priced in (ADR 0007). */
  quoteMint: Address,
  metadataUri: z.string().url(),
  imageUri: z.string().url(),
  /** The creation transaction's signature, once submitted. */
  signature: z.string().nullable(),
  error: z.string().nullable(),
  explorer: z.object({ transaction: z.string().url().nullable(), mint: z.string().url() }),
  /** A Fair Open's schedule: its page's address, its window, and how its open is signed. */
  fairOpen: z
    .object({
      launch: Address,
      depositsOpenAt: z.iso.datetime(),
      opensAt: z.iso.datetime(),
      minRaise: RawAmount,
      teaser: z.string().nullable(),
      ladder: z.enum(["signed", "at_open"]),
    })
    .nullable(),
});
export type LaunchStatus = z.infer<typeof LaunchStatus>;
