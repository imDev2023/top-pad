import { describe, expect, it } from "vitest";
import {
  canonicalName,
  canonicalTicker,
  NAME_MAX_BYTES,
  nameVerdict,
  restrictionLevel,
  TEASER_MAX_LENGTH,
  teaserVerdict,
  TICKER_MAX_LENGTH,
  TICKER_MIN_LENGTH,
  tickerVerdict,
  type NameVerdict,
  type TickerVerdict,
} from "./rules";

const reasonOf = (verdict: TickerVerdict | NameVerdict) => (verdict.ok ? undefined : verdict.reason);

describe("tickers", () => {
  it("are canonical in NFKC, trimmed and upper case", () => {
    expect(canonicalTicker("  pepe ")).toBe("PEPE");
    expect(canonicalTicker("\u{FF30}\u{FF25}\u{FF30}\u{FF25}")).toBe("PEPE");
    expect(canonicalTicker("$pepe")).toBe("$PEPE");
  });

  it("accept 2 to 10 letters A to Z and digits 0 to 9, as their canonical form", () => {
    expect([TICKER_MIN_LENGTH, TICKER_MAX_LENGTH]).toEqual([2, 10]);
    expect(tickerVerdict("pepe")).toEqual({ ok: true, ticker: "PEPE" });
    expect(tickerVerdict(" B0NK ")).toEqual({ ok: true, ticker: "B0NK" });
    expect(tickerVerdict("A1")).toEqual({ ok: true, ticker: "A1" });
    expect(tickerVerdict("ABCDEFGHI9")).toEqual({ ok: true, ticker: "ABCDEFGHI9" });
    expect(tickerVerdict("\u{FF30}\u{FF25}\u{FF30}\u{FF25}")).toEqual({ ok: true, ticker: "PEPE" });
  });

  it("refuse an empty ticker", () => {
    expect(reasonOf(tickerVerdict(""))).toBe("Enter a ticker of 2 to 10 letters or digits.");
    expect(reasonOf(tickerVerdict("   "))).toBe("Enter a ticker of 2 to 10 letters or digits.");
  });

  it("refuse one shorter than 2 or longer than 10 characters", () => {
    expect(reasonOf(tickerVerdict("P"))).toBe("The ticker needs at least 2 characters.");
    expect(reasonOf(tickerVerdict("ABCDEFGHIJK"))).toBe("The ticker can have at most 10 characters.");
  });

  it("refuse any character outside A to Z and 0 to 9, which keeps out lookalike letters", () => {
    const outside =
      "The ticker can only use the letters A to Z and the digits 0 to 9, which keeps out lookalike letters from other alphabets.";
    const tickers = [
      "\u{41F}\u{415}\u{41F}\u{415}", // Cyrillic
      "P\u{415}PE", // one Cyrillic E
      "\u{3A1}\u{395}\u{3A1}\u{395}", // Greek
      "$PEPE", // a cashtag the form did not strip
      "PE PE",
      "P\u{C9}PE", // an accent
      "\u{1F438}", // an emoji
      "PE\u{200B}PE", // a zero-width space
    ];
    for (const ticker of tickers) expect(reasonOf(tickerVerdict(ticker)), ticker).toBe(outside);
  });
});

