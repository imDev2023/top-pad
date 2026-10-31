// Vamp Shield's text rules in the launch service (spec 6.2): the ticker and name rules, then the folded keys against
// the Protected coins, fetched with indexed equality on each key column before `judge` decides. A refusal is our launch
// key declining to co-sign. The images, the protected set's sources and the "looks like X" labels come with "Vamp
// Shield: images and the protected set".
import { and, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { VampShieldCheck, type FieldVerdict, type VampShieldVerdict } from "@top-pad/contract";
import { protectedCoins, type Db } from "@top-pad/db";
import { candidateKeys, FOLD_VERSION, foldKeys, judge, lookupValues, type CoinKeys, type Field, type ProtectedCoin } from "@top-pad/vamp-shield";
import { canonicalName, canonicalTicker, nameVerdict, teaserVerdict, tickerVerdict } from "@top-pad/vamp-shield/rules";
import type { AppEnv } from "./http";

const clear: FieldVerdict = { status: "clear", reason: null, match: null };
const refused = (reason: string, match: FieldVerdict["match"] = null): FieldVerdict => ({ status: "refused", reason, match });

const COLUMNS = {
  ticker: { strict: protectedCoins.tickerStrict, loose: protectedCoins.tickerLoose, core: protectedCoins.tickerCore },
  name: { strict: protectedCoins.nameStrict, loose: protectedCoins.nameLoose, core: protectedCoins.nameCore },
} as const;

/** The Protected coins whose keys can match a candidate's, still protected now. */
async function candidates(db: Db, lookup: ReturnType<typeof lookupValues>): Promise<ProtectedCoin[]> {
  const matching: SQL[] = [];
  for (const field of ["ticker", "name"] as const) {
    for (const kind of ["strict", "loose", "core"] as const) {
      const values = lookup[field][kind];
      if (values.length > 0) matching.push(inArray(COLUMNS[field][kind], values));
    }
  }
  if (matching.length === 0) return [];
  const rows = await db
    .select()
    .from(protectedCoins)
    .where(and(or(isNull(protectedCoins.protectedUntil), gt(protectedCoins.protectedUntil, sql`now()`)), or(...matching)));
  return rows.map((r) => ({
    mint: r.mint,
    ticker: r.ticker,
    name: r.name,
    source: r.source,
    // A row folded under another version is judged on keys folded now. The lookup above still finds rows by their
    // stored keys, so the protected set's refresh must rewrite them whenever FOLD_VERSION changes.
    keys:
      r.foldVersion === FOLD_VERSION
        ? { ticker: { strict: r.tickerStrict, loose: r.tickerLoose, core: r.tickerCore }, name: { strict: r.nameStrict, loose: r.nameLoose, core: r.nameCore } }
        : candidateKeys(r.ticker, r.name),
  }));
}

/** Vamp Shield's verdict on a ticker and a name: the rules first, then the Protected coins. */
export async function checkText(db: Db, tickerInput: string, nameInput: string): Promise<VampShieldVerdict> {
  const ticker = tickerVerdict(tickerInput);
  const name = nameVerdict(nameInput);
  const verdicts: Record<Field, FieldVerdict> = {
    ticker: ticker.ok ? clear : refused(ticker.reason),
    name: name.ok ? clear : refused(name.reason),
  };
  // A field the rules refuse is not folded: it cannot launch as it is, and its keys would only add noise.
  const keys = candidateKeys(ticker.ok ? ticker.ticker : "", name.ok ? name.name : "");
  const judgement = judge(keys, await candidates(db, lookupValues(keys)));
  if (judgement.verdict === "refused") {
    for (const field of ["ticker", "name"] as const) {
      const match = judgement.matches.find((m) => m.field === field);
      if (match && verdicts[field].status === "clear") {
        verdicts[field] = refused(match.reason, { mint: match.coin.mint, ticker: match.coin.ticker, name: match.coin.name });
      }
    }
  }
  return {
    ticker: ticker.ok ? ticker.ticker : canonicalTicker(tickerInput),
    name: name.ok ? name.name : canonicalName(nameInput),
    verdicts,
    clear: verdicts.ticker.status === "clear" && verdicts.name.status === "clear",
  };
}

/** The longest run of words in a teaser read as a coin's name: most names are one to three words. */
const TEASER_PHRASE_WORDS = 4;
/** The shortest word in a teaser read as a ticker: shorter ones are everyday words far more often than coins. */
const TEASER_TICKER_MIN = 3;

/**
 * Vamp Shield's verdict on a Fair Open's teaser (spec 2.1 step 4): the text rules, then whether it names a Protected
 * coin. Each run of up to four words is read as a name, matched by its strict and loose keys against Protected names,
 * and each word of three or more letters and digits as a ticker, matched by its strict key against Protected tickers.
 * Core keys are left out: they strip words such as OFFICIAL from free text and would refuse ordinary sentences.
 */
export async function checkTeaser(db: Db, input: string): Promise<{ ok: true; teaser: string } | { ok: false; reason: string }> {
  const rules = teaserVerdict(input);
  if (!rules.ok || rules.teaser === "") return rules;
  const words = rules.teaser.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrases: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= TEASER_PHRASE_WORDS && i + n <= words.length; n++) phrases.push(words.slice(i, i + n).join(" "));
  }
  const names = phrases.map((p) => foldKeys(p, "name"));
  const tickers = words.filter((w) => Array.from(w).length >= TEASER_TICKER_MIN).map((w) => foldKeys(w, "ticker"));
  const values = (keys: string[]) => [...new Set(keys.filter((k) => k.length > 0))];
  const lookup = {
    ticker: { strict: values(tickers.map((k) => k.strict)), loose: [], core: [] },
    name: { strict: values(names.map((k) => k.strict)), loose: values(names.map((k) => k.loose)), core: [] },
  };
  const found = await candidates(db, lookup);
  const empty = { strict: "", loose: "", core: "" };
  for (const keys of [...tickers.map((ticker): CoinKeys => ({ ticker: { ...empty, strict: ticker.strict }, name: empty })), ...names.map((name): CoinKeys => ({ ticker: empty, name: { ...name, core: "" } }))]) {
    const judgement = judge(keys, found);
    if (judgement.verdict === "refused") {
      const coin = judgement.matches[0]!.coin;
      return { ok: false, reason: `The teaser names ${coin.name} ($${coin.ticker.replace(/^\$/, "")}), a protected coin: the calendar cannot carry another coin's name.` };
    }
  }
  return rules;
}

/** The reason a refused launch shows first: the ticker's, else the name's. */
export const firstRefusal = (v: VampShieldVerdict) => v.verdicts.ticker.reason ?? v.verdicts.name.reason ?? "Vamp Shield refused this launch.";

/** `POST /vamp-shield/check`: the launch flow's live text verdicts. */
export async function checkRoute(c: Context<AppEnv>) {
  const body = VampShieldCheck.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a ticker and a name." }, 400);
  return c.json(await checkText(c.var.db, body.data.ticker, body.data.name));
}

