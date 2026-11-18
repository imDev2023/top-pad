// A Fair Open's teaser against the Protected coins (spec 2.1 step 4): which of its words are read as a coin's ticker
// or name, the keys the API looks them up by, and the refusal when one is a Protected coin's. A teaser is free text and
// the Protected coins hold thousands of everyday words ($ONE, $NOW, $OPEN, a coin named "LOCK IN"), so text is read as
// a coin only where it is written as one: in capitals, or with a digit or a lookalike character among its letters
// (owner, 2026-11-18, #93). Everyday writing is never read, whatever coins join the Protected set.
import { foldKeys, type Field } from "./keys";
import { nameAndTicker, type KeyLookup, type ProtectedCoin } from "./match";

/** The longest run of words in a teaser read as a coin's name: most names are one to three words. */
export const TEASER_PHRASE_WORDS = 4;
/** The shortest key a teaser is matched on: shorter ones (NO, GM, AI, IO) are everyday text far more often than coins. */
export const TEASER_KEY_MIN = 3;

// A word: letters and digits with the marks on them, so an accent or an overlay stays inside its word.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
// Everyday writing: the letters a to z in lower case, the first perhaps a capital, or a number in digits.
const EVERYDAY = /^(?:[A-Za-z][a-z]*|[0-9]+)$/;
/** Whether only its capitals make a word read as a coin: in lower case it would be everyday writing. */
const everydayInLowerCase = (word: string) => EVERYDAY.test(word.toLowerCase());

/**
 * Whether a teaser's word is written as a coin rather than as everyday text: in capitals (`ONE`, and `BoNK`, any
 * capital past the first letter), with a digit among letters (`b0nk`), or with any character beyond a to z and 0 to 9,
 * all of which fold to a plain letter or stand for one: an accent, a fullwidth or styled letter, another alphabet.
 * `one`, `One` and `10` are everyday writing.
 */
export const writtenAsCoin = (word: string) => !EVERYDAY.test(word);

/** A part of a teaser read as a coin's ticker or name, with the keys it is matched on. */
export type TeaserReading = {
  /** The part as the creator wrote it, for the refusal. */
  text: string;
  field: Field;
  strict: string;
  /** A name is matched on its loose key too, so leetspeak is read; a ticker on its strict key alone. */
  loose: string | null;
  /** Read only for its capitals: in lower case it would be everyday writing. */
  capitalsOnly: boolean;
};

const long = (key: string) => Array.from(key).length >= TEASER_KEY_MIN;

/**
 * What a teaser is read as: each word written as a coin, as a ticker by its strict key; and each run of up to four
 * words that holds one, as a name by its strict and loose keys, the run whole, so `LOCK in` is read against "LOCK IN"
 * and `Official TRUMP` against "OFFICIAL TRUMP". Tickers first, then names, each in the teaser's order. Core keys are
 * left out: they strip words such as OFFICIAL from free text. Everyday writing gives no reading at all.
 */
export function teaserReadings(teaser: string): TeaserReading[] {
  const words = Array.from(teaser.matchAll(WORD), (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length, coin: writtenAsCoin(m[0]) }));
  const readings: TeaserReading[] = [];
  const add = (reading: TeaserReading) => {
    const same = (r: TeaserReading) => r.field === reading.field && r.strict === reading.strict && r.loose === reading.loose;
    if (long(reading.strict) && !readings.some(same)) readings.push(reading);
  };
  for (const word of words) {
    if (!word.coin) continue;
    add({ text: word.text, field: "ticker", strict: foldKeys(word.text, "ticker").strict, loose: null, capitalsOnly: everydayInLowerCase(word.text) });
  }
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= TEASER_PHRASE_WORDS && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      if (!run.some((w) => w.coin)) continue;
      const { strict, loose } = foldKeys(run.map((w) => w.text).join(" "), "name");
      const text = teaser.slice(run[0]!.start, run.at(-1)!.end);
      add({ text, field: "name", strict, loose: long(loose) ? loose : null, capitalsOnly: run.every((w) => everydayInLowerCase(w.text)) });
    }
  }
  return readings;
}

/** The key values the API fetches Protected coins by, with indexed equality, before `teaserNaming` decides. */
export function teaserLookup(readings: readonly TeaserReading[]): KeyLookup {
  const values = (field: Field, key: (r: TeaserReading) => string | null) => [
    ...new Set(readings.flatMap((r) => (r.field === field ? (key(r) ?? []) : []))),
  ];
  return {
    ticker: { strict: values("ticker", (r) => r.strict), loose: [], core: [] },
    name: { strict: values("name", (r) => r.strict), loose: values("name", (r) => r.loose), core: [] },
  };
}

export type TeaserNaming<C extends ProtectedCoin = ProtectedCoin> = { reading: TeaserReading; coin: C };

/**
 * The first reading that is a Protected coin's, and the coin: a ticker reading by the coin's strict ticker key, a name
 * reading by its strict name key, else its loose one. Coins are taken in the order given, the API's most authoritative
 * source first.
 */
export function teaserNaming<C extends ProtectedCoin>(readings: readonly TeaserReading[], protectedCoins: readonly C[]): TeaserNaming<C> | null {
  for (const reading of readings) {
    const coin =
      reading.field === "ticker"
        ? protectedCoins.find((c) => c.keys.ticker.strict === reading.strict)
        : (protectedCoins.find((c) => c.keys.name.strict === reading.strict) ??
          protectedCoins.find((c) => reading.loose !== null && c.keys.name.loose === reading.loose));
    if (coin) return { reading, coin };
  }
  return null;
}

/** The sentence the launch form shows: what was read as which coin, and for capitals alone, how everyday text passes. */
export function teaserRefusal({ reading, coin }: TeaserNaming): string {
  const refusal = `"${reading.text}" in the teaser reads as ${nameAndTicker(coin)}, a protected coin: the calendar cannot carry another coin's name.`;
  return reading.capitalsOnly ? `${refusal} Capitals are read as a coin's ticker or name: write everyday words in lower case.` : refusal;
}
