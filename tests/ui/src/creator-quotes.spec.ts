// Creator Earnings in every quote (#99's devnet demo): a creator launches an Instant coin in SOL and another in devnet
// USDC from the site, a trader buys both once each coin's window claim has run, and the creator's page shows each coin
// in its own quote, with what waits in each quote; one click and one wallet request claim both, a transaction a quote,
// paying exactly what the page showed in each, and the Creator record then counts what each quote's claim paid.
// Real devnet SOL and USDC: about 0.1 SOL a run, and about 1.2 USDC lent to the trader, all but the fees returned;
// Heat's bank must hold 1.2 USDC (`pnpm --filter @top-pad/chain devnet-usdc devnet <SOL> --send`). About 5 minutes:
// pass `creator-quotes.spec.ts` to run it alone.
import { expect, test, type Page } from "@playwright/test";
import { address, type Address } from "@solana/kit";
import { creatorShare, DEVNET_USDC, quoteAccount, TOKEN_PROGRAM_ADDRESS } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { Coin, CreatorEarnings, CreatorRecord } from "@top-pad/contract";
import { fundedWallets, rpc, swap } from "@top-pad/tests-devnet/devnet";
import { fundQuote, sweepDepositors } from "@top-pad/tests-devnet/fair-open";
import { expectVampLaunchable, launchCoin, newTicker, pageErrors, runName, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet } from "./wallet";

const USDC = { mint: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS };
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
async function tokens(account: Address) {
  const { value } = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }));
  return BigInt(value.amount);
}
const exists = async (account: Address) => (await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send()).value !== null;
const partnerFees = async (pool: Address) => (await fetchVirtualPool(rpc, pool)).data.poolState.partnerQuoteFee;
/** An amount as the creator's page writes it: every raw unit. */
const shown = (raw: bigint, decimals: number, symbol: string) => `${(Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals })} ${symbol}`;
const inSol = (raw: bigint) => shown(raw, 9, "SOL");
const inUsdc = (raw: bigint) => shown(raw, 6, "USDC");
/** A transaction's network fee: one signature, no priority fee. */
const NETWORK_FEE = 5_000n;

/** A coin's answer once the indexer has written it. */
async function coinOf(mint: string) {
  await expect.poll(async () => (await fetch(`${TARGET.api}/coins/${mint}`)).status, { timeout: 60_000 }).toBe(200);
  return api(`/coins/${mint}`, Coin);
}

/** Waits for Heat's keeper to send a coin's window claim, at the end of its first minute. */
async function windowClaimed(mint: string) {
  await expect.poll(async () => (await api(`/coins/${mint}`, Coin)).windowClaim, { timeout: 150_000, intervals: [2_000] }).not.toBeNull();
}

