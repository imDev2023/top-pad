// The band job against a stand-in chain that applies what it is sent: each `create_config2` makes a config holding its
// Graduation Target, and each `set_quote_settings` rewrites the quote's settings, decoded from the instructions the job
// built, so the job is tested on the very instructions it would send. The database is a throwaway one.
import { address, generateKeyPairSigner, getBase64Encoder, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS, DEPOSIT_STEP, DEVNET_USDC, FAIR_OPEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type HeatCluster, type QuotePrice } from "@top-pad/chain";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, parseCreateConfig2Instruction } from "@top-pad/clients/dbc";
import { parseSetQuoteSettingsInstruction } from "@top-pad/clients/fair-open";
import { createDb, quoteConfigPairs, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { reviewQuoteBands, type BandChain, type NamedSettings, type QuoteOnChain } from "./band";
import type { PriceReading, PriceSource } from "./prices";
// The stand-in xStock's mint as devnet held it on 2026-11-03, NVDAx's extensions and no TokenBadge.
import standIn from "../../chain/src/fixtures/xstock-stand-in.json";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());

const devnet = CLUSTERS.devnet!;
const STAND_IN = devnet.quotes[2]!.mint;
// A heat with SOL and devnet USDC only, the stand-in's verdict tested on its own below.
const heat: HeatCluster = { ...devnet, quotes: devnet.quotes.slice(0, 2) };
const SOL = 1_000_000_000n;
const RENT_CONFIG = 8_234_880n;
const RENT_SETTINGS = 1_600_000n;
const FLOOR = 250_000_000n;

/** An SPL Token mint of 6 decimals, as devnet USDC is: 82 bytes, no extensions. */
function splMint(decimals: number) {
  const bytes = new Uint8Array(82);
  bytes[44] = decimals;
  bytes[45] = 1; // initialized
  return getMintDecoder().decode(bytes);
}

class FakeChain implements BandChain {
  configs = new Map<Address, { target: bigint; quoteMint: Address }>();
  settings = new Map<Address, { fairOpenConfig: Address; instantConfig: Address; step: bigint }>();
  sent: Instruction[][] = [];
  lamports = SOL;
  failNext: string | null = null;
  constructor(readonly mints: Map<Address, QuoteOnChain["mint"]>) {}

  async read(quotes: HeatCluster["quotes"]) {
    const out = new Map<Address, QuoteOnChain>();
    for (const q of quotes) {
      const s = this.settings.get(q.mint);
      const settings: NamedSettings | null = s
        ? { ...s, fairOpenTarget: this.configs.get(s.fairOpenConfig)?.target ?? null, instantTarget: this.configs.get(s.instantConfig)?.target ?? null }
        : null;
      out.set(q.mint, { mint: this.mints.get(q.mint) ?? null, settings });
    }
    return out;
  }
  rent = async (bytes: number) => (bytes > 1000 ? RENT_CONFIG : RENT_SETTINGS);
  balance = async () => this.lamports;
  async send(instructions: Instruction[]) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw new Error(error);
    }
    this.sent.push(instructions);
    for (const ix of instructions) {
      if (ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS) {
        const parsed = parseCreateConfig2Instruction(ix as Parameters<typeof parseCreateConfig2Instruction>[0]);
        this.configs.set(parsed.accounts.config.address, { target: parsed.data.configParameters.migrationQuoteThreshold, quoteMint: parsed.accounts.quoteMint.address });
        this.lamports -= RENT_CONFIG;
      } else if (ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS) {
        const parsed = parseSetQuoteSettingsInstruction(ix as Parameters<typeof parseSetQuoteSettingsInstruction>[0]);
        const quoteMint = parsed.accounts.quoteMint.address;
        if (!this.settings.has(quoteMint)) this.lamports -= RENT_SETTINGS;
        this.settings.set(quoteMint, { fairOpenConfig: parsed.accounts.fairOpenConfig.address, instantConfig: parsed.accounts.instantConfig.address, step: parsed.data.step });
      } else throw new Error(`unexpected program ${ix.programAddress}`);
    }
    return `sig-${this.sent.length}`;
  }
}

const usdcPrice = (usdcPerSol: number): QuotePrice => ({ num: BigInt(Math.round(usdcPerSol * 1e6)), den: SOL });
const fixed = (readings: Record<string, PriceReading>): PriceSource => async (quotes) => new Map(quotes.map((q) => [q.mint, readings[q.mint] ?? { price: null, reason: "not in the test's table" }]));

