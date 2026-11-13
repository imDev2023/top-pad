// The band job on devnet (#89, ADR 0007's band), the code the deployed API's cron runs, against the Fair Open program and
// DBC as deployed and the devnet database: devnet USDC is priced at a test override 15% below its live price, so its
// config pair is worth well over 10% more than 8.5 SOL; the job makes a new pair at that price from the generator,
// rewrites USDC's `QuoteSettings` with the quote manager key and records both pairs, the summary going to `job_runs` as
// the cron's does. The old configs still serve: a coin made on the old Instant config after the move takes a buy in
// USDC. Then the job runs at the live price and brings USDC back inside the band, unless the deployed cron did first.
// Heat's bank pays, about 0.05 devnet SOL (four configs' rent, a coin's pool, a buy of 0.01 USDC at the sniper tax; 0.046 on 2026-11-06) and
// signs with the quote manager key only this Mac holds (~/.config/top-pad/devnet); it needs the devnet database's
// DATABASE_URL (`direnv exec "<main checkout>"`) and is skipped without them.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type Address } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import {
  dbcPoolAddress,
  DEVNET_USDC,
  driftBps,
  FEE_PROGRAM_ADDRESS,
  instantLaunchInstructions,
  outOfBand,
  swapInstructions,
  TOKEN_PROGRAM_ADDRESS,
  type HeatCluster,
  type QuotePrice,
} from "@top-pad/chain";
import { fetchPoolConfig } from "@top-pad/clients/dbc";
import { createDb, jobRuns, quoteConfigPairs } from "@top-pad/db";
import { runJob } from "@top-pad/jobs";
import { livePrices, rpcBandChain, reviewQuoteBands, withOverrides, type QuoteOutcome } from "@top-pad/quotes";
import { desc, eq } from "drizzle-orm";
import { bank, coinBalance, devnet, rpc, send } from "./devnet";