/** Opens the creator's page with the page's test wallet connected, and waits for its earnings to load. */
async function openCreatorPage(page: Page) {
  await page.goto("/creator");
  const waiting = page.getByTestId("earnings-waiting");
  const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
  // A wallet connected on an earlier page of this browser reconnects by itself.
  await expect(waiting.or(connect)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await connectTestWallet(page, connect);
  await expect(waiting).toBeVisible({ timeout: 30_000 });
}

test("a creator's SOL coin and USDC coin each show in their own quote, and one wallet request claims both", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, trader] = await fundedWallets(80_000_000n, 80_000_000n);
  await fundQuote([trader], [1_200_000n], USDC, 6);
  try {
    // A coin in SOL, then, in the same signed-in browser, a coin in USDC from the quote picker.
    const { mint: solMint, wallet } = await launchCoin(page, creator, { name: "Heat Both", ticker: newTicker() }, { looksLike: true });
    await page.goto("/launch");
    await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("radio", { name: /Instant launch/ }).check();
    await page.getByTestId("quote-picker").getByRole("radio", { name: /^USDC/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    const ticker = newTicker();
    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill(runName("Heat Both Dollar", ticker));
    await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
    await expectVampLaunchable(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Launched" })).toBeVisible({ timeout: 150_000 });
    const usdcMint = (await page.locator("dd").first().textContent())!.trim();

    const [solCoin, usdcCoin] = [await coinOf(solMint), await coinOf(usdcMint)];
    expect([solCoin.quote.symbol, usdcCoin.quote.symbol]).toEqual(["SOL", "USDC"]);
    // Each coin's first minute goes to the treasury; the creator's half of every fee starts once its window claim has run.
    await windowClaimed(solMint);
    await windowClaimed(usdcMint);
    await swap(trader, address(solMint), "buy", 60_000_000n);
    await swap(trader, address(usdcMint), "buy", 1_000_000n, address(usdcCoin.config), DEVNET_USDC);

    // The creator's page: each coin in its own quote, and what waits in each.
    await openCreatorPage(page);
    const solFees = await partnerFees(address(solCoin.pool));
    const usdcFees = await partnerFees(address(usdcCoin.pool));
    const [solShare, usdcShare] = [creatorShare(solFees), creatorShare(usdcFees)];
    expect(solShare).toBeGreaterThan(0n);
    expect(usdcShare).toBeGreaterThan(0n);
    const listed = await api(`/earnings/${creator.address}`, CreatorEarnings);
    expect(listed.quotes.map((q) => [q.quote.symbol, q.quote.decimals, q.waiting])).toEqual([
      ["SOL", 9, `${solShare}`],
      ["USDC", 6, `${usdcShare}`],
    ]);
    expect(listed.quotes[0]!.coins).toEqual([expect.objectContaining({ mint: solMint, partnerFees: `${solFees}`, windowClaimed: true })]);
    expect(listed.quotes[1]!.coins).toEqual([expect.objectContaining({ mint: usdcMint, partnerFees: `${usdcFees}`, windowClaimed: true })]);
    await expect(page.getByTestId("earnings-waiting")).toHaveText(`${inSol(solShare)}${inUsdc(usdcShare)}`);
    const solGroup = page.getByRole("region", { name: "Your coins priced in SOL" });
    const usdcGroup = page.getByRole("region", { name: "Your coins priced in USDC" });
    await expect(solGroup.getByTestId("earnings-coin")).toHaveCount(1);
    await expect(solGroup.getByTestId("earnings-coin")).toContainText(inSol(solShare));
    await expect(usdcGroup.getByTestId("earnings-coin")).toHaveCount(1);
    await expect(usdcGroup.getByTestId("earnings-coin")).toContainText(inUsdc(usdcShare));
    await expect(usdcGroup).toContainText("claimed in a transaction of its own");
    await snap(page, "quotes-1-both-waiting");

    // One click, one wallet request holding a transaction a quote, each paying exactly the amount shown.
    const usdcAccount = await quoteAccount(creator.address, DEVNET_USDC);
    const rent = (await exists(usdcAccount)) ? 0n : await rpc.getMinimumBalanceForRentExemption(165n).send();
    const [solBefore, usdcBefore, approvals] = [await lamports(creator.address), await tokens(usdcAccount), wallet.approvals.length];
    await page.getByRole("button", { name: `Claim ${inSol(solShare)} and ${inUsdc(usdcShare)}` }).click();
    await expect(page.getByRole("status")).toContainText(`Claimed ${inSol(solShare)} and ${inUsdc(usdcShare)}`, { timeout: 90_000 });
    expect(wallet.approvals.slice(approvals)).toEqual([2]);
    expect(await lamports(creator.address)).toBe(solBefore + solShare - 2n * NETWORK_FEE - rent);
    expect(await tokens(usdcAccount)).toBe(usdcBefore + usdcShare);
    await expect(page.getByTestId("earnings-claimed")).toHaveText(`${inSol(solShare)}${inUsdc(usdcShare)}`, { timeout: 30_000 });
    await snap(page, "quotes-2-both-claimed");

    // The Creator record counts what each quote's claim paid, once the indexer has both.
    const record = await expect
      .poll(async () => (await api(`/creators/${creator.address}`, CreatorRecord)).earnings.map((e) => [e.quote.symbol, e.claimed]), { timeout: 60_000, intervals: [2_000] })
      .toEqual([
        ["SOL", `${solShare}`],
        ["USDC", `${usdcShare}`],
      ])
      .then(() => api(`/creators/${creator.address}`, CreatorRecord));
    await page.goto(`/creator/${record.summary.id}`);
    await expect(page.getByTestId("fact-claimed")).toContainText(inSol(solShare));
    await expect(page.getByTestId("fact-claimed")).toContainText(inUsdc(usdcShare));
    await snap(page, "quotes-3-record");
  } finally {
    await sweepDepositors([trader, creator], USDC).catch((e) => console.error("sweeping the USDC failed", e));
  }
  expect(errors).toEqual([]);
});
