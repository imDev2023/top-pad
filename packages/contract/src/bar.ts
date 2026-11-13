import { z } from "zod";
import { Address, RawAmount } from "./launch";
import { RadarWallet } from "./radar";

// Bars (spec 6.5, 6.6, 7; #56). An operator confirms a bundling case and the Bar applies at once: Heat's launch key
// co-signs no launch for the Creator record, its Creator wallet or its linked X account, and the creator's Fair Opens not
// yet in their window are cancelled. The finding stays private to the creator for 72 hours, on their record with a reply
// box, then shows on the record, the coin's page and its Fairness card. One appeal within 30 days, decided in 48 hours by
// another operator; another only with new evidence. An upheld appeal lifts the Bar and takes the finding off every
// public page; the audit log keeps it. A Bar never expires and only stops new launches.

/** How long a confirmed finding stays private to the creator before it is published. */
export const PRIVATE_WINDOW_MS = 72 * 3_600_000;
/** How long after the Bar its first appeal may be filed. */
export const APPEAL_WINDOW_MS = 30 * 24 * 3_600_000;
/** How soon an operator aims to decide an appeal. */
export const APPEAL_DECISION_MS = 48 * 3_600_000;
/** The longest reply, appeal statement or evidence a creator may write. */
export const BAR_TEXT_MAX = 2_000;

const Explorer = z.string().url();

/** The grounds spec 6.5 names for an appeal: a link is wrong. */
export const AppealGrounds = z.enum(["shared_exchange", "launch_service", "other"]);
export type AppealGrounds = z.infer<typeof AppealGrounds>;

/** The coin a confirmed bundle was in. */
export const BarCoin = z.object({ mint: Address, name: z.string(), ticker: z.string(), imageUri: z.string().url().nullable() });
export type BarCoin = z.infer<typeof BarCoin>;

/**
 * The evidence pack of the confirmed case (spec 6.5), as Bundle Radar wrote it when the case opened: the coin's creation,
 * the floor and what counted toward it, and each wallet directly linked to the Creator wallet with the buys, deposits and
 * transfers behind its links, every one linked on the explorer.
 */
export const BarEvidence = z.object({
  reviewedAt: z.iso.datetime(),
  rule: z.string(),
  creatorWallet: Address,
  creation: z.object({ signature: z.string(), explorer: Explorer, slot: z.number().int().nonnegative(), blockIndex: z.number().int().nonnegative().nullable() }),
  floor: z.object({ supply: RawAmount, floor: RawAmount, linkedCoins: RawAmount, share: z.string() }),
  wallets: z.array(RadarWallet),
});
export type BarEvidence = z.infer<typeof BarEvidence>;

/** Where an appeal against a Bar stands, as the public record says it. */
export const AppealStatus = z.enum(["none", "open", "denied"]);
export type AppealStatus = z.infer<typeof AppealStatus>;

/**
 * A published finding (spec 6.5): "Barred: confirmed creator bundle in <coin>, <date>", with the evidence and where the
 * appeal stands. Only Bars past their private window and never lifted.
 */
export const PublicBar = z.object({
  coin: BarCoin,
  confirmedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  appeal: z.object({ status: AppealStatus, filedAt: z.iso.datetime().nullable(), decidedAt: z.iso.datetime().nullable() }),
  evidence: BarEvidence,
});
export type PublicBar = z.infer<typeof PublicBar>;

/** "Confirmed creator bundle" on a coin's page and its Fairness card, once the finding is published. */
export const CoinFinding = z.object({
  kind: z.literal("confirmed_creator_bundle"),
  confirmedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  appeal: AppealStatus,
});
export type CoinFinding = z.infer<typeof CoinFinding>;

export const BarAppeal = z.object({
  id: z.uuid(),
  grounds: AppealGrounds,
  statement: z.string(),
  evidence: z.string().nullable(),
  status: z.enum(["open", "upheld", "denied"]),
  filedAt: z.iso.datetime(),
  /** When an operator should have decided it by: 48 hours after it was filed. */
  dueAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  /** The operator's reason, given to the creator with the decision. */
  decision: z.string().nullable(),
});
export type BarAppeal = z.infer<typeof BarAppeal>;

export const BarReply = z.object({ id: z.uuid(), body: z.string(), at: z.iso.datetime() });
export type BarReply = z.infer<typeof BarReply>;

/**
 * A Bar as its creator sees it on their record (spec 6.5, 9 screen 5), private until `publishAt`: the evidence pack, what
 * they replied, their appeals, and what they may still do. Lifted Bars stay listed for them.
 */
export const PrivateBar = z.object({
  id: z.uuid(),
  coin: BarCoin,
  confirmedAt: z.iso.datetime(),
  publishAt: z.iso.datetime(),
  /** Past its private window: the record, the coin's page and its Fairness card show it. */
  published: z.boolean(),
  /** Lifted by an upheld appeal: the launch key co-signs again and no public page shows it. */
  liftedAt: z.iso.datetime().nullable(),
  /** The X direct message Heat sent about it, when the record linked X. */
  message: z.object({ sentAt: z.iso.datetime().nullable() }).nullable(),
  evidence: BarEvidence,
  replies: z.array(BarReply),
  /** Oldest first. */
  appeals: z.array(BarAppeal),
  /**
   * Whether the creator may appeal now, and with what: `first` within 30 days of the Bar, `new_evidence` once the last
   * appeal was denied, or null (an appeal waits, the Bar is lifted, or the 30 days have passed with none filed).
   */
  canAppeal: z.enum(["first", "new_evidence"]).nullable(),
  /** The last day a first appeal may be filed. */
  appealBy: z.iso.datetime(),
});
export type PrivateBar = z.infer<typeof PrivateBar>;

/** `GET /creators/:key/bars`: every Bar of the record, for its own signed-in creator only. */
export const PrivateBars = z.object({ bars: z.array(PrivateBar) });
export type PrivateBars = z.infer<typeof PrivateBars>;

/** `POST /bars/:id/replies`. */
export const BarReplyRequest = z.object({ body: z.string().trim().min(1).max(BAR_TEXT_MAX) });
export type BarReplyRequest = z.infer<typeof BarReplyRequest>;

/** `POST /bars/:id/appeals`: `evidence` is required for an appeal after a denied one, and must be new. */
export const BarAppealRequest = z.object({
  grounds: AppealGrounds,
  statement: z.string().trim().min(1).max(BAR_TEXT_MAX),
  evidence: z.string().trim().max(BAR_TEXT_MAX).optional(),
});
export type BarAppealRequest = z.infer<typeof BarAppealRequest>;

/**
 * `GET /enforcement`: the counts "How this is enforced" publishes (spec 6.5, 9 screen 6): findings confirmed and past
 * their private window or overturned, the appeals filed against them, and the findings overturned on appeal.
 */
export const EnforcementCounts = z.object({
  bars: z.number().int().nonnegative(),
  appeals: z.number().int().nonnegative(),
  overturned: z.number().int().nonnegative(),
  servedAt: z.iso.datetime(),
});
export type EnforcementCounts = z.infer<typeof EnforcementCounts>;

/** When a Bar's finding is published: 72 hours after the confirmation. */
export const publishAtOf = (confirmedAt: Date) => new Date(confirmedAt.getTime() + PRIVATE_WINDOW_MS);
