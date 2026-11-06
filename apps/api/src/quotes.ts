// The quotes a coin can be priced in (ADR 0007; spec 3.2): every quote `@top-pad/chain` lists on the cluster, read from
// the chain as asked, never from a config written down: its mint (whose authorities and extensions are its Quote Risk
// Labels and whose Scaled UI Amount multiplier every page shows its amounts through), its DBC TokenBadge, and the
// `QuoteSettings` the band job keeps, which name its current config pair and deposit step. A quote is offered once it
// has settings and Heat's rules still take its mint. Pages read them through a short cache; a launch reads them fresh.
import { createSolanaRpc } from "@solana/kit";
import { potCapOf, rungs, WSOL_MINT, type HeatCluster, type HeatQuote } from "@top-pad/chain";
import { displayMultiplier, quoteLabels, quoteVerdict, type QuoteRefusal } from "@top-pad/chain/quotes";
import type { ListedQuote, QuoteInfo, QuoteList } from "@top-pad/contract";
import { rpcBandChain, type QuoteOnChain } from "@top-pad/quotes";
import type { Context } from "hono";
import { explorerUrl, type Config } from "./env";
import type { AppEnv } from "./http";

/** How long a read of the quotes serves pages: a pause or a new multiplier shows within this. */
const FRESH_MS = 30_000;

/** What a refusal of Heat's or DBC's means for a creator, a sentence each (spec 3.2). */
const WAITING: Record<QuoteRefusal, string> = {
  "unknown-token-program": "Its mint is not an SPL Token or Token-2022 mint.",
  "token-2022-native-mint": "Token-2022's wrapped SOL is not a quote Meteora takes.",
  "needs-token-badge": "It waits for Meteora's TokenBadge, without which Meteora's curves do not take it.",
  "transfer-fee": "It charges a transfer fee, which Heat never takes in a quote.",
  "transfer-fee-authority": "Its issuer can add a transfer fee, which Heat never takes in a quote.",
  "transfer-hook-program": "A transfer hook program runs on every transfer of it.",
  "default-state-frozen": "Every new account of it starts frozen.",
  paused: "Its issuer has paused every transfer of it.",
};

/** A quote as the chain holds it now, with what pages show of it. */
export type ReadQuote = { quote: HeatQuote; listed: ListedQuote };

const now = () => BigInt(Math.floor(Date.now() / 1000));

/** SOL as a quote: no issuer, no multiplier, nothing to read. */
function solInfo(cfg: Config, quote: HeatQuote): QuoteInfo {
  return { mint: quote.mint, symbol: quote.symbol, decimals: quote.decimals, multiplier: 1, labels: [], explorer: explorerUrl(cfg, "address", quote.mint) };
}

/** What a page shows of a quote and whether a coin can be launched in it, from its chain state. */
export function listedQuote(cfg: Config, quote: HeatQuote, onChain: QuoteOnChain | undefined, at = now()): ListedQuote {
  const sol = quote.mint === WSOL_MINT;
  const mint = onChain?.mint ?? null;
  const verdict = !sol && mint ? quoteVerdict(mint) : null;
  const info: QuoteInfo = sol
    ? solInfo(cfg, quote)
    : {
        ...solInfo(cfg, quote),
        multiplier: verdict ? displayMultiplier(verdict.powers, at) : 1,
        labels: verdict ? quoteLabels(verdict.powers, quote.symbol, at) : [],
      };
  const s = onChain?.settings ?? null;
  const target = s && s.fairOpenTarget !== null && s.fairOpenTarget === s.instantTarget ? s.fairOpenTarget : null;
  const settings =
    s && target !== null
      ? {
          fairOpenConfig: s.fairOpenConfig,
          instantConfig: s.instantConfig,
          step: `${s.step}`,
          graduationTarget: `${target}`,
          potCap: `${potCapOf(target)}`,
          rungs: rungs(potCapOf(target)).map((r) => `${r}`),
        }
      : null;
  let waiting: string | null = null;
  if (!sol && !mint) waiting = "Its mint is not on this cluster.";
  else if (verdict && !verdict.accepted) waiting = WAITING[verdict.refusals[0]!];
  else if (!s) waiting = "Its config pair is not named yet: Heat's band job names one within five minutes of its price.";
  else if (!settings) waiting = "Its config pair is not on chain as named.";
  return { ...info, offered: waiting === null, waiting, settings };
}

