// Vamp Shield's rules for what a creator may enter as a coin's ticker and name (spec 2.1 step 3, 6.2). The launch form
// runs them as the creator types and the API runs them again before anything is scheduled, so this file stays
// browser-safe: it imports nothing, and above all not ./keys, which carries the whole confusables table.

/** A ticker is 2 to 10 characters of A-Z and 0-9 (spec 2.1), within Metaplex's 10-byte cap on a token's symbol. */
export const TICKER_MIN_LENGTH = 2;
export const TICKER_MAX_LENGTH = 10;
/** Metaplex caps a token's on-chain name at 32 bytes of UTF-8 (`MAX_NAME_LENGTH` in mpl-token-metadata). */
export const NAME_MAX_BYTES = 32;

export type TickerVerdict = { ok: true; ticker: string } | { ok: false; reason: string };
export type NameVerdict = { ok: true; name: string } | { ok: false; reason: string };

/** The ticker as it is checked, stored and written on chain: NFKC, trimmed, upper case. */
export const canonicalTicker = (input: string) => input.normalize("NFKC").trim().toUpperCase();

/** The canonical ticker, or the reason the launch form shows for refusing it. */
export function tickerVerdict(input: string): TickerVerdict {
  const ticker = canonicalTicker(input);
  const refuse = (reason: string): TickerVerdict => ({ ok: false, reason });
  if (ticker === "") return refuse(`Enter a ticker of ${TICKER_MIN_LENGTH} to ${TICKER_MAX_LENGTH} letters or digits.`);
  // Before the length checks, which then count ASCII characters only.
  if (!/^[A-Z0-9]+$/.test(ticker)) {
    return refuse("The ticker can only use the letters A to Z and the digits 0 to 9, which keeps out lookalike letters from other alphabets.");
  }
  if (ticker.length < TICKER_MIN_LENGTH) return refuse(`The ticker needs at least ${TICKER_MIN_LENGTH} characters.`);
  if (ticker.length > TICKER_MAX_LENGTH) return refuse(`The ticker can have at most ${TICKER_MAX_LENGTH} characters.`);
  return { ok: true, ticker };
}

/** The name as it is checked, stored and written on chain: NFC, so an accent typed either way is the same, trimmed. */
export const canonicalName = (input: string) => input.normalize("NFC").trim();

/** The canonical name, or the reason the launch form shows for refusing it. */
export function nameVerdict(input: string): NameVerdict {
  const name = canonicalName(input);
  const refuse = (reason: string): NameVerdict => ({ ok: false, reason });
  if (name === "") return refuse("Enter a name.");
  // First, so the checks below never run on a long text.
  const bytes = utf8Length(name);
  if (bytes > NAME_MAX_BYTES) {
    return refuse(
      `The name is ${bytes} bytes long and Solana token metadata holds at most ${NAME_MAX_BYTES}; accented letters, other alphabets and emoji take 2 to 4 bytes each.`,
    );
  }
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return refuse("The name cannot contain line breaks or other control characters.");
  // A lone surrogate: only a broken client sends one, and it has no UTF-8 form to write on chain.
  if (/\p{Cs}/u.test(name)) return refuse("The name is not valid Unicode text.");
  if (hasHiddenCharacter(name)) {
    return refuse("The name cannot contain invisible characters, such as zero-width spaces or text direction controls.");
  }
  if (hasUnassignedCharacter(name)) {
    return refuse("The name has a private-use or unassigned character, which looks different on every device.");
  }
  if (restrictionLevel(name) !== "minimally-restrictive") return { ok: true, name };
  const sets = scriptSets(name, FIRST_SCRIPTS);
  const has = (script: string, ...not: string[]) => sets.some((set) => set.has(script) && not.every((s) => !set.has(s)));
  if (has("Latn", "Cyrl", "Grek") && (has("Cyrl", "Latn") || has("Grek", "Latn"))) {
    return refuse("The name mixes Latin letters with Cyrillic or Greek ones, which is how lookalike names are made; use one alphabet.");
  }
  return refuse("The name mixes letters from scripts that are not written together, which is how lookalike names are made; use one script.");
}

