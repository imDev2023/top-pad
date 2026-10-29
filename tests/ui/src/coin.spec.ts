// A coin's page, live (spec 9, screen 3; #42's devnet demo): a creator launches from the site and opens the coin's page,
// and two traders buy and sell it by script through its first minute and past it. Every trade must land on the page
// within seconds of confirming, its fee following the sniper tax's schedule (spec 3.2) from 99% down to 1.25%, while
// the tax band counts down; the indexer's candles must match the trades. And a pool made straight on Heat's config,
// around the launch flow, must say so. Real devnet SOL: about 0.15 a run, most of it the tax the traders pay. Neither
// page may report an error.
import { expect, test, type Page } from "@playwright/test";
import { address, type KeyPairSigner } from "@solana/kit";
import { FEE_DENOMINATOR, sniperTaxNumerator } from "@top-pad/chain";
import { Coin, CoinCandles, CoinTrades, type Trade } from "@top-pad/contract";
import { coinBalance, fundedWallets, poolAroundHeat, swap, sweep } from "@top-pad/tests-devnet/devnet";
import { launchCoin, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";

const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sniper tax's fee on a trade that moved `quote` lamports before its fee, `seconds` after the open: DBC rounds it up. */
const scheduledFee = (quote: bigint, seconds: number) => (quote * sniperTaxNumerator(seconds) + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;

/** The rate the tax band shows, as a number. */
async function bandRate(page: Page) {
  const text = await page.getByLabel("Sniper tax").locator("p.num").first().textContent();
  return Number(text!.replace("%", ""));
}

test("a coin's trades land on its page live through its first minute, each paying the scheduled sniper tax", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const errors = pageErrors(page);
  // Locally the indexer only runs once asked; on devnet the cron keeps it up.
  await fetch(`${TARGET.api}/indexer`);
  const [creator, alice, bob] = await fundedWallets(30_000_000n, 100_000_000n, 120_000_000n);

  const { mint } = await launchCoin(page, creator, { name: "Heat Tape", ticker: newTicker() });
  await page.getByRole("link", { name: "Watch it trade" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Heat Tape");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // The API's clock against this machine's, to trade at chosen moments after the open.
  const asked = Date.now();
  const coin = await api(`/coins/${mint}`, Coin);
  const offset = Date.parse(coin.servedAt) - (asked + Date.now()) / 2;
  const opened = Date.parse(coin.activatedAt);
  const at = (seconds: number) => sleep(Math.max(0, opened + seconds * 1000 - (Date.now() + offset)));

  // The tax band runs, and falls.
  const firstRate = await bandRate(page);
  expect(firstRate).toBeGreaterThan(1.25);
  expect(firstRate).toBeLessThanOrEqual(99);

  const half = async (who: KeyPairSigner) => (await coinBalance(who.address, address(mint))) / 2n;
  const plan: { seconds: number; who: KeyPairSigner; side: "buy" | "sell"; amount: () => Promise<bigint> }[] = [
    { seconds: 8, who: alice, side: "buy", amount: async () => 10_000_000n },
    { seconds: 15, who: bob, side: "buy", amount: async () => 10_000_000n },
    { seconds: 22, who: alice, side: "buy", amount: async () => 20_000_000n },
    { seconds: 31, who: bob, side: "sell", amount: () => half(bob) },
    { seconds: 38, who: alice, side: "buy", amount: async () => 10_000_000n },
    { seconds: 46, who: bob, side: "buy", amount: async () => 10_000_000n },
    { seconds: 53, who: alice, side: "sell", amount: () => half(alice) },
    { seconds: 66, who: bob, side: "buy", amount: async () => 50_000_000n },
    { seconds: 74, who: alice, side: "sell", amount: () => coinBalance(alice.address, address(mint)) },
  ];
  const landedWithin: number[] = [];
  const signatures: string[] = [];
  for (const step of plan) {
    await at(step.seconds);
    const amount = await step.amount();
    // From the moment it is sent: confirming on chain, then the indexer and the live room.
    const sent = Date.now();
    const signature = await swap(step.who, address(mint), step.side, amount);
    signatures.push(signature);
    await expect(page.locator(`[data-trade="${signature}:0"]`)).toBeVisible({ timeout: 20_000 });
    landedWithin.push(Date.now() - sent);
    if (step.seconds === 22) {
      expect(await bandRate(page)).toBeLessThan(firstRate);
      await snap(page, "coin-1-tax-running");
    }
  }
  console.log(`trades landed on the page ${landedWithin.map((ms) => (ms / 1000).toFixed(1)).join(", ")} s after they were sent`);
  expect(Math.max(...landedWithin)).toBeLessThan(10_000);

  // The minute is over: the band is green, and every trade paid the tax its second called for.
  await expect(page.getByLabel("Sniper tax")).toContainText("Fee now");
  const { trades } = await api(`/coins/${mint}/trades?limit=50`, CoinTrades);
  const ours = signatures.map((s) => trades.find((t) => t.signature === s)!);
  expect(ours.every(Boolean)).toBe(true);
  const rows: [string, string, string][] = [];
  for (const t of ours as Trade[]) {
    const seconds = (Date.parse(t.at) - opened) / 1000;
    // Within a lamport of the schedule: DBC rounds each part of the fee on its own.
    const off = BigInt(t.fee) - scheduledFee(BigInt(t.quoteAmount), seconds);
    expect(off >= -1n && off <= 1n, `the ${t.side} at ${seconds} s paid ${t.fee}, ${off} off the schedule`).toBe(true);
    const rate = ((Number(t.fee) / Number(t.quoteAmount)) * 100).toFixed(2);
    // The page shows the same rate the trade paid.
    await expect(page.locator(`[data-trade="${t.signature}:0"]`)).toContainText(`${rate}%`);
    rows.push([`${seconds} s`, t.side, `${rate}%`]);
  }
  console.table(rows);
  // From the 99% cliff's neighbourhood down to the 1.25% trading fee.
  expect(Number(ours[0]!.fee) / Number(ours[0]!.quoteAmount)).toBeGreaterThan(0.8);
  expect(Number(ours.at(-1)!.fee) / Number(ours.at(-1)!.quoteAmount)).toBeCloseTo(0.0125, 4);
  await snap(page, "coin-2-after-the-minute");

  // The candles the indexer wrote add up to the trades.
  const { candles } = await api(`/coins/${mint}/candles?seconds=86400&from=0`, CoinCandles);
  expect(candles.reduce((n, c) => n + c.trades, 0)).toBe(ours.length);
  expect(candles.reduce((sum, c) => sum + BigInt(c.volumeQuote), 0n)).toBe(ours.reduce((sum, t) => sum + BigInt(t.quoteAmount), 0n));

  expect(errors).toEqual([]);
  await sweep(alice, bob, creator);
});

test("a pool made straight on Heat's config says it was not launched through Heat", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [stranger] = await fundedWallets(30_000_000n);
  const { mint } = await poolAroundHeat(stranger);
  // The indexer finds it by the config, live or by reconciliation within its minute.
  await expect.poll(async () => (await fetch(`${TARGET.api}/coins/${mint}`)).status, { timeout: 90_000, intervals: [1_000] }).toBe(200);
  const coin = await api(`/coins/${mint}`, Coin);
  expect(coin).toMatchObject({ heat: false, launchMode: null, imageUri: null, name: "Around Heat", ticker: "AROUND" });

  await page.goto(`/coin/${mint}`);
  await expect(page.getByRole("alert")).toContainText("Not launched through Heat");
  await expect(page.getByText("Instant launch")).toHaveCount(0);
  await snap(page, "coin-3-around-heat");
  expect(errors).toEqual([]);
  await sweep(stranger);
});