const dir = join(homedir(), ".config/top-pad/devnet");
const ready = ["quote-manager.json", "bank.json"].every((name) => existsSync(join(dir, name))) && !!process.env.DATABASE_URL;
const load = async (name: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(dir, name), "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// SOL and devnet USDC: the stand-in xStock waits on its TokenBadge (#91) and is the deployed job's to report.
const heat: HeatCluster = { ...devnet, quotes: devnet.quotes.filter((q) => q.price.kind !== "jupiter") };
const usdcQuote = heat.quotes.find((q) => q.mint === DEVNET_USDC)!;
/** What the bank keeps whatever the job spends. */
const BANK_FLOOR = 1_000_000_000n;

describe.skipIf(!ready)("the band job on devnet", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://unused");
  afterAll(() => close());

  /** One run of the job with `prices`, under the cron's own lease and record, tried again while a cron run holds it. */
  async function runBand(prices: ReturnType<typeof livePrices>): Promise<QuoteOutcome> {
    const [quoteManager, payer] = await Promise.all([load("quote-manager.json"), bank()]);
    for (let attempt = 0; ; attempt++) {
      const run = await runJob(db, "quote-band", () => reviewQuoteBands({ db, heat, chain: rpcBandChain(rpc, (ixs) => send(payer, ixs)), prices, quoteManager, payer, floorLamports: BANK_FLOOR }), { exclusive: true });
      if (run.status === "succeeded") {
        const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, run.id));
        console.log(`job_runs ${run.id}: ${JSON.stringify(row!.summary)}`);
        return (row!.summary as { quotes: QuoteOutcome[] }).quotes.find((q) => q.mint === DEVNET_USDC)!;
      }
      if (attempt > 20) throw new Error(`the quote-band job stayed ${run.status}`);
      await sleep(15_000);
    }
  }

  const settingsNow = async () => (await rpcBandChain(rpc, async () => "").read([usdcQuote])).get(DEVNET_USDC)!.settings!;

  it("makes a new pair past the band, and the old configs still serve their coins", { timeout: 15 * 60_000 }, async () => {
    const live = (await livePrices(rpc, null)([usdcQuote])).get(DEVNET_USDC)!;
    if (!live.price) throw new Error(`devnet USDC has no live price: ${live.reason}`);
    const before = await settingsNow();
    console.log(`USDC's settings before: Fair Open ${before.fairOpenConfig}, Instant ${before.instantConfig}, step ${before.step}, target ${before.fairOpenTarget}`);

    // 15% below the live price: a pair made at the live price is then worth about 17.6% more than 8.5 SOL.
    const override: QuotePrice = { num: live.price.num * 85n, den: live.price.den * 100n };
    expect(outOfBand({ graduationTarget: before.fairOpenTarget!, step: before.step }, override, heat.graduationTarget)).toBe(true);
    const moved = await runBand(withOverrides(livePrices(rpc, null), new Map([[DEVNET_USDC, override]])));
    expect(moved).toMatchObject({ outcome: "named", made: true });
    if (moved.outcome !== "named") throw new Error("unreachable");

    // USDC's settings name the new pair, its two configs hold its target, and both pairs are recorded.
    const after = await settingsNow();
    expect(after).toMatchObject({ fairOpenConfig: moved.fairOpenConfig, instantConfig: moved.instantConfig, step: BigInt(moved.step) });
    expect(after.fairOpenTarget).toBe(BigInt(moved.graduationTarget));
    expect(after.instantTarget).toBe(BigInt(moved.graduationTarget));
    expect(driftBps(after.fairOpenTarget!, heat.graduationTarget, override)).toBeLessThanOrEqual(1n);
    const rows = await db.select().from(quoteConfigPairs).where(eq(quoteConfigPairs.quoteMint, DEVNET_USDC)).orderBy(desc(quoteConfigPairs.madeAt));
    expect(rows.find((r) => r.fairOpenConfig === moved.fairOpenConfig)).toMatchObject({ origin: "made", retiredAt: null });
    expect(rows.find((r) => r.fairOpenConfig === before.fairOpenConfig)?.retiredAt).not.toBeNull();

    // The old Instant config still serves: a coin made on it now takes a buy in USDC.
    const old = await fetchPoolConfig(rpc, before.instantConfig, { commitment: "confirmed" });
    expect(old.data.migrationQuoteThreshold).toBe(before.instantTarget);
    const creator = await bank();
    const mint = await generateKeyPairSigner();
    const launch = {
      config: before.instantConfig,
      quoteMint: DEVNET_USDC,
      creator,
      mint,
      launchKey: creator,
      coin: { name: "Band Old Config", ticker: "BANDOLD", uri: "https://example.com/band-old-config.json" },
      computeUnitPrice: 0n,
    };
    await send(creator, (await instantLaunchInstructions(launch)).filter((ix) => ix.programAddress !== FEE_PROGRAM_ADDRESS));
    const pool = await dbcPoolAddress(before.instantConfig, mint.address, DEVNET_USDC);
    const buy = await send(creator, await swapInstructions({ config: before.instantConfig, pool, mint: mint.address, quoteMint: DEVNET_USDC, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS, trader: creator, side: "buy", amountIn: 10_000n, minimumOut: 1n }));
    const coins = await coinBalance(creator.address, mint.address);
    console.log(`A coin ${mint.address} on the old Instant config ${before.instantConfig} took a buy of 0.01 USDC for ${coins} raw coins: ${buy}`);
    expect(coins).toBeGreaterThan(0n);

    // Back at the live price the new pair is out of the band again, and the job brings USDC back inside it, unless the
    // deployed cron, which prices it live, already has.
    const back = await runBand(livePrices(rpc, null));
    expect(["named", "kept"]).toContain(back.outcome);
    const last = await settingsNow();
    expect(outOfBand({ graduationTarget: last.fairOpenTarget!, step: last.step }, live.price, heat.graduationTarget)).toBe(false);
    console.log(`USDC's settings after: Fair Open ${last.fairOpenConfig}, Instant ${last.instantConfig}, step ${last.step}, target ${last.fairOpenTarget}`);
    // The pair the override made keeps its configs too.
    expect((await fetchPoolConfig(rpc, moved.fairOpenConfig as Address, { commitment: "confirmed" })).data.migrationQuoteThreshold).toBe(BigInt(moved.graduationTarget));
  });
});
