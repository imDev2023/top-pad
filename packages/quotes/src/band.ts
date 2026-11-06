// The band job (ADR 0007, settled question 1; spec 3.2, 10.2): every quote Heat offers keeps `QuoteSettings` naming a
// Fair Open and Instant config pair whose Graduation Target, valued in SOL at the quote's latest price, is within 10% of
// the SOL target, and a step within 10% of 0.01 SOL. Once a quote drifts past that, the job makes a new pair at the live
// price, from the same generator as every Heat config, and the quote manager names it; the old pair keeps serving the
// coins made on it, and `quote_config_pairs` keeps every pair the chain has named. While a quote's price source is
// down, its settings stay as they are. The operations wallet (Heat's keeper) pays the rent, asked of the cluster.
import {
  fetchEncodedAccounts,
  generateKeyPairSigner,
  type Address,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetMultipleAccountsApi,
  type Instruction,
  type Rpc,
  type TransactionSigner,
} from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import {
  amountsAt,
  driftBps,
  eventAuthorityAddress,
  FAIR_OPEN_PROGRAM_ADDRESS,
  formatPrice,
  outOfBand,
  tokenBadgeAddress,
  DEPOSIT_STEP,
  type HeatCluster,
  type HeatQuote,
  type QuoteAmounts,
  type QuotePrice,
} from "@top-pad/chain";
import { quoteVerdict, type QuoteMint } from "@top-pad/chain/quotes";
import { fetchAllMaybePoolConfig } from "@top-pad/clients/dbc";
import { fetchAllMaybeQuoteSettings, findQuoteSettingsPda, getQuoteSettingsSize, getSetQuoteSettingsInstructionAsync } from "@top-pad/clients/fair-open";
import { quoteConfigPairs, type Db } from "@top-pad/db";
import { heatConfigInstruction, POOL_CONFIG_SIZE } from "@top-pad/meteora";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { PriceSource } from "./prices";

/** What a quote's `QuoteSettings` name, and the Graduation Targets the two configs hold. */
export type NamedSettings = { fairOpenConfig: Address; instantConfig: Address; step: bigint; fairOpenTarget: bigint | null; instantTarget: bigint | null };

/** A quote as the chain holds it: its mint (null if there is none) and its settings (null until written). */
export type QuoteOnChain = { mint: QuoteMint | null; settings: NamedSettings | null };

/** What the job needs of the chain: the job's reads in a few batched calls, rent, a balance, and a send. */
export type BandChain = {
  read(quotes: HeatQuote[]): Promise<Map<Address, QuoteOnChain>>;
  rent(bytes: number): Promise<bigint>;
  balance(address: Address): Promise<bigint>;
  /** Sends one transaction of `instructions`, the payer paying, and answers its signature once confirmed. */
  send(instructions: Instruction[]): Promise<string>;
};

export type BandDeps = {
  db: Db;
  heat: HeatCluster;
  chain: BandChain;
  prices: PriceSource;
  quoteManager: TransactionSigner;
  /** The operations wallet: pays for each new pair and `QuoteSettings`, and keeps at least `floorLamports`. */
  payer: TransactionSigner;
  floorLamports: bigint;
  /** The most quotes one run moves, so a first run over a long list spreads over a few: three transactions a move. */
  maxMoves?: number;
};

/** What the job did for one quote, for its summary in `job_runs`. */
export type QuoteOutcome = { symbol: string; mint: Address } & (
  | { outcome: "kept"; driftBps: number; price: string }
  | { outcome: "named"; fairOpenConfig: Address; instantConfig: Address; step: string; graduationTarget: string; price: string | null; made: boolean; driftBps: number | null; signatures: string[] }
  | { outcome: "waiting"; reason: string }
  | { outcome: "no-price"; reason: string }
  | { outcome: "short"; needLamports: string; holdsLamports: string }
  | { outcome: "deferred" }
  | { outcome: "failed"; error: string }
);

export const MAX_MOVES_PER_RUN = 4;
/** Three transactions' base fees with room for their signatures: two configs (two signers each), then the settings. */
const FEES_LAMPORTS = 3n * 3n * 5_000n;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asNumber = (bps: bigint) => Number(bps);

