// Vamp Shield's folded keys (spec 6.2): a ticker or a name folds into three keys, each coarser than the last, so that a
// copy written with lookalike letters, leetspeak or an "Official" added still lands on its original's key. The steps
// are research/copycat-detection section 2's. Keys are compared and indexed, never displayed. Server side only: this
// module carries the whole UTS #39 confusables table, which the web app must never bundle.
import { decodeConfusables } from "./confusables";
import { CONFUSABLES, CONFUSABLES_VERSION } from "./confusables.generated";

/** Bumped whenever the folding below changes. */
export const FOLD_REVISION = 1;

/**
 * The confusables version and the folding's revision. Store it with every key and recompute the keys of any other
 * version, since UTS #39 skeletons "are not stable across versions of Unicode" (section 4).
 */
export const FOLD_VERSION = `uts39-${CONFUSABLES_VERSION}/fold-${FOLD_REVISION}`;

/** The shortest core key that can match, and that affix stripping leaves: shorter ones are too common to tell apart. */
export const MIN_CORE = 3;

/** What a text is folded as: only the core key differs between the two. */
export type Field = "ticker" | "name";

/**
 * - strict: NFKC, lookalike capitals to A-Z, upper case, the skeleton, letters and numbers only. Catches case, spaces
 *   and dots, fullwidth and styled letters, Cyrillic or Greek lookalikes, invisible characters, accents, 0 for O, 1 for I.
 * - loose: a "$" opening a word dropped and leetspeak read as letters, then strict. Catches P3PE, 5OL.
 * - core: loose, with words such as OFFICIAL, 2, CTO or ON SOL stripped from either end. A ticker has no word
 *   boundaries, so they come off its joined key ("OFFICIALPEPE2" is PEPE); a name loses whole words only ("Pepe Coin"
 *   is PEPE, while "Newton" stays NEWTON rather than TON).
 */
export type Keys = { strict: string; loose: string; core: string };
export type KeyKind = keyof Keys;

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
let prototypes: Map<number, string> | undefined;

/**
 * UTS #39 internalSkeleton (section 4): NFD, Default_Ignorable code points removed, each character replaced by its
 * confusables prototype, NFD again. Texts that render alike share a skeleton; it is a key, not text for display.
 */
export function skeleton(text: string): string {
  prototypes ??= decodeConfusables(CONFUSABLES);
  let out = "";
  for (const c of text.normalize("NFD")) {
    if (!IGNORABLE.test(c)) out += prototypes.get(c.codePointAt(0)!) ?? c;
  }
  return out.normalize("NFD");
}

/** Latin small capitals, which UTS #39 does not take to their capitals: ᴘ has no confusables entry, ᴋ maps to ĸ. */
const SMALL_CAPITALS = new Map<number, string>([
  [0x1d00, "A"], [0x0299, "B"], [0x1d04, "C"], [0x1d05, "D"], [0x1d07, "E"], [0xa730, "F"], [0x0262, "G"],
  [0x029c, "H"], [0x026a, "I"], [0xa7ae, "I"], [0x1d0a, "J"], [0x1d0b, "K"], [0x029f, "L"], [0x1d0d, "M"],
  [0x0274, "N"], [0x1d0f, "O"], [0x1d18, "P"], [0xa7af, "Q"], [0x0280, "R"], [0xa731, "S"], [0x1d1b, "T"],
  [0x1d1c, "U"], [0x1d20, "V"], [0x1d21, "W"], [0x028f, "Y"], [0x1d22, "Z"],
]);

/**
 * Letters that render as Latin capitals but that UTS #39 leaves alone, taken to A-Z: regional indicators (🇵), negative
 * circled (🅟) and negative squared (🅿) letters, which NFKC keeps too, and small capitals (ɪ also upper-cases to Ɪ).
 * Applied before the skeleton and again on its output, since a few prototypes are small capitals (ᴩ maps to ᴘ).
 */
function latinCapitals(text: string): string {
  let out = "";
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    const letter = (a: number) => String.fromCharCode(0x41 + cp - a);
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) out += letter(0x1f1e6);
    else if (cp >= 0x1f150 && cp <= 0x1f169) out += letter(0x1f150);
    else if (cp >= 0x1f170 && cp <= 0x1f189) out += letter(0x1f170);
    else out += SMALL_CAPITALS.get(cp) ?? c;
  }
  return out;
}

/**
 * Upper case comes before the skeleton, never case folding: folded Greek capitals skeleton to other letters (ΡΕΡΕ
 * folds to ρερε, whose skeleton is pꞓpꞓ). The result may hold lowercase prototypes: 1, I and | all become l.
 */
