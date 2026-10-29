// Vamp Shield's text rules in the launch service (spec 6.2): the ticker and name rules, then the folded keys against
// the Protected coins, fetched with indexed equality on each key column before `judge` decides. A refusal is our launch
// key declining to co-sign. The images, the protected set's sources and the "looks like X" labels come with "Vamp
// Shield: images and the protected set".
import { and, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { VampShieldCheck, type FieldVerdict, type VampShieldVerdict } from "@top-pad/contract";
import { protectedCoins, type Db } from "@top-pad/db";
import { candidateKeys, FOLD_VERSION, judge, lookupValues, type Field, type ProtectedCoin } from "@top-pad/vamp-shield";
import { canonicalName, canonicalTicker, nameVerdict, tickerVerdict } from "@top-pad/vamp-shield/rules";
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

/** The reason a refused launch shows first: the ticker's, else the name's. */
export const firstRefusal = (v: VampShieldVerdict) => v.verdicts.ticker.reason ?? v.verdicts.name.reason ?? "Vamp Shield refused this launch.";

/** `POST /vamp-shield/check`: the launch flow's live text verdicts. */
export async function checkRoute(c: Context<AppEnv>) {
  const body = VampShieldCheck.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a ticker and a name." }, 400);
  return c.json(await checkText(c.var.db, body.data.ticker, body.data.name));
}