/** One run of the band job over every quote of the cluster; its summary goes to `job_runs`. */
export async function reviewQuoteBands(deps: BandDeps): Promise<{ quotes: QuoteOutcome[] }> {
  const { heat, chain } = deps;
  if (!heat.configs) throw new Error("the band job needs Heat's SOL configs, which every quote's Fair Open config is shaped as");
  const onChain = await chain.read(heat.quotes);
  const priced = heat.quotes.filter((q) => q.price.kind !== "sol");
  const prices = priced.length ? await deps.prices(priced) : new Map();
  let movesLeft = deps.maxMoves ?? MAX_MOVES_PER_RUN;
  const outcomes: QuoteOutcome[] = [];
  for (const quote of heat.quotes) {
    const id = { symbol: quote.symbol, mint: quote.mint };
    const state = onChain.get(quote.mint) ?? { mint: null, settings: null };
    try {
      if (quote.price.kind === "sol") {
        // SOL needs no price: its settings are Heat's two SOL configs and the 0.01 SOL step, as `@top-pad/chain` records.
        const s = state.settings;
        const wanted = { fairOpenConfig: heat.configs.fairOpen, instantConfig: heat.configs.instant, step: DEPOSIT_STEP };
        if (s && s.fairOpenConfig === wanted.fairOpenConfig && s.instantConfig === wanted.instantConfig && s.step === wanted.step) {
          outcomes.push({ ...id, outcome: "kept", driftBps: 0, price: "1" });
        } else if (movesLeft <= 0) outcomes.push({ ...id, outcome: "deferred" });
        else {
          movesLeft--;
          const signature = await chain.send([await settingsInstruction(deps, quote.mint, wanted)]);
          outcomes.push({ ...id, outcome: "named", ...wanted, step: `${wanted.step}`, graduationTarget: `${heat.graduationTarget}`, price: "1", made: false, driftBps: null, signatures: [signature] });
        }
        continue;
      }
      if (!state.mint) {
        outcomes.push({ ...id, outcome: "waiting", reason: "the quote has no mint account on this cluster" });
        continue;
      }
      const verdict = quoteVerdict(state.mint);
      if (!verdict.accepted) {
        outcomes.push({ ...id, outcome: "waiting", reason: verdict.refusals.join(", ") });
        continue;
      }
      const current = state.settings ? await adopt(deps.db, quote, state.settings) : null;
      const reading = prices.get(quote.mint);
      if (!reading?.price) {
        outcomes.push({ ...id, outcome: "no-price", reason: reading && !reading.price ? reading.reason : "no price source answered" });
        continue;
      }
      const price = reading.price;
      if (current && !outOfBand(current, price, heat.graduationTarget)) {
        outcomes.push({ ...id, outcome: "kept", driftBps: asNumber(driftBps(current.graduationTarget, heat.graduationTarget, price)), price: formatPrice(price) });
        continue;
      }
      if (movesLeft <= 0) {
        outcomes.push({ ...id, outcome: "deferred" });
        continue;
      }
      movesLeft--;
      outcomes.push({ ...id, ...(await move(deps, quote, state, current, price)) });
    } catch (e) {
      outcomes.push({ ...id, outcome: "failed", error: message(e) });
    }
  }
  return { quotes: outcomes };
}

/**
 * The amounts the quote's settings stand at, and their pair recorded if the chain named it before the job knew it.
 * Null when the settings name configs whose targets are missing or differ, which the job replaces.
 */
async function adopt(db: Db, quote: HeatQuote, s: NamedSettings): Promise<QuoteAmounts | null> {
  if (s.fairOpenTarget === null || s.fairOpenTarget !== s.instantTarget) return null;
  await db
    .insert(quoteConfigPairs)
    .values({
      fairOpenConfig: s.fairOpenConfig,
      instantConfig: s.instantConfig,
      quoteMint: quote.mint,
      graduationTarget: s.fairOpenTarget,
      step: s.step,
      origin: "adopted",
      namedAt: sql`now()`,
    })
    .onConflictDoNothing();
  return { graduationTarget: s.fairOpenTarget, step: s.step };
}

/**
 * Brings a quote back inside the band at `price`: names a pair the job made earlier that was never named (a run that
 * stopped between making it and naming it) if that pair is inside the band, or else makes a new one at the price, then
 * writes the quote's `QuoteSettings`.
 */
async function move(deps: BandDeps, quote: HeatQuote, state: QuoteOnChain, current: QuoteAmounts | null, price: QuotePrice) {
  const { db, heat, chain } = deps;
  const drift = current ? asNumber(driftBps(current.graduationTarget, heat.graduationTarget, price)) : null;
  const unnamed = await db
    .select()
    .from(quoteConfigPairs)
    .where(and(eq(quoteConfigPairs.quoteMint, quote.mint), eq(quoteConfigPairs.origin, "made"), isNull(quoteConfigPairs.namedAt)))
    .orderBy(desc(quoteConfigPairs.madeAt));
  const ready = unnamed.find((p) => !outOfBand(p, price, heat.graduationTarget));
  let pair: { fairOpenConfig: Address; instantConfig: Address; graduationTarget: bigint; step: bigint };
  const signatures: string[] = [];
  const settingsRent = state.settings ? 0n : await chain.rent(getQuoteSettingsSize());
  if (ready) {
    pair = { fairOpenConfig: ready.fairOpenConfig as Address, instantConfig: ready.instantConfig as Address, graduationTarget: ready.graduationTarget, step: ready.step };
    const short = await shortfall(deps, settingsRent + FEES_LAMPORTS);
    if (short) return short;
  } else {
    const amounts = amountsAt(price, heat.graduationTarget);
    const short = await shortfall(deps, 2n * (await chain.rent(POOL_CONFIG_SIZE)) + settingsRent + FEES_LAMPORTS);
    if (short) return short;
    const [fairOpen, instant] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    // Each config is its own transaction, since one holds the curve's integers: the Fair Open config first, so a run that
    // stops between them leaves no Instant config the table does not know of.
    for (const [mode, config] of [["fairOpen", fairOpen], ["instant", instant]] as const) {
      signatures.push(await chain.send([await heatConfigInstruction({ mode, quoteMint: quote.mint, graduationTarget: amounts.graduationTarget, config, payer: deps.payer })]));
    }
    pair = { fairOpenConfig: fairOpen.address, instantConfig: instant.address, ...amounts };
    await db.insert(quoteConfigPairs).values({ ...pair, quoteMint: quote.mint, price: formatPrice(price), origin: "made" });
  }
  signatures.push(await chain.send([await settingsInstruction(deps, quote.mint, pair)]));
  await db.transaction(async (tx) => {
    await tx
      .update(quoteConfigPairs)
      .set({ retiredAt: sql`now()` })
      .where(and(eq(quoteConfigPairs.quoteMint, quote.mint), ne(quoteConfigPairs.fairOpenConfig, pair.fairOpenConfig), isNull(quoteConfigPairs.retiredAt), sql`${quoteConfigPairs.namedAt} is not null`));
    await tx.update(quoteConfigPairs).set({ namedAt: sql`now()`, retiredAt: null }).where(eq(quoteConfigPairs.fairOpenConfig, pair.fairOpenConfig));
  });
  return {
    outcome: "named" as const,
    fairOpenConfig: pair.fairOpenConfig,
    instantConfig: pair.instantConfig,
    step: `${pair.step}`,
    graduationTarget: `${pair.graduationTarget}`,
    price: formatPrice(price),
    made: !ready,
    driftBps: drift,
    signatures,
  };
}

