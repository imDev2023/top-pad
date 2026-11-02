import { describe, expect, it } from "vitest";
import { candidateKeys, judge, lookupValues, looksLikeName, nearKeys, nearLookupValues, nearMatches, type CoinKeys, type Judgement, type ProtectedCoin } from "./match";
import { deletions } from "./keys";

const coin = (mint: string, ticker: string, name: string): ProtectedCoin => ({
  mint,
  ticker,
  name,
  source: "test",
  keys: candidateKeys(ticker, name),
});

const PEPE = coin("pepe-mint", "PEPE", "Pepe");
const BONK = coin("bonk-mint", "BONK", "Bonk");
const WIF = coin("wif-mint", "WIF", "dogwifhat");
const XD = coin("xd-mint", "XD", "Extra Dimension");
const ROCKET = coin("rocket-mint", "RKT", "\u{1F680}\u{1F680}\u{1F680}");
const PROTECTED = [PEPE, BONK, WIF, XD, ROCKET];
// Its core key is PEPE's, so it meets every candidate whose core is PEPE; kept out of PROTECTED for that reason.
const PEPE2 = coin("pepe2-mint", "PEPE2", "Pepe Two");

/** Each match as field/kind/against and the coin's ticker, the shape the launch form and the operator queue read. */
const summary = (judgement: Judgement) =>
  judgement.verdict === "clear" ? [] : judgement.matches.map((m) => `${m.field} ${m.kind} ${m.against} ${m.coin.ticker}`);

const judged = (ticker: string, name: string, coins = PROTECTED) => judge(candidateKeys(ticker, name), coins);

