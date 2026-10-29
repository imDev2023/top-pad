import { describe, expect, it } from "vitest";
import { decodeConfusables } from "./confusables";
import { CONFUSABLES, CONFUSABLES_VERSION } from "./confusables.generated";
import { FOLD_VERSION, foldKeys, MIN_CORE, skeleton } from "./keys";

const asTicker = (text: string) => foldKeys(text, "ticker");
const asName = (text: string) => foldKeys(text, "name");

describe("the confusables table", () => {
  it("holds UTS #39 version 18.0.0's 6,712 mappings, as the research measured", () => {
    const prototypes = decodeConfusables(CONFUSABLES);
    expect(CONFUSABLES_VERSION).toBe("18.0.0");
    expect(prototypes.size).toBe(6712);
    // Digit 0 is O; digit 1, capital I and | are small l; m is rn; Cyrillic and Greek capitals are Latin ones.
    expect(prototypes.get(0x30)).toBe("O");
    expect([0x31, 0x49, 0x7c].map((cp) => prototypes.get(cp))).toEqual(["l", "l", "l"]);
    expect(prototypes.get(0x6d)).toBe("rn");
    expect(prototypes.get(0x0415)).toBe("E");
    expect(prototypes.get(0x03a1)).toBe("P");
  });

  it("is named in FOLD_VERSION with the folding's revision, so stored keys are recomputed when either changes", () => {
    expect(FOLD_VERSION).toBe("uts39-18.0.0/fold-1");
  });
});

// research/copycat-detection, "What the skeleton catches and misses (measured)": each row's input, its bare skeleton,
// and its strict key.
describe("the skeleton and the strict key, row by row", () => {
  const rows: [label: string, input: string, bareSkeleton: string, strict: string][] = [
    ["P + Cyrillic E (U+0415) + PE", "P\u{415}PE", "PEPE", "PEPE"],
    ["Greek capitals RHO EPSILON", "\u{3A1}\u{395}\u{3A1}\u{395}", "PEPE", "PEPE"],
    ["fullwidth", "\u{FF30}\u{FF25}\u{FF30}\u{FF25}", "PEPE", "PEPE"],
    ["math bold", "\u{1D40F}\u{1D404}\u{1D40F}\u{1D404}", "PEPE", "PEPE"],
    // The research lumped superscripts in with fullwidth; in the 18.0.0 data the superscript P's prototype is U+18D6
    // and the superscript E has none, so only NFKC, which comes first in the strict key, folds them.
    ["superscript", "\u{1D3E}\u{1D31}\u{1D3E}\u{1D31}", "\u{18D6}\u{1D31}\u{18D6}\u{1D31}", "PEPE"],
    ["circled (wrong without NFKC first)", "\u{24C5}\u{24BA}\u{24C5}\u{24BA}", "\u{2117}\u{24BA}\u{2117}\u{24BA}", "PEPE"],
    ["zero-width space", "PE\u{200B}PE", "PEPE", "PEPE"],
    ["zero-width joiner", "PE\u{200D}PE", "PEPE", "PEPE"],
    ["soft hyphen", "PE\u{AD}PE", "PEPE", "PEPE"],
    ["variation selector", "PE\u{FE0F}PE", "PEPE", "PEPE"],
    ["right-to-left override U+202E", "PE\u{202E}PE", "PEPE", "PEPE"],
    ["Hangul filler U+3164", "PE\u{3164}PE", "PEPE", "PEPE"],
    ["spaces", "P E P E", "P E P E", "PEPE"],
    ["dots", "P.E.P.E", "P.E.P.E", "PEPE"],
    ["cashtag", "$PEPE", "$PEPE", "PEPE"],
    ["combining accent", "PE\u{301}PE", "PE\u{301}PE", "PEPE"],
    ["braille blank U+2800, not Default_Ignorable", "PEPE\u{2800}", "PEPE ", "PEPE"],
    ["regional indicators", "\u{1F1F5}\u{1F1EA}\u{1F1F5}\u{1F1EA}", "\u{1F1F5}\u{1F1EA}\u{1F1F5}\u{1F1EA}", "PEPE"],
    ["negative squared", "\u{1F17F}\u{1F174}\u{1F17F}\u{1F174}", "\u{1F17F}\u{1F174}\u{1F17F}\u{1F174}", "PEPE"],
    // The gap the research found in UTS #39 data, now closed by the small capitals map.
    ["small capitals", "\u{1D18}\u{1D07}\u{1D18}\u{1D07}", "\u{1D18}\u{1D07}\u{1D18}\u{1D07}", "PEPE"],
    ["B0NK", "B0NK", "BONK", "BONK"],
    ["W1F", "W1F", "WlF", "WlF"],
    ["WIF", "WIF", "WlF", "WlF"],
    ["P3PE (leetspeak is the loose key's)", "P3PE", "P3PE", "P3PE"],
    ["5OL (leetspeak is the loose key's)", "5OL", "5OL", "5OL"],
    ["lowercase", "pepe", "pepe", "PEPE"],
  ];
  for (const [label, input, bare, strict] of rows) {
    it(label, () => {
      expect(skeleton(input)).toBe(bare);
      expect(asName(input).strict).toBe(strict);
    });
  }

  it("folds what the research's rows leave out: negative circled letters, and a small capital that only the skeleton makes", () => {
    expect(asName("\u{1F15F}\u{1F154}\u{1F15F}\u{1F154}").strict).toBe("PEPE");
    // Greek small capital rho has the prototype U+1D18, a Latin small capital.
    expect(skeleton("\u{1D29}")).toBe("\u{1D18}");
    expect(asName("\u{1D29}\u{1D07}\u{1D29}\u{1D07}").strict).toBe("PEPE");
  });

  it("upper-cases before the skeleton, since case folding first sends Greek capitals elsewhere", () => {
    expect(skeleton("\u{3A1}\u{395}\u{3A1}\u{395}".toLowerCase())).toBe("p\u{A793}p\u{A793}");
    expect(asName("\u{3A1}\u{395}\u{3A1}\u{395}").strict).toBe("PEPE");
  });

  it("is idempotent, as UTS #39 promises", () => {
    for (const text of ["P\u{415}PE", "Pepe on SOL", "\u{1D40F}\u{1D404}\u{1D40F}\u{1D404}", "\u{24C5}\u{24BA}\u{24C5}\u{24BA}"]) {
      expect(skeleton(skeleton(text))).toBe(skeleton(text));
    }
  });
});

