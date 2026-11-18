import { describe, expect, it } from "vitest";
import { candidateKeys, type ProtectedCoin } from "./match";
import { TEASER_KEY_MIN, teaserLookup, teaserNaming, teaserReadings, teaserRefusal, writtenAsCoin } from "./teaser";

const coin = (ticker: string, name: string): ProtectedCoin => ({ mint: `${ticker}-mint`, ticker, name, source: "test", keys: candidateKeys(ticker, name) });

// Protected coins as devnet's set held them on 2026-11-18, the day everyday teasers were refused on these (#93).
const PROTECTED = [
  coin("ONE", "ONEchain"),
  coin("OPEN", "OpenLedger"),
  coin("BONK", "Bonk"),
  coin("PEPE", "Pepe"),
  coin("WIF", "dogwifhat"),
  coin("SOL", "Wrapped SOL"),
  coin("IO", "IO"),
  coin("NO", "NO"),
  coin("SN28", "gm"),
  coin("XD", "Extra Dimension"),
  coin("SEI", "Sei"),
  coin("LOCKIN", "LOCK IN"),
  coin("CHILLGUY", "Just a chill guy"),
  coin("1.0", "Solana 1.0"),
];

/** What a teaser names among the Protected coins: the part read, how, and the coin's ticker; null when nothing. */
function naming(teaser: string) {
  const found = teaserNaming(teaserReadings(teaser), PROTECTED);
  return found && `"${found.reading.text}" as the ${found.reading.field} of $${found.coin.ticker}`;
}
const refusal = (teaser: string) => {
  const found = teaserNaming(teaserReadings(teaser), PROTECTED);
  return found && teaserRefusal(found);
};

describe("a word written as a coin", () => {
  it("is not one in lower case, with a first capital, or a number in digits", () => {
    for (const word of ["one", "One", "ten", "minutes", "snipers", "a", "I", "A", "10", "2026", "0"]) expect(writtenAsCoin(word), word).toBe(false);
  });

  it("is one in capitals, any capital past the first letter", () => {
    for (const word of ["ONE", "BONK", "NO", "BoNK", "oNE", "bonK", "DeFi"]) expect(writtenAsCoin(word), word).toBe(true);
  });

  it("is one with a digit among its letters", () => {
    for (const word of ["b0nk", "B0NK", "p3pe", "pepe2", "1O", "10x"]) expect(writtenAsCoin(word), word).toBe(true);
  });

  it("is one with any character beyond a to z and 0 to 9, each a lookalike of a plain letter or digit", () => {
    const lookalikes = [
      "b\u{F3}nk", // an accent
      "bo\u{338}nk", // a combining overlay
      "\u{FF42}\u{FF4F}\u{FF4E}\u{FF4B}", // fullwidth, lower case
      "\u{440}\u{435}\u{440}\u{435}", // Cyrillic, lower case, which looks like "pepe"
      "\u{FF11}\u{FF10}", // fullwidth digits
    ];
    for (const word of lookalikes) expect(writtenAsCoin(word), word).toBe(true);
  });
});

describe("everyday writing", () => {
  const everyday = [
    "Ten minutes, one price, no snipers", // refused as $ONE on 2026-11-04
    "Opens at 10, so be in", // "10" folded to the name key of IO
    "One price. No snipers. Open now.",
    "Lock in your seat: just a chill guy with a plan",
    "Lock In Your Seat",
    "bigger than bonk, bigger than Bonk",
    "gm, the window opens at 9",
    "531 seats, 48 hours, 100 holders", // the loose key reads these digits as SEI, AB and nothing
    "solana 1.0 was only the start",
  ];

  it("has no readings, so nothing is looked up", () => {
    for (const teaser of everyday) expect(teaserReadings(teaser), teaser).toEqual([]);
    expect(teaserLookup([])).toEqual({ ticker: { strict: [], loose: [], core: [] }, name: { strict: [], loose: [], core: [] } });
  });

  it("names no Protected coin, though the set holds its words as tickers and names", () => {
    for (const teaser of everyday) expect(naming(teaser), teaser).toBeNull();
  });
});

