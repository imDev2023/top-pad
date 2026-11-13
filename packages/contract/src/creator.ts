import { z } from "zod";
import { CreatorRef, CreatorSummary } from "./creatorSummary";
import { CreatorLock } from "./fairOpen";
import { Address, RawAmount } from "./launch";
import { QuoteInfo } from "./quote";
import { LooksLike } from "./vampShield";

// The Creator record (spec 7; spec 9, screen 5): each creator's public record, keyed by its Creator wallet with an X
// account linked or not (ADR 0008), built only from facts anyone can recompute from the chain and Heat's database, with
// no composite score. Its Creator wallet changes by a handover both wallets sign, or for a lost wallet by a rotation
// through the record's X account after a public 7-day cooldown that the current Creator wallet can cancel.

const Explorer = z.string().url();
const Signature = z.string().min(64).max(100);

/** A handover or a rotation of a record's Creator wallet, with the signatures behind it, so anyone can check them again. */
export const WalletChange = z.object({
  id: z.uuid(),
  kind: z.enum(["handover", "rotation"]),
  /**
   * `pending`: a handover offered and not yet taken, or a rotation in its cooldown; `void`: its new wallet became another
   * record's Creator wallet first.
   */
  status: z.enum(["pending", "completed", "cancelled", "expired", "void"]),
  from: Address,
  to: Address,
  /** The message both wallets sign for a handover, or the new wallet for a rotation. */
  message: z.string(),
  /** Each wallet's ed25519 signature over the message, base58. */
  fromSignature: Signature.nullable(),
  toSignature: Signature.nullable(),
  /** The X account a rotation went through, by its handle when it asked. */
  xHandle: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  /** When a handover's offer lapses untaken. */
  expiresAt: z.iso.datetime().nullable(),
  /** When a rotation takes effect unless the current Creator wallet cancels it. */
  effectiveAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  /** The current Creator wallet's cancellation: the message it signed and its signature, base58. */
  cancelMessage: z.string().nullable(),
  cancelSignature: Signature.nullable(),
});
export type WalletChange = z.infer<typeof WalletChange>;

/** One of a record's Creator wallets over time, and how it became one. */
export const RecordWallet = z.object({
  wallet: Address,
  explorer: Explorer,
  via: z.enum(["sign_in", "first_launch", "handover", "rotation"]),
  from: z.iso.datetime(),
  until: z.iso.datetime().nullable(),
  /**
   * The wallet's own signature proving it: over `message` when it signed a message (its sign-in, a handover or a
   * rotation), else on the transaction of its first launch, which `explorer` shows.
   */
  proof: z.object({ signature: z.string(), message: z.string().nullable(), explorer: Explorer.nullable() }),
  /** The handover or rotation that made it the Creator wallet. */
  change: z.uuid().nullable(),
});
export type RecordWallet = z.infer<typeof RecordWallet>;

/** One of the coins a record launched: it stays on the record whoever holds its creator role (spec 7). */
export const RecordCoin = z.object({
  mint: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().url().nullable(),
  launchMode: z.enum(["instant", "fair_open"]),
  launchedAt: z.iso.datetime(),
  looksLike: z.array(LooksLike),
  quote: QuoteInfo,
  /** `quiet`: never graduated, and no trade for 7 days. */
  state: z.enum(["trading", "graduated", "quiet"]),
  graduatedAt: z.iso.datetime().nullable(),
  lastTradeAt: z.iso.datetime().nullable(),
  /** A Fair Open's Creator lock (spec 2.1 step 13); null for an Instant launch, which has none. */
  lock: CreatorLock.nullable(),
  /** The coin's sells from any of the record's Creator wallets: the coins sold, and the quote they fetched before the fee. */
  sells: z.object({ count: z.number().int().nonnegative(), coins: RawAmount, quote: RawAmount }),
  /** Its DBC creator role, which Creator Earnings follow. */
  role: z.object({
    holder: Address,
    /** Held by a wallet that is not one of the record's Creator wallets. */
    handedOver: z.boolean(),
    /** The record whose Creator wallet holds it, when it is another's. */
    record: CreatorRef.nullable(),
    /** The latest hand-over, when it moved. */
    at: z.iso.datetime().nullable(),
    explorer: Explorer.nullable(),
  }),
  /** Bundle Radar's wallets on the coin (spec 6.4): linked to the Creator wallet (red), and labelled only (yellow). */
  radar: z.object({ linked: z.number().int().nonnegative(), labelled: z.number().int().nonnegative() }),
});
export type RecordCoin = z.infer<typeof RecordCoin>;