describe("judging a launch against the Protected coins", () => {
  it("clears a coin that matches nothing", () => {
    expect(judged("FROG", "Frog Coin")).toEqual({ verdict: "clear" });
    expect(judged("FROG", "Frog")).toEqual({ verdict: "clear" });
  });

  it("refuses the same ticker by its strict key, and reports the coin once", () => {
    expect(summary(judged("PEPE", "Frog"))).toEqual(["ticker strict ticker PEPE"]);
    const judgement = judged("pepe", "Frog");
    expect(judgement.verdict === "refused" && judgement.matches[0]).toMatchObject({
      field: "ticker",
      kind: "strict",
      against: "ticker",
      coin: PEPE,
      reason: "The ticker looks the same as $PEPE (Pepe), a protected coin.",
    });
  });

  it("refuses a leetspeak ticker by its loose key", () => {
    expect(summary(judged("P3PE", "Frog"))).toEqual(["ticker loose ticker PEPE"]);
    const judgement = judged("P3PE", "Frog");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The ticker reads as $PEPE (Pepe), a protected coin, once digits and symbols are read as letters.",
    );
  });

  it("refuses a ticker with an authenticity or version word by its core key", () => {
    expect(summary(judged("OGPEPE", "Frog"))).toEqual(["ticker core ticker PEPE"]);
    expect(summary(judged("BONKCTO", "Frog"))).toEqual(["ticker core ticker BONK"]);
    const judgement = judged("OGPEPE", "Frog");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The ticker matches $PEPE (Pepe), a protected coin, once words such as OFFICIAL, 2 or CTO are left out.",
    );
  });

  it("refuses a ticker whose core is a Protected coin's name", () => {
    expect(summary(judged("DOGWIFHAT", "Frog"))).toEqual(["ticker core name WIF"]);
    const judgement = judged("DOGWIFHAT", "Frog");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The ticker matches the name of dogwifhat ($WIF), a protected coin.",
    );
  });

  it("refuses a lookalike name by its strict key", () => {
    const lookalikes = [
      "P\u{435}pe", // Cyrillic e
      "\u{3A1}\u{395}\u{3A1}\u{395}", // Greek capitals
      "\u{1D40F}\u{1D41E}\u{1D429}\u{1D41E}", // math bold
      "P e p e",
      "Pe\u{200B}pe", // zero-width space
      "\u{1D18}\u{1D07}\u{1D18}\u{1D07}", // small capitals
    ];
    for (const name of lookalikes) expect(summary(judged("FROG", name)), name).toEqual(["name strict name PEPE"]);
    const judgement = judged("FROG", "P\u{435}pe");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The name looks the same as Pepe ($PEPE), a protected coin.",
    );
  });

  it("refuses a leetspeak name by its loose key", () => {
    expect(summary(judged("FROG", "P3p3"))).toEqual(["name loose name PEPE"]);
    expect(summary(judged("FROG", "B0nk"))).toEqual(["name strict name BONK"]);
  });

  it("refuses a name with an authenticity or version word by its core key", () => {
    expect(summary(judged("FROG", "Official Pepe"))).toEqual(["name core name PEPE"]);
    expect(summary(judged("FROG", "Bonk on SOL"))).toEqual(["name core name BONK"]);
    const judgement = judged("FROG", "Official Pepe");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The name matches Pepe ($PEPE), a protected coin, once words such as OFFICIAL, 2 or CTO are left out.",
    );
  });

  it("refuses a name whose core is a Protected coin's ticker", () => {
    expect(summary(judged("FROG", "WIF Official"))).toEqual(["name core ticker WIF"]);
    const judgement = judged("FROG", "WIF Official");
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The name matches the ticker of dogwifhat ($WIF), a protected coin, once words such as OFFICIAL, 2 or CTO are left out.",
    );
    // "Pepe Coin" as a name meets $PEPE's ticker even where the coin's own name is different.
    expect(summary(judged("FROG", "Pepe Coin", [coin("frog-mint", "PEPE", "Pepe the Frog")]))).toEqual([
      "name core ticker PEPE",
    ]);
  });

  it("clears single-word names that only start or end like an affix", () => {
    const toncoin = coin("ton-mint", "TON", "Toncoin");
    const others = [toncoin, coin("tom-mint", "TOM", "Tom"), coin("base-mint", "BASE", "Base"), coin("mis-mint", "MIS", "Mithril Share")];
    for (const name of ["Newton", "Fantom", "Coinbase", "Themis"]) {
      expect(judged("FROG", name, others), name).toEqual({ verdict: "clear" });
    }
    expect(judged("NWTN", "Newton", [toncoin])).toEqual({ verdict: "clear" });
    // A ticker has no word boundaries, so NEWTON as a ticker still meets $TON.
    expect(summary(judged("NEWTON", "Frog", [toncoin]))).toEqual(["ticker core ticker TON"]);
  });

  it("orders matches ticker first, then strict before loose before core, whatever the Protected coins' order", () => {
    const coins = [PEPE, BONK, PEPE2];
    // PEPE2's ticker by its strict key, PEPE's by its core key; the name meets BONK.
    expect(summary(judged("PEPE2", "Official Bonk", coins))).toEqual([
      "ticker strict ticker PEPE2",
      "ticker core ticker PEPE",
      "name core name BONK",
    ]);
    expect(summary(judged("P3PE", "B0NK 2", coins))).toEqual([
      "ticker loose ticker PEPE",
      "ticker core ticker PEPE2",
      "name core name BONK",
    ]);
  });

  it("never matches empty keys, nor core keys shorter than MIN_CORE", () => {
    // An emoji-only name has empty keys, like ROCKET's.
    expect(judged("FROG", "\u{1F680}")).toEqual({ verdict: "clear" });
    // "XD" as a name is XD's ticker by every key, but core keys of 2 characters never match.
    expect(judged("FROG", "XD")).toEqual({ verdict: "clear" });
    // A short strict key does match: the same ticker is the same ticker.
    expect(summary(judged("XD", "Frog"))).toEqual(["ticker strict ticker XD"]);
  });

  it("shows outside text without control or invisible characters", () => {
    const odd = coin("odd-mint", "$ODD\u{202E}", "Odd\u{200B} Coin\n");
    const judgement = judge(candidateKeys("ODD", "Frog"), [odd]);
    expect(judgement.verdict === "refused" && judgement.matches[0]!.reason).toBe(
      "The ticker looks the same as $ODD (Odd Coin), a protected coin.",
    );
  });
});

