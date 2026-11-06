// Heat's configs on a cluster (spec 3.2, ADR 0007): SOL's Fair Open and Instant pair, from `@top-pad/chain`, and every
// pair the band job has made or adopted for another quote, from `quote_config_pairs`, the retired ones too, since an old
// config keeps serving the coins made on it. Each knows its quote, its Graduation Target and curve A's starting price on
// it, so the indexer prices a pool's trades in its own quote and the API shows them so. A config never changes, so its
// starting price is read from the chain once; only the list of pairs grows.
import { createSolanaRpc, type Address } from "@solana/kit";
import type { HeatCluster, HeatQuote } from "@top-pad/chain";
import { fetchAllMaybePoolConfig } from "@top-pad/clients/dbc";
import { quoteConfigPairs, type Db } from "@top-pad/db";

export type HeatConfig = {
  config: string;
  mode: "fair_open" | "instant";
  quote: HeatQuote;
  /** In the quote's raw units. */
  graduationTarget: bigint;
  /** Curve A's starting square-root price on the config (Q64.64): every pool on it opens there. */
  sqrtStartPrice: bigint;
};

/** Every config Heat's coins can be made on, by address. */
export class HeatConfigs {
  private readonly byAddress: ReadonlyMap<string, HeatConfig>;
  constructor(configs: HeatConfig[]) {
    this.byAddress = new Map(configs.map((c) => [c.config, c]));
  }
  get(config: string): HeatConfig | undefined {
    return this.byAddress.get(config);
  }
  has(config: string): boolean {
    return this.byAddress.has(config);
  }
  /** Every address, SOL's pair first. */
  addresses(): string[] {
    return [...this.byAddress.keys()];
  }
  /** The set the decoder takes. */
  set(): ReadonlySet<string> {
    return new Set(this.byAddress.keys());
  }
  get size() {
    return this.byAddress.size;
  }
}

/** Reads configs' starting prices and quotes from the chain; the configs it was not given exist nowhere. */
export type ConfigReader = (configs: string[]) => Promise<Map<string, { quoteMint: string; sqrtStartPrice: bigint; graduationTarget: bigint }>>;

/** A config reader over an RPC endpoint: one `getMultipleAccounts` per 100 configs. */
export function rpcConfigReader(rpcUrl: string): ConfigReader {
  const rpc = createSolanaRpc(rpcUrl);
  return async (configs) => {
    const found = new Map<string, { quoteMint: string; sqrtStartPrice: bigint; graduationTarget: bigint }>();
    for (let i = 0; i < configs.length; i += 100) {
      const batch = configs.slice(i, i + 100);
      const accounts = await fetchAllMaybePoolConfig(rpc, batch as Address[], { commitment: "confirmed" });
      for (const account of accounts) {
        if (!account.exists) continue;
        found.set(account.address, { quoteMint: account.data.quoteMint, sqrtStartPrice: account.data.sqrtStartPrice, graduationTarget: account.data.migrationQuoteThreshold });
      }
    }
    return found;
  };
}

function solPairOf(heat: HeatCluster): HeatConfig[] {
  const sol = heat.quotes[0]!;
  if (!heat.configs) return [];
  const { graduationTarget, sqrtStartPrice } = heat;
  return [
    { config: heat.configs.fairOpen, mode: "fair_open", quote: sol, graduationTarget, sqrtStartPrice },
    { config: heat.configs.instant, mode: "instant", quote: sol, graduationTarget, sqrtStartPrice },
  ];
}

/** SOL's pair alone, the configs Heat had before any other quote (spec 3.2): no database or chain read. */
export const solConfigs = (heat: HeatCluster) => new HeatConfigs(solPairOf(heat));

/** Each config's starting price as read, kept for good: configs never change. */
const startPrices = new Map<string, bigint>();

/**
 * Heat's configs on `heat`'s cluster now: SOL's pair, then every pair in `quote_config_pairs` whose quote the cluster
 * lists (`CLUSTERS.<cluster>.quotes`), each config's starting price read once through `read`. A pair whose config the
 * chain does not hold, or holds for another quote, is left out with a warning rather than indexed in the wrong units.
 */
export async function loadHeatConfigs(db: Db, heat: HeatCluster, read: ConfigReader): Promise<HeatConfigs> {
  const configs = solPairOf(heat);
  const rows = await db.select().from(quoteConfigPairs);
  const listed = new Map(heat.quotes.map((q) => [q.mint as string, q]));
  const pairs = rows.flatMap((row) => {
    const quote = listed.get(row.quoteMint);
    if (!quote) return [];
    return [
      { config: row.fairOpenConfig, mode: "fair_open" as const, quote, graduationTarget: row.graduationTarget },
      { config: row.instantConfig, mode: "instant" as const, quote, graduationTarget: row.graduationTarget },
    ];
  });
  const unread = pairs.filter((p) => !startPrices.has(p.config)).map((p) => p.config);
  if (unread.length) {
    const read_ = await read(unread);
    for (const p of pairs) {
      const onChain = read_.get(p.config);
      if (!onChain) continue;
      if (onChain.quoteMint !== p.quote.mint || onChain.graduationTarget !== p.graduationTarget) {
        console.warn(`config ${p.config} holds ${onChain.quoteMint} at ${onChain.graduationTarget}, not ${p.quote.mint} at ${p.graduationTarget}: left out`);
        continue;
      }
      startPrices.set(p.config, onChain.sqrtStartPrice);
    }
  }
  for (const p of pairs) {
    const sqrtStartPrice = startPrices.get(p.config);
    if (sqrtStartPrice === undefined) {
      console.warn(`config ${p.config} of ${p.quote.symbol} is not on chain: left out`);
      continue;
    }
    configs.push({ ...p, sqrtStartPrice });
  }
  return new HeatConfigs(configs);
}

/** The configs as last loaded, and when, in this isolate, for code that asks often: the API's pages and keepers. */
let cached: { at: number; configs: Promise<HeatConfigs> } | null = null;

/** Forgets the configs loaded, so the next ask loads them again: for tests, whose databases change under one isolate. */
export function forgetHeatConfigs() {
  cached = null;
}

/** Heat's configs, loaded again at most every `maxAgeMs`; a failed load is not kept. */
export function heatConfigs(db: Db, heat: HeatCluster, read: ConfigReader, maxAgeMs = 60_000): Promise<HeatConfigs> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.configs;
  const configs = loadHeatConfigs(db, heat, read);
  cached = { at: Date.now(), configs };
  configs.catch(() => (cached = null));
  return configs;
}