/** UTF-8 length; a lone surrogate counts 3 bytes, as the U+FFFD that an encoder writes in its place. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Default_Ignorable code points, plus two invisible characters that are not: the braille blank, a blank that fills a
// name out to look empty or like another, and the interlinear annotation controls, which can hide text.
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\u{2800}\u{FFF9}-\u{FFFB}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /\p{Emoji_Modifier}/u;
const KEYCAP_BASE = /^[#*0-9]$/;

/**
 * Whether the text holds a hidden character (zero-width characters, bidi controls, Hangul fillers, tag characters,
 * variation selectors...) other than the ones emoji are made of: U+FE0F after a pictograph ("☀️") or in a keycap
 * ("1️⃣"), and U+200D between two pictographs ("👨‍💻"), the first perhaps followed by U+FE0F or a skin tone. Tag
 * characters stay refused, subdivision flags with them, since they can carry hidden text.
 */
function hasHiddenCharacter(text: string): boolean {
  const cps = Array.from(text);
  return cps.some((c, i) => HIDDEN.test(c) && !partOfEmoji(cps, i));
}

function partOfEmoji(cps: string[], i: number): boolean {
  const before = cps[i - 1] ?? "";
  const after = cps[i + 1] ?? "";
  if (cps[i] === "\u{FE0F}") return PICTOGRAPHIC.test(before) || (KEYCAP_BASE.test(before) && after === "\u{20E3}");
  if (cps[i] !== "\u{200D}") return false;
  const left = before === "\u{FE0F}" || SKIN_TONE.test(before) ? (cps[i - 2] ?? "") : before;
  return PICTOGRAPHIC.test(left) && PICTOGRAPHIC.test(after);
}

/** Private-use and unassigned code points. An unassigned pictograph passes: it is an emoji newer than this runtime. */
function hasUnassignedCharacter(text: string): boolean {
  return Array.from(text).some((c) => /\p{Co}/u.test(c) || (/\p{Cn}/u.test(c) && !PICTOGRAPHIC.test(c)));
}

/**
 * UAX #31 Table 5, Recommended Scripts (Unicode 18.0.0): scripts in widespread everyday use, any one of which a name
 * may mix with Latin, except Cyrillic and Greek. Bopomofo left the table in Unicode 17; it still mixes with Han.
 */
export const RECOMMENDED_SCRIPTS = [
  "Arab", "Armn", "Beng", "Cyrl", "Deva", "Ethi", "Geor", "Grek", "Gujr", "Guru", "Hang", "Hani", "Hebr", "Hira",
  "Kana", "Khmr", "Knda", "Laoo", "Latn", "Mlym", "Mymr", "Orya", "Sinh", "Taml", "Telu", "Thaa", "Thai", "Tibt",
] as const;

/** The scripts a name is judged on first: the Recommended ones, and Bopomofo, which makes Hanb with Han. */
const FIRST_SCRIPTS: readonly string[] = [...RECOMMENDED_SCRIPTS, "Bopo"];

// Every other script in Unicode 18.0.0 (PropertyValueAliases.txt), so that a name wholly in one of them is still
// single-script. Hrkt is left out: no character has it, and V8 refuses it as a Script_Extensions value.
const OTHER_SCRIPTS = `
Adlm Aghb Ahom Armi Avst Bali Bamu Bass Batk Berf Bhks Brah Brai Bugi Buhd Cakm Cans Cari Cham Cher Chrs Copt
Cpmn Cprt Diak Dogr Dsrt Dupl Egyp Elba Elym Gara Glag Gong Gonm Goth Gran Gukh Hano Hatr Hluw Hmng Hmnp Hung
Ital Java Jurc Kali Kawi Khar Khoj Kits Krai Kthi Lana Lepc Limb Lina Linb Lisu Lyci Lydi Mahj Maka Mand Mani
Marc Medf Mend Merc Mero Modi Mong Mroo Mtei Mult Nagm Nand Narb Nbat Newa Nkoo Nshu Ogam Olck Onao Orkh Osge
Osma Ougr Palm Pauc Pcun Perm Phag Phli Phlp Phnx Plrd Prti Rjng Rohg Runr Samr Sarb Saur Seal Sgnw Shaw Shrd
Sidd Sidt Sind Sogd Sogo Sora Soyo Sund Sunu Sylo Syrc Tagb Takr Tale Talu Tang Tavt Tayo Tfng Tglg Tirh Tnsa
Todr Tols Toto Tutg Ugar Vaii Vith Wara Wcho Xpeo Xsux Yezi Yiii Zanb`;
const EVERY_SCRIPT: readonly string[] = [...FIRST_SCRIPTS, ...OTHER_SCRIPTS.trim().split(/\s+/)];