/** A coin another record launched whose creator role one of this record's Creator wallets holds: handed over to it. */
export const ReceivedCoin = z.object({
  mint: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().url().nullable(),
  /** Its launcher's record, on which it stays. */
  launcher: CreatorRef.nullable(),
  holder: Address,
  at: z.iso.datetime(),
  explorer: Explorer,
});
export type ReceivedCoin = z.infer<typeof ReceivedCoin>;

/** `GET /creators/:key`: a record, by its id or by any wallet that is or was its Creator wallet. */
export const CreatorRecord = z.object({
  summary: CreatorSummary,
  /** Oldest first. */
  wallets: z.array(RecordWallet),
  /** Newest first, a pending one among them. */
  changes: z.array(WalletChange),
  /** Launches by mode: Instant coins, and Fair Opens opened, failed and still scheduled. */
  launches: z.object({
    instant: z.number().int().nonnegative(),
    fairOpen: z.object({ opened: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), scheduled: z.number().int().nonnegative() }),
  }),
  /** Newest first. */
  coins: z.array(RecordCoin),
  received: z.array(ReceivedCoin),
  /**
   * What every Creator Earnings claim paid the record's Creator wallets, curve fees and LP fees, by quote, in its raw
   * units: SOL always, first, then every other quote a claim paid in, in the order the cluster lists them.
   */
  earnings: z.array(z.object({ quote: QuoteInfo, claimed: RawAmount, curve: RawAmount, lp: RawAmount })).min(1),
  servedAt: z.iso.datetime(),
});
export type CreatorRecord = z.infer<typeof CreatorRecord>;

/** A message Heat gives a wallet to sign for a change of Creator wallet, taken once before it expires. */
export const WalletChangeMessage = z.object({
  message: z.string(),
  /** When a handover's offer lapses, or the message may no longer be signed. */
  expiresAt: z.iso.datetime(),
  /** The wallet asked to sign it: a handover's old wallet, a rotation's new one, or a cancellation's current Creator wallet. */
  wallet: Address,
});
export type WalletChangeMessage = z.infer<typeof WalletChangeMessage>;

/** `POST /creators/handover/message`: the current Creator wallet offers its record to another wallet. */
export const HandoverRequest = z.object({ from: Address, to: Address });
export type HandoverRequest = z.infer<typeof HandoverRequest>;

/** `POST /creators/rotation/message`: a lost wallet's record, signed in through its X account, names its new wallet. */
export const RotationRequest = z.object({ to: Address });
export type RotationRequest = z.infer<typeof RotationRequest>;

/** A message as the wallet signed it, and its ed25519 signature, base64. */
export const SignedWalletMessage = z.object({ wallet: Address, message: z.string().max(2_000), signature: z.string().max(200) });
export type SignedWalletMessage = z.infer<typeof SignedWalletMessage>;

/** `POST /creators/changes/:id/accept`: the new wallet's signature over the handover's message, base64. */
export const HandoverAcceptance = z.object({ signature: z.string().max(200) });
export type HandoverAcceptance = z.infer<typeof HandoverAcceptance>;

/** A change offered to a wallet, with the record it would join. */
export const HandoverOffer = z.object({ change: WalletChange, record: CreatorRef });
export type HandoverOffer = z.infer<typeof HandoverOffer>;

/** `GET /creators/offers/:wallet`: the handovers offered to a wallet and not yet taken. */
export const HandoverOffers = z.object({ offers: z.array(HandoverOffer) });
export type HandoverOffers = z.infer<typeof HandoverOffers>;

export const WalletChangeRefusal = z.object({
  error: z.string(),
  code: z.enum(["invalid", "expired", "not_found", "not_the_creator_wallet", "wallet_taken", "pending", "no_x", "x_not_recent", "not_signed_in"]),
});
export type WalletChangeRefusal = z.infer<typeof WalletChangeRefusal>;

/** `POST /coins/:mint/creator-role`: the wallet holding a coin's creator role hands it to another. */
export const CreatorRoleRequest = z.object({ holder: Address, to: Address });
export type CreatorRoleRequest = z.infer<typeof CreatorRoleRequest>;

/** The hand-over's transaction, unsigned, base64, the holder paying its network fee. */
export const PreparedCreatorRole = z.object({ transaction: z.string() });
export type PreparedCreatorRole = z.infer<typeof PreparedCreatorRole>;

/** `POST /coins/:mint/creator-role/sent`: the hand-over's signature once the wallet sent it. */
export const CreatorRoleSent = z.object({ signature: z.string().min(64).max(100) });
export type CreatorRoleSent = z.infer<typeof CreatorRoleSent>;

export const CreatorRoleOutcome = z.object({
  status: z.enum(["landed", "failed", "pending"]),
  error: z.string().nullable(),
  explorer: Explorer,
});
export type CreatorRoleOutcome = z.infer<typeof CreatorRoleOutcome>;
