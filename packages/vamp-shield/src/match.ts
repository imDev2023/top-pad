// A launch's ticker and name against the Protected coins (spec 6.2): any exact key match refuses the launch, with a
// reason for the launch form. Near matches, which launch with a "looks like X" label (one edit on a key of 5 or more,
// a derivative word such as BABY), come in a later ticket as more rules beside these.
import { foldKeys, MIN_CORE, type Field, type KeyKind, type Keys } from "./keys";

/** A coin's six keys, a candidate's or a Protected coin's, both from candidateKeys. */
export type CoinKeys = { ticker: Keys; name: Keys };
export type ProtectedKeys = CoinKeys;

export type ProtectedCoin = {
  /** The mint, or for a coin on another chain its id at the source; a coin is reported once per field. */
  mint: string;
  ticker: string;
  name: string;
  /** Where its protection comes from, such as Jupiter's verified list or CoinGecko's top 1,000 (spec 6.2). */
  source: string;
  keys: ProtectedKeys;
};

export type Match = {
  /** The candidate's field that matched. */
  field: Field;
  kind: KeyKind;
  /** The Protected coin's field it matched: the same one, or for a core key also the other one. */
  against: Field;
  coin: ProtectedCoin;
  /** A sentence for the launch form. */
  reason: string;
};

export type Judgement = { verdict: "clear" } | { verdict: "refused"; matches: Match[] };

/**
 * A coin's six keys, its ticker folded as a ticker and its name as a name. Callers must compute a Protected coin's keys
 * with this same function (stored with FOLD_VERSION), or with foldKeys in the matching field: a name folded as a ticker
 * loses affixes from inside its words ("Newton" would be TON).
 */
export const candidateKeys = (ticker: string, name: string): CoinKeys => ({
  ticker: foldKeys(ticker, "ticker"),
  name: foldKeys(name, "name"),
});

type Rule = { field: Field; kind: KeyKind; against: Field };

/**
 * Every key equality that refuses, in the order matches are reported: the ticker first, strict before loose before
 * core, the same field before the other. A core key also meets the other field's, so "Pepe Coin" as a name meets
 * $PEPE's ticker.
 */
const RULES: readonly Rule[] = [
  { field: "ticker", kind: "strict", against: "ticker" },
  { field: "ticker", kind: "loose", against: "ticker" },
  { field: "ticker", kind: "core", against: "ticker" },
  { field: "ticker", kind: "core", against: "name" },
  { field: "name", kind: "strict", against: "name" },
  { field: "name", kind: "loose", against: "name" },
  { field: "name", kind: "core", against: "name" },
  { field: "name", kind: "core", against: "ticker" },
];

/** An empty key never matches (an emoji-only name has one), and a core key only from MIN_CORE characters. */
const matchable = (kind: KeyKind, key: string) => key.length >= (kind === "core" ? MIN_CORE : 1);

/** Refused if any key of the candidate equals a Protected coin's under RULES; each coin is reported once per field. */
export function judge(candidate: CoinKeys, protectedCoins: readonly ProtectedCoin[]): Judgement {
  const matches: Match[] = [];
  for (const rule of RULES) {
    const key = candidate[rule.field][rule.kind];
    if (!matchable(rule.kind, key)) continue;
    for (const coin of protectedCoins) {
      if (coin.keys[rule.against][rule.kind] !== key) continue;
      if (matches.some((m) => m.field === rule.field && m.coin.mint === coin.mint)) continue;
      matches.push({ ...rule, coin, reason: reason(rule, coin, candidate[rule.field]) });
    }
  }
  return matches.length > 0 ? { verdict: "refused", matches } : { verdict: "clear" };
}

/** For each of a Protected coin's six key columns, the values that can match it. */
export type KeyLookup = { ticker: Record<KeyKind, string[]>; name: Record<KeyKind, string[]> };

/**
 * The key values to look up, column by column, so the API fetches only the Protected coins that can match with indexed
 * equality (ticker strict = ANY(...) OR ticker loose = ANY(...) and so on) before judging them. Unmatchable keys are
 * left out, so a column can have nothing to look up.
 */
export function lookupValues(candidate: CoinKeys): KeyLookup {
  const lookup: KeyLookup = { ticker: { strict: [], loose: [], core: [] }, name: { strict: [], loose: [], core: [] } };
  for (const rule of RULES) {
    const key = candidate[rule.field][rule.kind];
    const values = lookup[rule.against][rule.kind];
    if (matchable(rule.kind, key) && !values.includes(key)) values.push(key);
  }
  return lookup;
}

// Ticker and name come from outside sources and are shown in the launch form: invisible and control characters go.
const shown = (text: string) => text.replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, "").trim();

function reason({ field, kind, against }: Rule, coin: ProtectedCoin, keys: Keys): string {
  const symbol = shown(coin.ticker).replace(/^\$/, "");
  const ticker = symbol ? `$${symbol}` : "";
  const name = shown(coin.name);
  const both = (first: string, second: string) => (first && second ? `${first} (${second})` : first || second || coin.mint);
  const target =
    field !== against ? `the ${against} of ${both(name, ticker)}` : field === "ticker" ? both(ticker, name) : both(name, ticker);
  if (kind === "strict") return `The ${field} looks the same as ${target}, a protected coin.`;
  if (kind === "loose") return `The ${field} reads as ${target}, a protected coin, once digits and symbols are read as letters.`;
  const stripped = keys.loose !== keys.core || coin.keys[against].loose !== coin.keys[against].core;
  return `The ${field} matches ${target}, a protected coin${stripped ? ", once words such as OFFICIAL, 2 or CTO are left out" : ""}.`;
}