const patterns = new Map<string, RegExp | null>();

/**
 * A script's Script_Extensions pattern, compiled on first use and kept: all 175 take tens of milliseconds to compile,
 * the first ones a few. Null for a script newer than the runtime's Unicode, whose letters are unassigned there and
 * refused as such.
 */
function scriptPattern(script: string): RegExp | null {
  if (!patterns.has(script)) {
    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(`\\p{scx=${script}}`, "u");
    } catch {
      // Not a script in this runtime's Unicode.
    }
    patterns.set(script, pattern);
  }
  return patterns.get(script) ?? null;
}

const COMMON_OR_INHERITED = /[\p{scx=Zyyy}\p{scx=Zinh}]/u;

/**
 * The augmented script set (UTS #39 section 5.1) of each character that is not Common or Inherited: its
 * Script_Extensions among the given scripts, plus the writing systems that combine scripts, Hanb (Han with Bopomofo),
 * Hntl (Han with Latin), Jpan and Kore. A pictograph counts as Common even when this runtime does not know it yet.
 */
function scriptSets(text: string, scripts: readonly string[]): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const c of text) {
    if (COMMON_OR_INHERITED.test(c) || PICTOGRAPHIC.test(c)) continue;
    const set = new Set(scripts.filter((script) => scriptPattern(script)?.test(c)));
    if (set.has("Hani")) for (const s of ["Hanb", "Hntl", "Jpan", "Kore"]) set.add(s);
    if (set.has("Hira") || set.has("Kana")) set.add("Jpan");
    if (set.has("Hang")) set.add("Kore");
    if (set.has("Bopo")) set.add("Hanb");
    if (set.has("Latn")) set.add("Hntl");
    sets.push(set);
  }
  return sets;
}

export type RestrictionLevel =
  | "ascii-only"
  | "single-script"
  | "highly-restrictive"
  | "moderately-restrictive"
  | "minimally-restrictive";

/**
 * The text's restriction level by UTS #39 section 5.2, without the identifier profile, which does not fit names: their
 * spaces, punctuation and emoji are outside it. A name is refused below Moderately Restrictive, that is when it mixes
 * Latin with Cyrillic or Greek, or mixes scripts other than as Latin with Chinese, Japanese, Korean or one other
 * Recommended script.
 *
 * One documented change (UTS-39-C4-2), for speed: the levels are found on FIRST_SCRIPTS, and every other script is
 * consulted only before answering Minimally Restrictive. So a text whose characters share no script but one outside
 * FIRST_SCRIPTS (two lone combining marks, say) can read as highly or moderately restrictive where the standard says
 * single-script; each of those levels accepts a name all the same.
 */
export function restrictionLevel(text: string): RestrictionLevel {
  if (/^\p{ASCII}*$/u.test(text)) return "ascii-only";
  const sets = scriptSets(text, FIRST_SCRIPTS);
  // A character without any of these scripts can be neither in their resolved set nor covered by them.
  if (sets.every((set) => set.size > 0)) {
    if (resolved(sets)) return "single-script";
    const coveredBy = (...cover: string[]) => sets.every((set) => cover.some((s) => set.has(s)));
    if (coveredBy("Latn", "Jpan") || coveredBy("Latn", "Hanb") || coveredBy("Latn", "Kore")) return "highly-restrictive";
    if (RECOMMENDED_SCRIPTS.some((s) => s !== "Cyrl" && s !== "Grek" && coveredBy("Latn", s))) return "moderately-restrictive";
  }
  return resolved(scriptSets(text, EVERY_SCRIPT)) ? "single-script" : "minimally-restrictive";
}

/** Whether the resolved script set, the intersection of the sets, is not empty: the text is single-script. */
function resolved(sets: Set<string>[]): boolean {
  const [first, ...rest] = sets;
  return !first || [...first].some((s) => rest.every((set) => set.has(s)));
}