describe("the loose key", () => {
  it("reads leetspeak as letters", () => {
    expect(asTicker("P3PE")).toMatchObject({ strict: "P3PE", loose: "PEPE" });
    expect(asTicker("5OL")).toMatchObject({ strict: "5OL", loose: "SOL" });
    expect(asTicker("B0NK")).toMatchObject({ strict: "BONK", loose: "BONK" });
    expect(asName("P@P3!")).toMatchObject({ loose: "PAPEl" });
    expect(asName("$H1B4")).toMatchObject({ loose: "HlBA" });
  });

  it("drops a cashtag's $ wherever a word starts, and reads any other $ as S", () => {
    expect(asName("$PEPE")).toEqual({ strict: "PEPE", loose: "PEPE", core: "PEPE" });
    expect(asName("Official $PEPE").core).toBe("PEPE");
    expect(asName("PE$E").loose).toBe("PESE");
  });

  it("folds spaced and dotted copies to the same keys", () => {
    for (const text of ["P E P E", "P.E.P.E", "p-e-p-e"]) {
      expect(asName(text), text).toEqual({ strict: "PEPE", loose: "PEPE", core: "PEPE" });
      expect(asTicker(text), text).toEqual({ strict: "PEPE", loose: "PEPE", core: "PEPE" });
    }
  });

  it("is the same for a ticker and a name, as is the strict key; only the core key differs", () => {
    for (const text of ["Pepe Coin", "OFFICIALPEPE2", "Newton", "P3PE", "$PEPE on SOL", "P\u{415}PE", "\u{1F680}"]) {
      const [ticker, name] = [asTicker(text), asName(text)];
      expect([name.strict, name.loose], text).toEqual([ticker.strict, ticker.loose]);
    }
  });
});

