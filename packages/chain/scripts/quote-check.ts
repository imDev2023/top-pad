// `pnpm --filter @top-pad/chain quote-check [--out <file.json>]`: reads every quote mint DBC has badged on mainnet and
// checks each against `quoteVerdict` (ADR 0007, "Which quotes"), then prints the xStocks among them: those whose
// permanent delegate is NVDAx's, the xStocks issuer's key. #84 starts by running it, since whether the xStocks still pass
// is read from the chain, never assumed from Stoker's snapshot. It then checks Heat's mainnet quote list in `CLUSTERS`
// (the cohort's 22 xStocks, #89) against what it read: each listed mint badged, passing, of its listed token program and
// decimals, and named by its listed symbol; it exits 1 if any is not.
//
// Read-only and free: Solana's public mainnet endpoint, no key, no transaction. That endpoint allows about 10 calls of a
// method per 10 s and answers more with 429 (CLAUDE.md, Traps), so each call waits its turn and retries after a 429.
import { writeFileSync } from "node:fs";
import { address, getAddressDecoder, getBase64Encoder, type Address } from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import { CLUSTERS } from "../src/index";
import { quoteVerdict, scaledUiMultiplier, type QuoteVerdict } from "../src/quotes";

const RPC = "https://api.mainnet-beta.solana.com";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
/** `TokenBadge`'s discriminator and size in DBC's IDL (8 + the mint + 128 bytes reserved). */
const BADGE_DISCRIMINATOR = Buffer.from([116, 219, 204, 229, 249, 116, 255, 150]).toString("base64");
const BADGE_SIZE = 168;
/** NVDAx, whose permanent delegate names the xStocks issuer. */
const XSTOCK_REFERENCE = address("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;

let last = 0;
async function call<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + 1_100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status === 429 && attempt < 10) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error || body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}

type RawAccount = { owner: string; data: [string, "base64"] } | null;
const bytes = (data: [string, "base64"]) => getBase64Encoder().encode(data[0]);

const badges = await call<{ account: { data: [string, "base64"] } }[]>("getProgramAccounts", [
  DBC,
  {
    encoding: "base64",
    dataSlice: { offset: 8, length: 32 },
    filters: [{ dataSize: BADGE_SIZE }, { memcmp: { offset: 0, bytes: BADGE_DISCRIMINATOR, encoding: "base64" } }],
  },
]);
const badged = badges.map(({ account }) => getAddressDecoder().decode(bytes(account.data)));
console.error(`${badged.length} DBC TokenBadges on mainnet`);

type Row = { mint: Address; owner: Address; symbol: string | null; name: string | null; decimals: number } & QuoteVerdict;
const rows: Row[] = [];
for (let start = 0; start < badged.length; start += 100) {
  const batch = badged.slice(start, start + 100);
  const { value } = await call<{ value: RawAccount[] }>("getMultipleAccounts", [batch, { encoding: "base64" }]);
  value.forEach((account, index) => {
    if (!account) return;
    const mint = getMintDecoder().decode(bytes(account.data));
    const metadata = mint.extensions.__option === "Some" ? mint.extensions.value.find((e) => e.__kind === "TokenMetadata") : undefined;
    rows.push({
      mint: batch[index]!,
      owner: address(account.owner),
      symbol: metadata?.__kind === "TokenMetadata" ? metadata.symbol : null,
      name: metadata?.__kind === "TokenMetadata" ? metadata.name : null,
      decimals: mint.decimals,
      ...quoteVerdict({ address: batch[index]!, tokenProgram: address(account.owner), mint, tokenBadge: true }),
    });
  });
  console.error(`read ${Math.min(start + 100, badged.length)} of ${badged.length}`);
}

const issuer = rows.find((row) => row.mint === XSTOCK_REFERENCE)?.powers.permanentDelegate;
if (!issuer) throw new Error("NVDAx holds no DBC TokenBadge or no permanent delegate any more: read the xStocks issuer again");
const xstocks = rows.filter((row) => row.powers.permanentDelegate === issuer).sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? ""));

const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const extensionSets = new Map<string, number>();
for (const row of xstocks) extensionSets.set(row.extensions.join(","), (extensionSets.get(row.extensions.join(",")) ?? 0) + 1);
const summary = {
  readAt: new Date().toISOString(),
  badges: badged.length,
  mintsRead: rows.length,
  xstocksIssuer: issuer,
  xstocks: xstocks.length,
  xstocksAccepted: xstocks.filter((row) => row.accepted).length,
  refusals: Object.fromEntries(
    [...new Set(xstocks.flatMap((row) => row.refusals))].map((refusal) => [
      refusal,
      xstocks.filter((row) => row.refusals.includes(refusal)).map((row) => row.symbol ?? row.mint),
    ]),
  ),
  extensionSets: Object.fromEntries(extensionSets),
  decimals: [...new Set(xstocks.map((row) => row.decimals))],
  pauseAuthorities: [...new Set(xstocks.map((row) => row.powers.pauseAuthority))],
  scaledUiAmount: (() => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const multipliers = xstocks.flatMap((row) => (row.powers.scaledUiAmount ? [scaledUiMultiplier(row.powers.scaledUiAmount, now)] : []));
    return {
      mints: multipliers.length,
      notOne: multipliers.filter((multiplier) => multiplier !== 1).length,
      lowest: Math.min(...multipliers),
      highest: Math.max(...multipliers),
    };
  })(),
};
console.log(json(summary));
for (const row of xstocks) console.log(`${(row.symbol ?? "?").padEnd(10)} ${row.mint} ${row.accepted ? "accepted" : `refused: ${row.refusals.join(", ")}`}`);
if (out) writeFileSync(out, json({ summary, xstocks }));

// Heat's mainnet quote list against the chain (#89): SOL is SOL; every other listed quote must be an xStock read above.
const listed = CLUSTERS.mainnet!.quotes.slice(1);
const wrong = listed.flatMap((q) => {
  const row = xstocks.find((x) => x.mint === q.mint);
  if (!row) return [`${q.symbol} ${q.mint}: no DBC TokenBadge, or not an xStock`];
  const problems = [
    row.symbol !== q.symbol && `its symbol is ${row.symbol}`,
    row.owner !== q.tokenProgram && `its token program is ${row.owner}`,
    row.decimals !== q.decimals && `it has ${row.decimals} decimals`,
    !row.accepted && `it is refused: ${row.refusals.join(", ")}`,
  ].filter(Boolean);
  return problems.length ? [`${q.symbol} ${q.mint}: ${problems.join("; ")}`] : [];
});
console.log(`Heat's mainnet list: ${listed.length - wrong.length} of ${listed.length} xStocks as listed.`);
for (const line of wrong) console.log(`  ${line}`);
if (wrong.length) process.exit(1);