describe("a teaser's tickers", () => {
  it("are its words in capitals", () => {
    expect(naming("ONE price for everyone")).toBe(`"ONE" as the ticker of $ONE`);
    expect(naming("a BONK killer")).toBe(`"BONK" as the ticker of $BONK`);
    expect(naming("TEN MINUTES, ONE PRICE")).toBe(`"ONE" as the ticker of $ONE`);
    expect(naming("BoNK season")).toBe(`"BoNK" as the ticker of $BONK`);
  });

  it("are its words with a digit or a lookalike among their letters, in any case", () => {
    expect(naming("bigger than b0nk")).toBe(`"b0nk" as the ticker of $BONK`);
    expect(naming("bigger than B0NK")).toBe(`"B0NK" as the ticker of $BONK`);
    expect(naming("the w1f of this cycle")).toBe(`"w1f" as the ticker of $WIF`);
    expect(naming("b\u{F3}nk is back")).toBe(`"b\u{F3}nk" as the ticker of $BONK`);
    expect(naming("bo\u{338}nk is back")).toBe(`"bo\u{338}nk" as the ticker of $BONK`);
    expect(naming("\u{FF42}\u{FF4F}\u{FF4E}\u{FF4B} is back")).toBe(`"\u{FF42}\u{FF4F}\u{FF4E}\u{FF4B}" as the ticker of $BONK`);
    // Cyrillic letters that look like PEPE, in capitals and in lower case.
    expect(naming("\u{420}\u{415}\u{420}\u{415} lives")).toBe(`"\u{420}\u{415}\u{420}\u{415}" as the ticker of $PEPE`);
    expect(naming("\u{440}\u{435}\u{440}\u{435} lives")).toBe(`"\u{440}\u{435}\u{440}\u{435}" as the ticker of $PEPE`);
  });

  it("are matched on the strict key alone, so leetspeak beyond 0 and 1 is not read as a ticker", () => {
    expect(naming("5OL season")).toBeNull();
  });

  it("are never words whose key is under three characters", () => {
    expect(TEASER_KEY_MIN).toBe(3);
    for (const teaser of ["XD at noon", "NO SNIPERS", "IO opens here", "1O opens here", "GM"]) expect(naming(teaser), teaser).toBeNull();
  });
});

describe("a teaser's names", () => {
  it("are its runs of up to four words that hold a word written as a coin, read whole", () => {
    expect(naming("LOCK IN your seat")).toBe(`"LOCK IN" as the name of $LOCKIN`);
    expect(naming("LOCK in your seat")).toBe(`"LOCK in" as the name of $LOCKIN`);
    expect(naming("be JUST a chill guy")).toBe(`"JUST a chill guy" as the name of $CHILLGUY`);
    expect(naming("after SOLANA 1.0, this")).toBe(`"SOLANA 1.0" as the name of $1.0`);
    expect(naming("the DOGWIFHAT of this cycle")).toBe(`"DOGWIFHAT" as the name of $WIF`);
  });

  it("are matched on the loose key too, so leetspeak is read", () => {
    expect(naming("p3pe is back")).toBe(`"p3pe" as the name of $PEPE`);
    expect(naming("the S3I of memes")).toBe(`"S3I" as the name of $SEI`);
  });

  it("are never a number in digits, or a run whose key is under three characters", () => {
    for (const teaser of ["Opens at 10", "531 seats", "IO", "NO", "GM, we open at noon"]) expect(naming(teaser), teaser).toBeNull();
  });

  it("come after the tickers, each in the teaser's order", () => {
    expect(teaserReadings("a BONK killer").map((r) => `${r.field} ${r.text}`)).toEqual(["ticker BONK", "name a BONK", "name a BONK killer", "name BONK", "name BONK killer"]);
    // Bonk's name is read too, yet its ticker is what the refusal reports.
    expect(naming("BONK")).toBe(`"BONK" as the ticker of $BONK`);
  });
});

describe("the lookup", () => {
  it("holds each reading's keys under its field: a ticker's strict key, a name's strict and loose keys, no core key", () => {
    const lookup = teaserLookup(teaserReadings("a BONK killer, p3pe"));
    expect(lookup.ticker).toEqual({ strict: ["BONK", "P3PE"], loose: [], core: [] });
    expect(lookup.name.strict).toEqual(expect.arrayContaining(["BONK", "ABONK", "BONKKlLLER", "P3PE"]));
    expect(lookup.name.loose).toEqual(expect.arrayContaining(["BONK", "PEPE"]));
    expect(lookup.name.core).toEqual([]);
  });
});

describe("the refusal", () => {
  it("says what was read as which coin, and for capitals alone how everyday words pass", () => {
    expect(refusal("ONE price for everyone")).toBe(
      `"ONE" in the teaser reads as ONEchain ($ONE), a protected coin: the calendar cannot carry another coin's name. Capitals are read as a coin's ticker or name: write everyday words in lower case.`,
    );
    expect(refusal("LOCK IN your seat")).toBe(
      `"LOCK IN" in the teaser reads as LOCK IN ($LOCKIN), a protected coin: the calendar cannot carry another coin's name. Capitals are read as a coin's ticker or name: write everyday words in lower case.`,
    );
  });

  it("gives no such advice for a digit or a lookalike, which lower case would not make everyday", () => {
    expect(refusal("bigger than b0nk")).toBe(`"b0nk" in the teaser reads as Bonk ($BONK), a protected coin: the calendar cannot carry another coin's name.`);
    expect(refusal("b\u{F3}nk is back")).toBe(`"b\u{F3}nk" in the teaser reads as Bonk ($BONK), a protected coin: the calendar cannot carry another coin's name.`);
  });
});