/** Reads every quote the cluster lists from the chain, in a few batched calls. */
export async function readQuotes(cfg: Config, heat: HeatCluster): Promise<ReadQuote[]> {
  const chain = rpcBandChain(createSolanaRpc(cfg.rpcUrl), async () => {
    throw new Error("reading quotes sends nothing");
  });
  // Each of its calls gives up after 15 s, so a stalled provider fails the read rather than hanging a page or a launch.
  const read = await chain.read(heat.quotes);
  const at = now();
  return heat.quotes.map((quote) => ({ quote, listed: listedQuote(cfg, quote, read.get(quote.mint), at) }));
}

/** The last read, kept `FRESH_MS` in this isolate; a failed read is not kept. */
let cached: { at: number; read: Promise<ReadQuote[]> } | null = null;

/** Every listed quote, read at most `FRESH_MS` ago. */
export function cachedQuotes(cfg: Config, heat: HeatCluster): Promise<ReadQuote[]> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.read;
  const read = readQuotes(cfg, heat);
  cached = { at: Date.now(), read };
  read.catch(() => (cached = null));
  return read;
}

/** Forgets the cached read: for tests. */
export function forgetQuotes() {
  cached = null;
}

/**
 * The quote a coin or launch is priced in, as its page shows it. SOL is known without a read; any other listed quote is
 * read through the cache. Every Heat config is in a listed quote (`loadHeatConfigs`), so any other mint is a fault.
 */
export async function quoteInfoOf(cfg: Config, heat: HeatCluster, mint: string): Promise<QuoteInfo> {
  const listed = heat.quotes.find((q) => q.mint === mint);
  if (!listed) throw new Error(`${mint} is not a quote Heat lists on ${cfg.cluster}`);
  if (listed.mint === WSOL_MINT) return solInfo(cfg, listed);
  return infoOf((await cachedQuotes(cfg, heat)).find((q) => q.quote.mint === mint)!.listed);
}

/** What a page shows of a listed quote, without what only the launch form's picker needs. */
const infoOf = (q: ListedQuote): QuoteInfo => ({ mint: q.mint, symbol: q.symbol, decimals: q.decimals, multiplier: q.multiplier, labels: q.labels, explorer: q.explorer });

/** The decimals of a listed quote, which never change: no read. */
export function quoteOf(heat: HeatCluster, mint: string): HeatQuote | null {
  return heat.quotes.find((q) => q.mint === mint) ?? null;
}

/** `GET /quotes`: every quote listed here, SOL first, each offered or saying what it waits for. */
export async function getQuotes(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const heat = cfg.heat;
  const body: QuoteList = { quotes: heat ? (await cachedQuotes(cfg, heat)).map((q) => q.listed) : [] };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/** A quote a launch can be priced in now: as listed, with its settings, and whether DBC takes it only with its badge. */
export type OfferedQuote = { quote: HeatQuote; info: QuoteInfo; settings: NonNullable<ListedQuote["settings"]>; badge: boolean };

/**
 * The quote a launch asks for, read from the chain now rather than through the cache, so the launch is built on the
 * config pair its `QuoteSettings` name this moment; a sentence saying why when it cannot be launched in.
 */
export async function offeredQuote(cfg: Config, heat: HeatCluster, mint: string): Promise<OfferedQuote | { refusal: string }> {
  const quote = heat.quotes.find((q) => q.mint === mint);
  if (!quote) return { refusal: `Heat does not price coins in ${mint} on ${cfg.cluster}: choose one of the quotes the launch form lists.` };
  const chain = rpcBandChain(createSolanaRpc(cfg.rpcUrl), async () => {
    throw new Error("reading a quote sends nothing");
  });
  const onChain = (await chain.read([quote])).get(quote.mint);
  const listed = listedQuote(cfg, quote, onChain);
  if (!listed.offered || !listed.settings) return { refusal: `A coin cannot be priced in ${quote.symbol} now: ${listed.waiting}` };
  const { settings } = listed;
  const info = infoOf(listed);
  // DBC takes some Token-2022 quotes only with their TokenBadge, which a pool's creation then names (ADR 0007).
  const mintRead = onChain?.mint ?? null;
  const badge = mintRead !== null && mintRead.tokenBadge && !quoteVerdict({ ...mintRead, tokenBadge: false }).dbcAccepts;
  return { quote, info, settings, badge };
}

/**
 * An amount of a quote in a sentence, through its multiplier, to as many places as it needs: "0.09998 USDC". The
 * API's refusals word every amount in the launch's own quote, as its pages do.
 */
export function amountText(raw: bigint, quote: Pick<QuoteInfo, "symbol" | "decimals" | "multiplier">): string {
  const value = (Number(raw) / 10 ** quote.decimals) * quote.multiplier;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: quote.decimals })} ${quote.symbol}`;
}