let chain: FakeChain;
let manager: KeyPairSigner;
let payer: KeyPairSigner;
beforeEach(async () => {
  await db.delete(quoteConfigPairs);
  chain = new FakeChain(new Map([[DEVNET_USDC, { address: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: splMint(6), tokenBadge: false }]]));
  // SOL's settings as devnet has them.
  chain.settings.set(devnet.quote.mint, { fairOpenConfig: devnet.configs!.fairOpen, instantConfig: devnet.configs!.instant, step: DEPOSIT_STEP });
  [manager, payer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
});
const run = (prices: PriceSource, h = heat) => reviewQuoteBands({ db, heat: h, chain, prices, quoteManager: manager, payer, floorLamports: FLOOR });
const usdcOutcome = async (prices: PriceSource) => (await run(prices)).quotes.find((q) => q.mint === DEVNET_USDC)!;
const pairs = () => db.select().from(quoteConfigPairs).orderBy(quoteConfigPairs.madeAt);

describe("the band job", () => {
  it("makes a quote's first pair and QuoteSettings at the live price, from the generator", async () => {
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }));
    expect(outcome).toMatchObject({ outcome: "named", made: true, step: "102323", graduationTarget: "86974550", driftBps: null });
    // Two configs, then the settings: three transactions, and the rent of both configs and the settings paid.
    expect(chain.sent).toHaveLength(3);
    expect(chain.lamports).toBe(SOL - 2n * RENT_CONFIG - RENT_SETTINGS);
    const settings = chain.settings.get(DEVNET_USDC)!;
    expect(settings.step).toBe(102_323n);
    for (const config of [settings.fairOpenConfig, settings.instantConfig]) expect(chain.configs.get(config)).toEqual({ target: 86_974_550n, quoteMint: DEVNET_USDC });
    const [row] = await pairs();
    expect(row).toMatchObject({ fairOpenConfig: settings.fairOpenConfig, instantConfig: settings.instantConfig, origin: "made", graduationTarget: 86_974_550n, step: 102_323n, retiredAt: null });
    expect(row!.namedAt).not.toBeNull();
    // Each config's parameters are the generator's for its mode: only the Fair Open one takes its first swap at the minimum fee.
    const [fairOpen, instant] = chain.sent.slice(0, 2).map(([ix]) => parseCreateConfig2Instruction(ix as Parameters<typeof parseCreateConfig2Instruction>[0]).data.configParameters);
    expect(fairOpen!.enableFirstSwapWithMinFee).toBe(true);
    expect(instant!.enableFirstSwapWithMinFee).toBe(false);
  });

  it("keeps a pair inside the band, saying how far it has drifted", async () => {
    await run(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }));
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(9.998), source: "test" } }));
    expect(outcome).toMatchObject({ outcome: "kept", driftBps: 234 });
    expect(chain.sent).toHaveLength(3);
  });

  it("makes a new pair past the band and retires the old one, which keeps its configs", async () => {
    await run(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }));
    const old = chain.settings.get(DEVNET_USDC)!;
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(8.5), source: "test" } }));
    // At 8.5 USDC a SOL the old pair is worth 10.23 SOL, 20.38% over.
    expect(outcome).toMatchObject({ outcome: "named", made: true, step: "85000", graduationTarget: "72250000", driftBps: 2038 });
    const now = chain.settings.get(DEVNET_USDC)!;
    expect(now.fairOpenConfig).not.toBe(old.fairOpenConfig);
    expect(chain.configs.get(old.fairOpenConfig)?.target).toBe(86_974_550n);
    const rows = await pairs();
    expect(rows.map((r) => [r.fairOpenConfig, r.retiredAt === null])).toEqual([
      [old.fairOpenConfig, false],
      [now.fairOpenConfig, true],
    ]);
  });

  it("adopts settings the chain named before the job knew them, then judges them", async () => {
    // #88's hand-made pair, at 10.2323 USDC a SOL.
    const fairOpen = address("HB5FNxnP9WY7o1huM8QBrqGp13TmJUfzTxpSKZ9aZ2pC");
    const instant = address("4Q9FsvXwiwCA6Anu5q84DLkUeT7jrHK4eXqNgseG1Foa");
    chain.configs.set(fairOpen, { target: 86_974_550n, quoteMint: DEVNET_USDC });
    chain.configs.set(instant, { target: 86_974_550n, quoteMint: DEVNET_USDC });
    chain.settings.set(DEVNET_USDC, { fairOpenConfig: fairOpen, instantConfig: instant, step: 102_323n });
    expect(await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(9.998), source: "test" } }))).toMatchObject({ outcome: "kept" });
    expect(await pairs()).toMatchObject([{ fairOpenConfig: fairOpen, instantConfig: instant, origin: "adopted", price: null, graduationTarget: 86_974_550n, step: 102_323n }]);
    expect(chain.sent).toHaveLength(0);
  });

  it("keeps the settings as they are while the price source is down", async () => {
    await run(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }));
    const before = chain.settings.get(DEVNET_USDC);
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: null, reason: "the pool did not answer" } }));
    expect(outcome).toEqual({ symbol: "USDC", mint: DEVNET_USDC, outcome: "no-price", reason: "the pool did not answer" });
    expect(chain.settings.get(DEVNET_USDC)).toBe(before);
  });

  it("names a pair it made but never named, rather than making another", async () => {
    chain.failNext = null;
    // The run makes both configs, then the settings write fails.
    const send = chain.send.bind(chain);
    let calls = 0;
    chain.send = async (ixs) => {
      if (++calls === 3) throw new Error("the RPC stalled");
      return send(ixs);
    };
    expect(await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }))).toMatchObject({ outcome: "failed", error: "the RPC stalled" });
    expect(chain.settings.has(DEVNET_USDC)).toBe(false);
    const [made] = await pairs();
    expect(made).toMatchObject({ origin: "made", namedAt: null });
    // The next run, within the band of that pair, names it: one transaction, no new configs.
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.1), source: "test" } }));
    expect(outcome).toMatchObject({ outcome: "named", made: false, fairOpenConfig: made!.fairOpenConfig });
    expect(chain.configs.size).toBe(2);
    expect((await pairs())[0]!.namedAt).not.toBeNull();
  });

  it("never spends the operations wallet below its floor", async () => {
    chain.lamports = FLOOR + 2n * RENT_CONFIG; // the settings' rent and the fees are missing
    const outcome = await usdcOutcome(fixed({ [DEVNET_USDC]: { price: usdcPrice(10.2323), source: "test" } }));
    expect(outcome).toMatchObject({ outcome: "short", holdsLamports: `${FLOOR + 2n * RENT_CONFIG}` });
    expect(chain.sent).toHaveLength(0);
  });

  it("leaves SOL's settings alone while they are Heat's SOL configs, and writes them when they are not", async () => {
    const sol = async () => (await run(fixed({}))).quotes[0]!;
    expect(await sol()).toMatchObject({ symbol: "SOL", outcome: "kept" });
    chain.settings.delete(devnet.quote.mint);
    expect(await sol()).toMatchObject({ outcome: "named", made: false, fairOpenConfig: devnet.configs!.fairOpen, step: `${DEPOSIT_STEP}` });
    expect(chain.settings.get(devnet.quote.mint)).toEqual({ fairOpenConfig: devnet.configs!.fairOpen, instantConfig: devnet.configs!.instant, step: DEPOSIT_STEP });
  });

  it("waits on a quote DBC does not take yet, such as the stand-in xStock before its TokenBadge", async () => {
    chain.mints.set(STAND_IN, { address: STAND_IN, tokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), mint: getMintDecoder().decode(getBase64Encoder().encode(standIn.data)), tokenBadge: false });
    const outcomes = (await run(fixed({}), devnet)).quotes;
    expect(outcomes.find((q) => q.mint === STAND_IN)).toMatchObject({ outcome: "waiting", reason: "needs-token-badge" });
    expect(chain.sent).toHaveLength(0);
  });

  it("moves at most a few quotes a run, and the rest the next", async () => {
    const outcomes = (await reviewQuoteBands({ db, heat, chain, prices: fixed({ [DEVNET_USDC]: { price: usdcPrice(10), source: "test" } }), quoteManager: manager, payer, floorLamports: FLOOR, maxMoves: 0 })).quotes;
    expect(outcomes.find((q) => q.mint === DEVNET_USDC)).toMatchObject({ outcome: "deferred" });
  });
});
