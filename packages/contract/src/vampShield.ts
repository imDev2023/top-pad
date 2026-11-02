import { z } from "zod";

// Vamp Shield (spec 6.2): its verdicts on a launch's ticker, name and image, the "looks like X" labels a near one launches
// with, and a creator's appeal against a refusal.

/** Why a coin is protected: Jupiter-verified, organic activity, trending now, CoinGecko's top 1,000, or a Heat coin. */
export const ProtectedSource = z.enum(["jupiter_verified", "organic", "trending", "coingecko_top", "heat"]);
export type ProtectedSource = z.infer<typeof ProtectedSource>;

/** A Protected coin a launch was found to copy, or to be near. */
export const ProtectedMatch = z.object({
  /** Its mint on Solana, or its id at the source for a coin on another chain (CoinGecko's). */
  mint: z.string(),
  ticker: z.string(),
  name: z.string(),
  source: ProtectedSource,
  /** Where to see the coin: its page on Heat, Jupiter or CoinGecko. */
  url: z.string().url(),
  /** Its image as its source names it, to set beside the creator's; null when it has none. */
  imageUrl: z.string().url().nullable(),
});
export type ProtectedMatch = z.infer<typeof ProtectedMatch>;

/**
 * Vamp Shield's verdict on one part of a launch: clear; "looks like" a Protected coin, which launches with that label on
 * its page; or refused, with the reason the creator reads.
 */
export const FieldVerdict = z.object({
  status: z.enum(["clear", "looks_like", "refused"]),
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
  /** Whether nothing refuses the launch: a "looks like" verdict still launches. */
  clear: z.boolean(),
});
export type VampShieldVerdict = z.infer<typeof VampShieldVerdict>;

/**
 * `POST /vamp-shield/image`, a multipart form with the `image` file: Vamp Shield's verdict on a coin's image against every
 * Protected coin's (PDQ in all 8 orientations and SSCD, spec 6.2), and how long the vision service took to give it.
 */
export const ImageVerdict = z.object({
  /** The SHA-256 of the image's bytes, hex: a launch or an appeal with the same image is judged by the same check. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: FieldVerdict,
  /** How long the vision service took, in milliseconds; null when the image was checked before. */
  answerMs: z.number().int().nonnegative().nullable(),
  /** Whether the vision service was asleep and had to wake for it; null when the image was checked before. */
  woke: z.boolean().nullable(),
});
export type ImageVerdict = z.infer<typeof ImageVerdict>;

/** A "looks like X" label (spec 6.2): what a launch was near when it was prepared, shown on its coin rows and page. */
export const LooksLike = z.object({
  /** What was near: the ticker, the name or the image. */
  field: z.enum(["ticker", "name", "image"]),
  coin: ProtectedMatch,
  /** The label: "Looks like $BONK". */
  label: z.string(),
  /** Why, for a trader: "Its ticker is $BONK's with a word such as BABY or INU added." */
  reason: z.string(),
});
export type LooksLike = z.infer<typeof LooksLike>;

/** `POST /vamp-shield/appeals`: a creator's appeal against a refusal, for the operator queue (spec 6.6). */
export const VampAppealForm = z.object({
  ticker: z.string().max(64),
  name: z.string().max(256),
  /** The image's SHA-256 from its check, when the image was refused. */
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** The coin the creator says is the original, theirs, or not the one matched: a mint, or a link to it. */
  original: z.string().max(200).nullable(),
  message: z.string().min(1).max(2000),
});
export type VampAppealForm = z.infer<typeof VampAppealForm>;

export const VampAppeal = z.object({
  id: z.uuid(),
  ticker: z.string(),
  name: z.string(),
  imageSha256: z.string().nullable(),
  original: z.string().nullable(),
  message: z.string(),
  status: z.enum(["open", "upheld", "denied"]),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type VampAppeal = z.infer<typeof VampAppeal>;

/** `GET /vamp-shield/appeals`: the signed-in creator's appeals, newest first. */
export const VampAppeals = z.object({ appeals: z.array(VampAppeal) });
export type VampAppeals = z.infer<typeof VampAppeals>;