describe("lookup values", () => {
  it("name, column by column, the keys that can match it", () => {
    expect(lookupValues(candidateKeys("PEPE2", "Official Pepe"))).toEqual({
      ticker: { strict: ["PEPE2"], loose: ["PEPEZ"], core: ["PEPE"] },
      name: { strict: ["OFFlClALPEPE"], loose: ["OFFlClALPEPE"], core: ["PEPE"] },
    });
    expect(lookupValues(candidateKeys("WIF", "Dog Wif Hat"))).toEqual({
      ticker: { strict: ["WlF"], loose: ["WlF"], core: ["WlF", "DOGWlFHAT"] },
      name: { strict: ["DOGWlFHAT"], loose: ["DOGWlFHAT"], core: ["WlF", "DOGWlFHAT"] },
    });
  });

  it("leave out empty and short core keys", () => {
    expect(lookupValues(candidateKeys("XD", "\u{1F680}"))).toEqual({
      ticker: { strict: ["XD"], loose: ["XD"], core: [] },
      name: { strict: [], loose: [], core: [] },
    });
  });

  it("fetch every Protected coin that judge would match, so judging the fetched rows changes nothing", () => {
    const fetched = (candidate: CoinKeys) => {
      const lookup = lookupValues(candidate);
      return PROTECTED.filter((p) =>
        (["ticker", "name"] as const).some((field) =>
          (["strict", "loose", "core"] as const).some((kind) => lookup[field][kind].includes(p.keys[field][kind])),
        ),
      );
    };
    const candidates: [string, string][] = [
      ["PEPE", "Frog"],
      ["P3PE", "Frog"],
      ["OGPEPE", "Frog"],
      ["DOGWIFHAT", "Frog"],
      ["FROG", "P\u{435}pe"],
      ["FROG", "Official Pepe"],
      ["FROG", "WIF Official"],
      ["PEPE2", "Official Bonk"],
      ["XD", "\u{1F680}"],
      ["FROG", "Frog Coin"],
    ];
    for (const [ticker, name] of candidates) {
      const candidate = candidateKeys(ticker, name);
      expect(judge(candidate, fetched(candidate)), `${ticker} ${name}`).toEqual(judge(candidate, PROTECTED));
    }
  });
});