describe("the core key of a ticker", () => {
  it("strips authenticity and version words from either end of the joined key, repeatedly", () => {
    for (const text of [
      "OFFICIALPEPE2",
      "OGPEPE",
      "PEPE2",
      "PEPE20",
      "PEPEV2",
      "PEPEII",
      "PEPECTO",
      "THEPEPE",
      "REALPEPE",
      "PEPECOIN",
      "PEPEONSOL",
      "PEPEONSOLANA",
      "SOLANAPEPE",
    ]) {
      expect(asTicker(text).core, text).toBe("PEPE");
    }
    expect(asTicker("OFFICIALPEPE2")).toEqual({ strict: "OFFlClALPEPE2", loose: "OFFlClALPEPEZ", core: "PEPE" });
  });

  it("has no word boundaries, so an affix comes off inside a word too", () => {
    expect(asTicker("NEWTON").core).toBe("TON");
    expect(asTicker("FANTOM").core).toBe("TOM");
  });

  it("never strips below MIN_CORE characters, and keeps a ticker that is itself an affix whole", () => {
    expect(MIN_CORE).toBe(3);
    expect(asTicker("SOL").core).toBe("SOL");
    expect(asTicker("OGSOL").core).toBe("SOL");
    expect(asTicker("XD2").core).toBe("XDZ");
    // Not "ANA": stripping SOL from SOLANA would leave a key that matches unrelated coins.
    expect(asTicker("SOLANA").core).toBe("SOLANA");
  });

  it("keeps derivative words, which make a different coin to label, not a copy", () => {
    expect(asTicker("BABYPEPE").core).toBe("BABYPEPE");
    expect(asTicker("PEPEINU").core).toBe("PEPElNU");
  });
});

describe("the core key of a name", () => {
  it("strips authenticity and version words as whole words from either end, repeatedly", () => {
    for (const text of [
      "Official Pepe",
      "Pepe Coin",
      "Pepe 2.0",
      "Pepe CTO",
      "The Pepe",
      "Pepe on Sol",
      "Pepe on Solana",
      "Pepe-Coin",
      "OG Pepe Fan",
      "Official $PEPE",
      "The Real Pepe",
      "OG Pepe Coin",
      "Pepe Community Token",
      "Pepe V2",
      "Pepe II",
      "Pepe Parody",
      "Classic Pepe",
      "New Pepe",
      "Original Pepe",
      "Solana Pepe",
      "Pepe OnSol",
      "Pepe OnSolana",
      "Pepe_Coin",
      "Pepe/Sol",
      "Pepe+Coin",
      "Pepe  -  Coin",
    ]) {
      expect(asName(text).core, text).toBe("PEPE");
    }
  });

  it("keeps a single word whole, so a word that merely starts or ends like an affix is not cut", () => {
    expect(asName("Newton").core).toBe("NEWTON");
    expect(asName("Fantom").core).toBe("FANTOM");
    expect(asName("Coinbase").core).toBe("COlNBASE");
    expect(asName("Themis").core).toBe("THEMlS");
    expect(asName("Solana").core).toBe("SOLANA");
    // Written together, the affix is part of the word.
    expect(asName("OfficialPepe").core).toBe("OFFlClALPEPE");
  });

  it("never strips the last word, nor below MIN_CORE characters", () => {
    expect(asName("Official").core).toBe("OFFlClAL");
    expect(asName("Coin Token").core).toBe("COlN");
    expect(asName("OG Sol").core).toBe("SOL");
    expect(asName("X 2.0").core).toBe("XZO");
  });

  it("is the loose key less the stripped words", () => {
    expect(asName("Dog Wif Hat")).toEqual({ strict: "DOGWlFHAT", loose: "DOGWlFHAT", core: "DOGWlFHAT" });
    expect(asName("OG Pepe Fan")).toEqual({ strict: "OGPEPEFAN", loose: "OGPEPEFAN", core: "PEPE" });
  });

  it("keeps derivative words, which make a different coin to label, not a copy", () => {
    expect(asName("Baby Pepe").core).toBe("BABYPEPE");
    expect(asName("Pepe Inu").core).toBe("PEPElNU");
    expect(asName("Mini Pepe King").core).toBe("MlNlPEPEKlNG");
  });

  it("is empty for a text without letters or digits", () => {
    expect(asName("\u{1F680}\u{1F680}")).toEqual({ strict: "", loose: "", core: "" });
    expect(asName(" .-_ ")).toEqual({ strict: "", loose: "", core: "" });
  });
});