describe("names", () => {
  it("are canonical in NFC and trimmed", () => {
    expect(canonicalName("  Pe\u{301}pe \n")).toBe("P\u{E9}pe");
    expect(nameVerdict(" Pepe\n")).toEqual({ ok: true, name: "Pepe" });
  });

  it("refuse an empty name", () => {
    expect(reasonOf(nameVerdict(" "))).toBe("Enter a name.");
  });

  it("refuse more than 32 bytes of UTF-8, saying so", () => {
    expect(NAME_MAX_BYTES).toBe(32);
    expect(nameVerdict("a".repeat(32)).ok).toBe(true);
    expect(nameVerdict("\u{E9}".repeat(16)).ok).toBe(true);
    expect(nameVerdict("\u{1F438}".repeat(8)).ok).toBe(true);
    expect(reasonOf(nameVerdict("a".repeat(33)))).toBe(
      "The name is 33 bytes long and Solana token metadata holds at most 32; accented letters, other alphabets and emoji take 2 to 4 bytes each.",
    );
    expect(reasonOf(nameVerdict("\u{E9}".repeat(17)))).toMatch(/^The name is 34 bytes long/);
    expect(reasonOf(nameVerdict("\u{1F438}".repeat(9)))).toMatch(/^The name is 36 bytes long/);
  });

  it("refuse line breaks and control characters", () => {
    const control = "The name cannot contain line breaks or other control characters.";
    for (const name of ["Pepe\nCoin", "Pepe\rCoin", "Pepe\tCoin", "Pepe\u{0}Coin", "Pepe\u{2028}Coin", "Pepe\u{2029}Coin"]) {
      expect(reasonOf(nameVerdict(name)), JSON.stringify(name)).toBe(control);
    }
  });

  it("refuse invisible characters: zero-width, bidi controls, fillers and blanks, tags, stray joiners and selectors", () => {
    const invisible = "The name cannot contain invisible characters, such as zero-width spaces or text direction controls.";
    const names = [
      "Pe\u{200B}pe", // zero-width space
      "Pepe\u{202E}", // right-to-left override
      "Pe\u{2066}pe", // left-to-right isolate
      "Pe\u{200D}pe", // zero-width joiner between letters
      "Pe\u{200C}pe", // zero-width non-joiner
      "Pe\u{AD}pe", // soft hyphen
      "Pe\u{3164}pe", // Hangul filler
      "Pe\u{FEFF}pe", // zero-width no-break space
      "Pepe\u{FE0F}", // variation selector after a letter
      "Pepe\u{E0067}", // tag character
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // England's flag is made of tag characters
      "\u{1F438}\u{200D}pe", // joiner from an emoji to a letter
      "Pepe\u{2800}", // braille blank, not Default_Ignorable but blank
      "\u{2800}\u{2800}", // a name that looks empty
      "Pe\u{FFF9}pe\u{FFFA}", // interlinear annotation controls
    ];
    for (const name of names) expect(reasonOf(nameVerdict(name)), JSON.stringify(name)).toBe(invisible);
  });

  it("accept the joiners and selectors that emoji are made of", () => {
    const emoji = [
      "\u{2600}\u{FE0F}", // sun: U+FE0F after a pictograph
      "\u{1F468}\u{200D}\u{1F4BB}", // technologist: U+200D between two pictographs
      "\u{1F468}\u{1F3FD}\u{200D}\u{1F4BB}", // a skin tone before the joiner
      "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}", // rainbow flag: U+FE0F before the joiner
      "\u{2764}\u{FE0F}\u{200D}\u{1F525}", // heart on fire
      "1\u{FE0F}\u{20E3}", // a keycap
      "Pepe \u{2600}\u{FE0F} \u{1F468}\u{200D}\u{1F4BB}",
    ];
    for (const name of emoji) expect(nameVerdict(name), name).toEqual({ ok: true, name });
  });

  it("refuse private-use characters and broken text", () => {
    expect(reasonOf(nameVerdict("Pepe\u{E000}"))).toBe(
      "The name has a private-use or unassigned character, which looks different on every device.",
    );
    expect(reasonOf(nameVerdict("Pepe\u{378}"))).toMatch(/unassigned/);
    expect(reasonOf(nameVerdict("Pepe\u{D800}"))).toBe("The name is not valid Unicode text.");
  });

  it("accept one script, Latin with Han, Japanese or Korean, and Latin with one other everyday script", () => {
    for (const name of [
      "Pepe", // ASCII
      "Пепе", // Cyrillic alone
      "Πέπε", // Greek alone
      "Pepe 中国", // Latin and Han
      "Pepe ひらがな漢字", // Latin and Japanese
      "Pepe 한국어", // Latin and Hangul
      "Pepe مرحبا", // Latin and Arabic
      "Pepe नमस्ते", // Latin and Devanagari
      "Caf\u{E9} Cr\u{E8}me", // accented Latin
      "ᏣᎳᎩ", // Cherokee alone
    ]) {
      expect(nameVerdict(name), name).toEqual({ ok: true, name });
    }
  });

  it("refuse Latin mixed with Cyrillic or Greek, which is how lookalike names are made", () => {
    const lookalike = "The name mixes Latin letters with Cyrillic or Greek ones, which is how lookalike names are made; use one alphabet.";
    for (const name of ["P\u{435}pe", "Pep\u{3B5}", "Pepe Пепе", "Pepe Πέπε", "P\u{435}p\u{3B5}"]) {
      expect(reasonOf(nameVerdict(name)), name).toBe(lookalike);
    }
  });

  it("refuse any other mix of scripts with a general reason", () => {
    const mixed =
      "The name mixes letters from scripts that are not written together, which is how lookalike names are made; use one script.";
    // Cyrillic with Greek, three scripts, a Cherokee letter that looks Latin, Arabic with Cyrillic.
    for (const name of ["П\u{3B5}п\u{3B5}", "Pepe مرحبا שלום", "\u{13E2}epe", "مرحبا Пепе"]) {
      expect(reasonOf(nameVerdict(name)), name).toBe(mixed);
    }
  });
});