function strictKey(text: string): string {
  const upper = latinCapitals(text.normalize("NFKC")).toUpperCase();
  return skeleton(latinCapitals(skeleton(upper))).replace(/[^\p{L}\p{N}]/gu, "");
}

/** Digits and symbols written for letters. 0 and 1 are not here: the skeleton already reads them as O and l. */
const LEET: Record<string, string> = {
  "2": "Z", "3": "E", "4": "A", "5": "S", "6": "G", "7": "T", "8": "B", "9": "G", $: "S", "@": "A", "!": "I",
};

/** The text the loose key folds: NFKC, a "$" opening a word dropped, leetspeak read as letters. */
function looseText(text: string): string {
  // A "$" opening a word is a cashtag ("$PEPE", "Official $PEPE"), not an S.
  const untagged = text.normalize("NFKC").replace(/(^|\s)\$/gu, "$1");
  return untagged.replace(/[2-9$@!]/g, (c) => LEET[c]!);
}

const looseKey = (text: string) => strictKey(looseText(text));

/**
 * A name's words, each folded like the loose key, which they make up when joined. Words break at whitespace and at
 * - _ / +; other punctuation stays inside a word and folds away, so "2.0" is one word, ZO, the folded "20".
 */
const looseWords = (text: string) =>
  looseText(text)
    .split(/[\s_/+-]+/u)
    .map(strictKey)
    .filter((word) => word !== "");

/**
 * Words a copy adds to pass as the original or as its new version. Derivative words (BABY, MINI, LIL, INU, KING, CAT,
 * DOG) are not among them: they make a derivative coin, which is labelled, not refused. "ON SOL" is two words in a
 * name, "ONSOL" the same written together; in a ticker both are ONSOL.
 */
const CORE_AFFIXES = [
  "OFFICIAL", "REAL", "OG", "ORIGINAL", "THE", "NEW", "CLASSIC", "V2", "2", "20", "II", "CTO", "COMMUNITY", "FAN",
  "PARODY", "ON SOL", "ON SOLANA", "ONSOL", "ONSOLANA", "SOL", "SOLANA", "COIN", "TOKEN",
];
// Each affix folded like the key it comes off ("OFFICIAL" is "OFFlClAL" there), the longest first: joined for a
// ticker, word by word for a name.
let tickerAffixes: string[] | undefined;
let nameAffixes: string[][] | undefined;

/** A ticker's core: affixes stripped from either end of its joined loose key. */
function tickerCore(loose: string): string {
  tickerAffixes ??= [...new Set(CORE_AFFIXES.map(looseKey))].sort((a, b) => b.length - a.length);
  let key = loose;
  for (;;) {
    // A key that is itself an affix is a whole name ("Solana"), not an affix to strip down further ("ANA").
    if (tickerAffixes.includes(key)) return key;
    const affix = tickerAffixes.find((a) => key.length - a.length >= MIN_CORE && (key.startsWith(a) || key.endsWith(a)));
    if (!affix) return key;
    key = key.startsWith(affix) ? key.slice(affix.length) : key.slice(0, -affix.length);
  }
}

/**
 * A name's core: whole-word affixes stripped from either end of its words, so that "Newton" or "Coinbase" keeps its
 * whole key. The last word is never stripped, nor any affix that would leave fewer than MIN_CORE characters.
 */
function nameCore(words: string[]): string {
  nameAffixes ??= CORE_AFFIXES.map((affix) => affix.split(" ").map(looseKey)).sort(
    (a, b) => b.join("").length - a.join("").length,
  );
  const at = (rest: string[], affix: string[], start: number) => affix.every((word, i) => rest[start + i] === word);
  let rest = words;
  for (;;) {
    const length = rest.join("").length;
    const affix = nameAffixes.find(
      (a) =>
        a.length < rest.length &&
        length - a.join("").length >= MIN_CORE &&
        (at(rest, a, 0) || at(rest, a, rest.length - a.length)),
    );
    if (!affix) return rest.join("");
    rest = at(rest, affix, 0) ? rest.slice(affix.length) : rest.slice(0, rest.length - affix.length);
  }
}

/**
 * A ticker's or a name's three keys (research/copycat-detection section 2). The field matters for the core key only, so
 * fold every text as what it is: a Protected coin's ticker as a ticker and its name as a name, as candidateKeys does.
 */
export function foldKeys(text: string, field: Field): Keys {
  const loose = looseKey(text);
  return { strict: strictKey(text), loose, core: field === "ticker" ? tickerCore(loose) : nameCore(looseWords(text)) };
}
