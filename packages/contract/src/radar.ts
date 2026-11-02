import { z } from "zod";
import { Signature } from "./earnings";
import { Address, RawAmount } from "./launch";

/**
 * Bundle Radar's labels (spec 6.4, 6.5). `same_slot` (a buy in the creation slot) is timing alone and only ever labels.
 * The others are direct links to the Creator wallet: a buy in the four positions right after the creation transaction,
 * or in its Jito bundle (mainnet only); a buy or deposit the Creator wallet signed or paid for; and SOL or coins passed
 * directly with the Creator wallet in the 7 days before the open or after it.
 */
export const RadarLabel = z.enum(["same_slot", "after_creation", "jito_bundle", "creator_signed", "creator_funded"]);
export type RadarLabel = z.infer<typeof RadarLabel>;

const Explorer = z.string().url();

/** A buy Bundle Radar shows, with what it paid. Amounts are raw units, the quote before the fee. */
export const RadarBuy = z.object({
  signature: Signature,
  /** Its place among its transaction's swaps. */
  eventIndex: z.number().int().nonnegative(),
  explorer: Explorer,
  slot: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  /** Its transaction's place after the creation transaction, in the creation slot (1 is right after it); else null. */
  position: z.number().int().positive().nullable(),
  /** The Jito bundle it landed in (mainnet only). */
  jitoBundle: z.string().nullable(),
  quoteAmount: RawAmount,
  baseAmount: RawAmount,
  fee: RawAmount,
  /** Whether it ran in the coin's first hour, which the case floor counts (spec 6.5). */
  firstHour: z.boolean(),
  labels: z.array(RadarLabel),
});
export type RadarBuy = z.infer<typeof RadarBuy>;

/** A direct transfer between a wallet and the Creator wallet: `SOL` or a token's mint, in raw units. */
export const RadarTransfer = z.object({
  signature: Signature,
  explorer: Explorer,
  at: z.iso.datetime(),
  direction: z.enum(["from_creator", "to_creator"]),
  asset: z.string(),
  amount: RawAmount,
});
export type RadarTransfer = z.infer<typeof RadarTransfer>;

/** A deposit into the coin's Fair Open pot by a linked wallet. */
export const RadarDeposit = z.object({ signature: Signature, explorer: Explorer, at: z.iso.datetime(), amount: RawAmount, creatorSigned: z.boolean() });
export type RadarDeposit = z.infer<typeof RadarDeposit>;

export const RadarWallet = z.object({
  wallet: Address,
  explorer: Explorer,
  /** The Creator wallet itself: its open buys are labelled, never counted toward a case. */
  creator: z.boolean(),
  /** Directly linked to the Creator wallet: a red flag (spec 9), which a case can be opened on. */
  linked: z.boolean(),
  labels: z.array(RadarLabel),
  /** What it bought across the pot and the first hour, in raw units: what a linked wallet adds toward the floor. */
  counted: RawAmount,
  /** The coins its seat in the coin's Fair Open bought. */
  potCoins: RawAmount,
  /** A linked wallet's buys in the 7 days after the open; any other wallet's labelled buys. */
  buys: z.array(RadarBuy),
  deposits: z.array(RadarDeposit),
  transfers: z.array(RadarTransfer),
});
export type RadarWallet = z.infer<typeof RadarWallet>;

/**
 * `GET /coins/:mint/radar`: what Bundle Radar labels on a Heat coin, each label with its evidence (spec 6.4). Labels
 * never move a coin's ranking (spec 8). 404 for a pool our launch key never co-signed.
 */
export const BundleRadar = z.object({
  mint: Address,
  creatorWallet: Address,
  creatorExplorer: Explorer,
  /** When trading opened: the first hour and the funding window count from here. */
  openedAt: z.iso.datetime(),
  creation: z.object({
    signature: Signature,
    explorer: Explorer,
    slot: z.number().int().nonnegative(),
    /** Its place in its block, once known. */
    blockIndex: z.number().int().nonnegative().nullable(),
    jitoBundle: z.string().nullable(),
  }),
  /** Whether Jito's bundles are read here: on mainnet only, since Jito runs no devnet block engine. */
  jito: z.boolean(),
  supply: RawAmount,
  /** A case needs linked wallets to have bought this much between them, across the pot and the first hour. */
  floor: RawAmount,
  linked: z.object({ wallets: z.number().int().nonnegative(), coins: RawAmount }),
  /** Linked wallets first, most counted first; then the labelled ones. */
  wallets: z.array(RadarWallet),
  servedAt: z.iso.datetime(),
});
export type BundleRadar = z.infer<typeof BundleRadar>;