/** The outcome when the operations wallet would fall below its floor by paying `lamports`, or null when it can pay. */
async function shortfall(deps: BandDeps, lamports: bigint) {
  const holds = await deps.chain.balance(deps.payer.address);
  if (holds - lamports >= deps.floorLamports) return null;
  return { outcome: "short" as const, needLamports: `${lamports + deps.floorLamports}`, holdsLamports: `${holds}` };
}

async function settingsInstruction(deps: BandDeps, quoteMint: Address, pair: { fairOpenConfig: Address; instantConfig: Address; step: bigint }) {
  return getSetQuoteSettingsInstructionAsync({
    quoteManager: deps.quoteManager,
    payer: deps.payer,
    quoteMint,
    fairOpenConfig: pair.fairOpenConfig,
    instantConfig: pair.instantConfig,
    referenceConfig: deps.heat.configs!.fairOpen,
    eventAuthority: await eventAuthorityAddress(FAIR_OPEN_PROGRAM_ADDRESS),
    program: FAIR_OPEN_PROGRAM_ADDRESS,
    step: pair.step,
  });
}

type ChainRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi & GetBalanceApi & GetMinimumBalanceForRentExemptionApi>;

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });

/**
 * The job's chain over an RPC: each quote's `QuoteSettings`, mint and DBC TokenBadge in three batched reads, then the
 * configs the settings name in one more; `send` is the caller's, so the Worker and the devnet test each send their way.
 */
export function rpcBandChain(rpc: ChainRpc, send: BandChain["send"]): BandChain {
  return {
    async read(quotes) {
      const settingsAt = await Promise.all(quotes.map(async (q) => (await findQuoteSettingsPda({ quoteMint: q.mint }))[0]));
      const badgesAt = await Promise.all(quotes.map((q) => tokenBadgeAddress(q.mint)));
      const options = { commitment: "confirmed" as const, ...limited() };
      const [settings, mints, badges] = await Promise.all([
        fetchAllMaybeQuoteSettings(rpc, settingsAt, options),
        fetchEncodedAccounts(rpc, quotes.map((q) => q.mint), options),
        fetchEncodedAccounts(rpc, badgesAt, options),
      ]);
      const named = settings.flatMap((s) => (s.exists ? [s.data.fairOpenConfig, s.data.instantConfig] : []));
      const configs = named.length ? await fetchAllMaybePoolConfig(rpc, named, options) : [];
      const targets = new Map(configs.flatMap((c) => (c.exists ? [[c.address, c.data.migrationQuoteThreshold] as const] : [])));
      const out = new Map<Address, QuoteOnChain>();
      quotes.forEach((q, i) => {
        const s = settings[i]!;
        const m = mints[i]!;
        out.set(q.mint, {
          mint: m.exists ? { address: q.mint, tokenProgram: m.programAddress, mint: getMintDecoder().decode(m.data), tokenBadge: badges[i]!.exists } : null,
          settings: s.exists
            ? {
                fairOpenConfig: s.data.fairOpenConfig,
                instantConfig: s.data.instantConfig,
                step: s.data.step,
                fairOpenTarget: targets.get(s.data.fairOpenConfig) ?? null,
                instantTarget: targets.get(s.data.instantConfig) ?? null,
              }
            : null,
        });
      });
      return out;
    },
    rent: async (bytes) => rpc.getMinimumBalanceForRentExemption(BigInt(bytes), { commitment: "confirmed" }).send(limited()),
    balance: async (address) => (await rpc.getBalance(address, { commitment: "confirmed" }).send(limited())).value,
    send,
  };
}