describe("restriction levels (UTS #39 section 5.2)", () => {
  it("place texts as the standard does, with Hntl making Latin and Han one writing system", () => {
    expect(restrictionLevel("Pepe 2")).toBe("ascii-only");
    expect(restrictionLevel("Пепе")).toBe("single-script");
    expect(restrictionLevel("Caf\u{E9}")).toBe("single-script");
    expect(restrictionLevel("Pepe 中国")).toBe("single-script");
    expect(restrictionLevel("\u{1F438}\u{1F680}")).toBe("single-script");
    expect(restrictionLevel("Pepe ひらがな漢字")).toBe("highly-restrictive");
    expect(restrictionLevel("Pepe 한국어 中国")).toBe("highly-restrictive");
    expect(restrictionLevel("Pepe ㄅㄆ")).toBe("highly-restrictive");
    expect(restrictionLevel("Pepe مرحبا")).toBe("moderately-restrictive");
    expect(restrictionLevel("P\u{435}pe")).toBe("minimally-restrictive");
    expect(restrictionLevel("Pepe Πέπε")).toBe("minimally-restrictive");
  });

  it("consult the scripts beyond the Recommended ones before refusing, and only then", () => {
    // Cherokee is not a Recommended script, yet a name wholly in it is single-script.
    expect(restrictionLevel("ᏣᎳᎩ")).toBe("single-script");
    // The documented change: these two lone marks share only Syriac, so the standard calls them single-script, while
    // Latin and Arabic cover them first. Both levels accept.
    expect(restrictionLevel("\u{308}\u{64B}")).toBe("moderately-restrictive");
  });
});

describe("teasers", () => {
  const reason = (input: string) => {
    const verdict = teaserVerdict(input);
    return verdict.ok ? undefined : verdict.reason;
  };

  it("takes one plain line of up to 80 characters, its spaces made one", () => {
    expect(teaserVerdict("  The   first   coin with a  heartbeat ")).toEqual({ ok: true, teaser: "The first coin with a heartbeat" });
    expect(teaserVerdict("")).toEqual({ ok: true, teaser: "" });
    expect(teaserVerdict("x".repeat(TEASER_MAX_LENGTH)).ok).toBe(true);
    expect(reason("x".repeat(TEASER_MAX_LENGTH + 1))).toMatch(/81 characters/);
    // Characters, not bytes: 80 emoji fit.
    expect(teaserVerdict("\u{1F525}".repeat(TEASER_MAX_LENGTH)).ok).toBe(true);
    expect(teaserVerdict("Caf\u{0065}\u{0301} at noon")).toEqual({ ok: true, teaser: "Caf\u{E9} at noon" });
  });

  it("refuses links and web addresses", () => {
    for (const link of ["see https://heat.ag", "join t.me/heatcoin", "www.heat", "visit heat.fun now", "ipfs://bafy"]) {
      expect(reason(link), link).toMatch(/links/);
    }
    expect(teaserVerdict("v2.0 lands at 5.30, e.g. soon").ok).toBe(true);
  });

  it("refuses cashtags", () => {
    expect(reason("bigger than $PEPE")).toMatch(/cashtags/);
    expect(reason("bigger than $ wif")).toMatch(/cashtags/);
    expect(teaserVerdict("costs $5 to watch").ok).toBe(true);
  });

  it("refuses the characters refused in names", () => {
    expect(reason("two\nlines")).toMatch(/one line/);
    expect(reason("zero\u{200B}width")).toMatch(/invisible/);
    expect(reason("bidi \u{202E}gnirts")).toMatch(/invisible/);
    expect(reason("private \u{E000}")).toMatch(/private-use/);
    // A Cyrillic "а" inside a Latin word.
    expect(reason("the r\u{0430}ce is on")).toMatch(/mixes letters/);
    // Whole words in different alphabets are fine, and so are emoji joined into one.
    expect(teaserVerdict("Heat \u{043C}\u{0438}\u{0440} \u{1F468}\u{200D}\u{1F4BB}").ok).toBe(true);
  });
});
