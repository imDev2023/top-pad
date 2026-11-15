import { z } from "zod";
import { CoinFinding } from "./bar";
import { Decimal } from "./coin";
import { CreatorSummary } from "./creatorSummary";
import { Signature } from "./earnings";
import { Address, RawAmount } from "./launch";
import { QuoteInfo } from "./quote";

// The Fairness card (spec 9, #58): what is proven on chain about a Heat coin, what is labelled and what was found, row by
// row, in the race marshal's flags. The coin page shows it as a strip of flags above the chart with the whole card a
// tap away, and its image is the coin's link card on X.

/**
 * A row's flag (spec 9): green proven on chain, yellow labelled, red a Bundle Radar finding, checkered at Graduation
 * (proven on chain too, so counted green), and neutral for a row that is told openly but neither proves nor labels
 * anything, such as the creator's record or the Instant launch's tax that went to Heat.
 */
export const FairnessFlag = z.enum(["green", "yellow", "red", "checkered", "neutral"]);
export type FairnessFlag = z.infer<typeof FairnessFlag>;

/** The card's rows, in the spec's order: a row the coin has no use for (a Creator lock in an Instant launch) is left out. */
export const FairnessRowKey = z.enum(["finding", "launch", "creator_lock", "holdings", "liquidity", "radar", "creator", "keeper", "tax"]);
export type FairnessRowKey = z.infer<typeof FairnessRowKey>;

/** A link a row gives to check it: an explorer address or transaction, or a page of Heat's (a path). */
export const FairnessLink = z.object({ label: z.string(), href: z.string() });
export type FairnessLink = z.infer<typeof FairnessLink>;

export const FairnessRow = z.object({
  key: FairnessRowKey,
  flag: FairnessFlag,
  /** What the row is about: "Launch", "Creator lock". */
  title: z.string(),
  /** The flag's own words in the strip and on the image, a few words. */
  short: z.string(),
  /** What the row states. */
  value: z.string(),
  /** How it is known, or what follows from it. */
  detail: z.string(),
  links: z.array(FairnessLink),
});
export type FairnessRow = z.infer<typeof FairnessRow>;

/**
 * The facts each row is worded from, raw, so anyone can check them against the chain and Heat's indexed rows: amounts
 * in raw units (the coin's or its quote's), prices unscaled, as everywhere in the API.
 */
export const FairnessFacts = z.object({
  launch: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("fair_open"),
      launch: Address,
      /** The seats the open filled: one a person, by Fair Open admission (spec 6.3). */
      people: z.number().int().nonnegative(),
      /** What the pot spent in the open, in the quote, and the coins it bought: one price for every seat. */
      spent: RawAmount,
      coins: RawAmount,
      /** The quote a whole coin cost in the open, unscaled. */
      price: Decimal,
      /** The SHA-256 the coin's name, ticker and metadata URI were sealed behind, hex: the open checked the coin against it. */
      identityHash: z.string().regex(/^[0-9a-f]{64}$/),
      opened: Signature,
    }),
    z.object({
      mode: z.literal("instant"),
      creation: Signature,
      /** What the coin's creation transaction bought, in coins: 0, since an Instant launch has no creator buy (ADR 0004). */
      creationBuy: RawAmount,
    }),
  ]),
  /** A Fair Open's Creator lock (spec 2.1 step 13); null for an Instant launch. */
  creatorLock: z
    .object({
      status: z.enum(["locked", "pending", "none"]),
      deposit: RawAmount.nullable(),
      coins: RawAmount.nullable(),
      escrow: Address.nullable(),
      cliffAt: z.iso.datetime().nullable(),
      endsAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  holdings: z.object({
    /** The Creator wallet that launched the coin. */
    wallet: Address,
    /** What it holds of the coin now, outside the Creator lock, read from the chain; null when the chain could not be read. */
    coins: RawAmount.nullable(),
    /** What it bought of the coin on its pool since the open. */
    bought: RawAmount,
  }),
  liquidity: z.object({
    curve: Address,
    /** After Graduation: the DAMM v2 pool and its two permanently locked positions. */
    graduated: z.object({ at: z.iso.datetime(), pool: Address, creatorPosition: Address, heatPosition: Address }).nullable(),
  }),
  /** Bundle Radar's summary (spec 6.4): wallets directly linked to the Creator wallet and what they bought, and creation-slot buys. */
  radar: z.object({ linkedWallets: z.number().int().nonnegative(), linkedCoins: RawAmount, earlyBuys: z.number().int().nonnegative() }),
  finding: CoinFinding.nullable(),
  record: CreatorSummary.nullable(),
  /** The Heat keeper that sent a Fair Open's open, the pot's buy, as its fee payer; null for an Instant launch. */
  keeper: z.object({ address: Address, signature: Signature }).nullable(),
  tax: z.discriminatedUnion("to", [
    /** A Fair Open's Tax Share (spec 2.1 step 14): null until collected; `toTreasury` when no seat but the creator's could share it. */
    z.object({
      to: z.literal("depositors"),
      collected: z
        .object({ total: RawAmount, paidSeats: z.number().int().nonnegative(), toTreasury: z.boolean(), at: z.iso.datetime(), signature: Signature })
        .nullable(),
    }),
    /** An Instant launch's window claim (spec 2.2): the first minute's tax, which goes to Heat; null until claimed. */
    z.object({ to: z.literal("heat"), claimed: z.object({ amount: RawAmount, at: z.iso.datetime(), signature: Signature }).nullable() }),
  ]),
});
export type FairnessFacts = z.infer<typeof FairnessFacts>;

/** `GET /coins/:mint/fairness`: a Heat coin's Fairness card. 404 for a pool our launch key never co-signed, which has none. */
export const FairnessCard = z.object({
  mint: Address,
  name: z.string(),
  ticker: z.string(),
  imageUri: z.string().url().nullable(),
  launchMode: z.enum(["instant", "fair_open"]),
  quote: QuoteInfo,
  /** Green counts checkered rows too. */
  counts: z.object({ green: z.number().int().nonnegative(), yellow: z.number().int().nonnegative(), red: z.number().int().nonnegative() }),
  /** Red rows first, then the spec's order. */
  rows: z.array(FairnessRow),
  facts: FairnessFacts,
  /** A hash of what the card says, which names its image: a new version is a new image URL, so X fetches it afresh. */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  /** The card as a PNG for X's large link card (2:1, under 5 MB), at this version. */
  image: z.string().url(),
  servedAt: z.iso.datetime(),
});
export type FairnessCard = z.infer<typeof FairnessCard>;

/** The counts as the card opens with them (spec 9): any red count first. */
export function countsInOrder(counts: FairnessCard["counts"]): { flag: "green" | "yellow" | "red"; count: number }[] {
  const all = [
    { flag: "green" as const, count: counts.green },
    { flag: "yellow" as const, count: counts.yellow },
    { flag: "red" as const, count: counts.red },
  ];
  return counts.red > 0 ? [all[2]!, all[0]!, all[1]!] : all;
}