describe("near matches, which launch labelled \"looks like X\"", () => {
  const near = (ticker: string, name: string, coins: readonly ProtectedCoin[] = PROTECTED) =>
    nearMatches(candidateKeys(ticker, name), nearKeys(ticker, name), coins).map((n) => `${n.field} ${n.rule} ${n.against} ${n.coin.ticker}`);

  it("labels a Protected coin's ticker or name with a derivative word added", () => {
    expect(near("BABYPEPE", "Frog")).toEqual(["ticker derivative ticker PEPE"]);
    expect(near("PEPEINU", "Frog")).toEqual(["ticker derivative ticker PEPE"]);
    expect(near("KINGBONK", "Frog")).toEqual(["ticker derivative ticker BONK"]);
    expect(near("FROG", "Baby Pepe")).toEqual(["name derivative name PEPE"]);
    expect(near("FROG", "Pepe Inu")).toEqual(["name derivative name PEPE"]);
    // Several derivative words, and an authenticity word under them, all come off.
    expect(near("FROG", "Official Mini Pepe King")).toEqual(["name derivative name PEPE"]);
    expect(near("BABYPEPEINU", "Frog")).toEqual(["ticker derivative ticker PEPE"]);
    // Against the other field: a name built on $WIF's ticker, and a ticker built on dogwifhat's name.
    expect(near("FROG", "Baby Wif")).toEqual(["name derivative ticker WIF"]);
    expect(near("FROG", "Dogwifhat Inu")).toEqual(["name derivative name WIF"]);
    // DOG is itself a derivative word, so BABYDOGWIF comes down to $WIF.
    expect(near("BABYDOGWIF", "Frog")).toEqual(["ticker derivative ticker WIF"]);
  });

  it("explains the label in the launch form's words", () => {
    const [found] = nearMatches(candidateKeys("BABYPEPE", "Frog"), nearKeys("BABYPEPE", "Frog"), PROTECTED);
    expect(found!.reason).toBe('The ticker builds on $PEPE, a protected coin, with a word such as BABY or INU: it can launch, labelled "looks like $PEPE" on its page.');
    const [edit] = nearMatches(candidateKeys("BONKK", "Frog"), nearKeys("BONKK", "Frog"), PROTECTED);
    expect(edit!.reason).toBe('The ticker is one letter away from $BONK, a protected coin: it can launch, labelled "looks like $BONK" on its page.');
  });

  it("labels a key one edit from a Protected coin's, only from 5 characters", () => {
    const long = coin("dogwif-mint", "DOGWIF", "Dogwif");
    // A letter added, changed, left out, and two neighbours swapped.
    expect(near("BONKK", "Frog")).toEqual(["ticker edit ticker BONK"]);
    expect(near("DOGWIT", "Frog", [long])).toEqual(["ticker edit ticker DOGWIF"]);
    expect(near("DOGWF", "Frog", [long])).toEqual(["ticker edit ticker DOGWIF"]);
    expect(near("DOGIWF", "Frog", [long])).toEqual(["ticker edit ticker DOGWIF"]);
    expect(near("FROG", "Dogwfi", [long])).toEqual(["name edit name DOGWIF"]);
    // Two edits away, or a candidate of 4 characters, is no label.
    expect(near("DOGXIT", "Frog", [long])).toEqual([]);
    expect(near("BONX", "Frog")).toEqual([]);
    expect(near("PEEP", "Frog")).toEqual([]);
  });

  it("never reports a coin that judge refuses on, nor a coin twice for one field", () => {
    // BABYPEPE as a name also strictly matches nothing; as a ticker with PEPE's name it is refused by the name.
    expect(near("BABYPEPE", "Pepe")).toEqual([]);
    const pepeKing = coin("pk-mint", "PEPEKING", "Pepe King");
    expect(near("BABYPEPE", "Frog", [PEPE, pepeKing])).toEqual(["ticker derivative ticker PEPE"]);
  });

  it("clears ordinary coins and derivative words alone", () => {
    expect(near("FROG", "Frog Coin")).toEqual([]);
    expect(near("BABY", "Baby")).toEqual([]);
    expect(near("CATDOG", "Cat Dog")).toEqual([]);
  });

  it("names the coin a label points at by its ticker, else its name", () => {
    expect(looksLikeName(PEPE)).toBe("$PEPE");
    expect(looksLikeName({ mint: "m", ticker: "", name: "Nameless" })).toBe("Nameless");
    expect(looksLikeName({ mint: "m", ticker: "$WIF", name: "dogwifhat" })).toBe("$WIF");
  });

  it("looks near coins up by every value nearMatches compares, so judging the fetched rows changes nothing", () => {
    const long = coin("dogwif-mint", "DOGWIF", "Dogwif");
    const all = [...PROTECTED, long, PEPE2];
    const fetched = (ticker: string, name: string) => {
      const keys = candidateKeys(ticker, name);
      const lookup = nearLookupValues(keys, nearKeys(ticker, name));
      return all.filter(
        (p) =>
          lookup.core.includes(p.keys.ticker.core) ||
          lookup.core.includes(p.keys.name.core) ||
          (["ticker", "name"] as const).some(
            (f) => lookup.loose[f].deletions.includes(p.keys[f].loose) || deletions(p.keys[f].loose).some((d) => lookup.loose[f].withSelf.includes(d)),
          ),
      );
    };
    for (const [ticker, name] of [
      ["BABYPEPE", "Frog"],
      ["FROG", "Baby Wif"],
      ["BONKK", "Frog"],
      ["DOGIWF", "Dogwfi"],
      ["DOGWF", "Frog"],
      ["FROG", "Frog"],
    ] as const) {
      const keys = candidateKeys(ticker, name);
      const expected = nearMatches(keys, nearKeys(ticker, name), all);
      expect(nearMatches(keys, nearKeys(ticker, name), fetched(ticker, name)), `${ticker} ${name}`).toEqual(expected);
    }
  });
});
