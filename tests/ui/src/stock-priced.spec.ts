// Stock-priced coins from the site (#90's devnet demo, ADR 0007): the launch form's quote picker lists SOL, devnet USDC
// and the stand-in xStock, read from the chain, each quote's Quote Risk Labels read from its mint; the stand-in waits for
// Meteora's TokenBadge and cannot be chosen to launch in. A creator launches an Instant launch in USDC from the picker,
// and a trader buys and sells it from the coin's page in USDC once the sniper tax's minute is over; then a creator
// schedules a Fair Open in USDC from the picker, deposits in USDC from its page, and the keeper opens it, the coin then
// trading in USDC. Every amount the pages show is in USDC, never SOL but rent. Every step is photographed in every view.
// Real devnet SOL and USDC: about 0.1 SOL a run, and about 0.8 USDC the Fair Open's pot spends (the rest returned);
// Heat's bank must hold 1.5 USDC (`pnpm --filter @top-pad/chain devnet-usdc devnet <SOL> --send`). About 15 minutes,
// most of it the Fair Open's window: pass `stock-priced.spec.ts` to run it alone.
import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { DEVNET_USDC, TOKEN_PROGRAM_ADDRESS } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { Coin, FairOpen, QuoteList } from "@top-pad/contract";
import { chainTime, coinBalance, fundedWallets, rpc } from "@top-pad/tests-devnet/devnet";
import { fundQuote, quoteHeld, sweepDepositors } from "@top-pad/tests-devnet/fair-open";
import { expectVampClear, signInOnLaunch, newTicker, pageErrors, runName, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const USDC = { mint: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

/** Links X as a new creator and stops at the launch mode and quote step. */
async function startLaunch(page: Page) {
  await page.goto("/launch");
  await signInOnLaunch(page);
  await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible();
  await expect(page.getByTestId("quote-picker")).toBeVisible();
}

/** The coin step, with a ticker and picture drawn for the run. */
async function enterCoin(page: Page, name: string, ticker: string) {
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Ticker").fill(ticker);
  await page.getByLabel("Name").fill(runName(name, ticker));
  await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
  await expectVampClear(page);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("the picker lists each quote with its labels from its mint, and offers only those with settings", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const errors = pageErrors(page);
  const { quotes } = await api("/quotes", QuoteList);
  expect(quotes.map((q) => [q.symbol, q.offered])).toEqual([
    ["SOL", true],
    ["USDC", true],
    ["NVDAx", false],
  ]);
  const standIn = quotes.find((q) => q.symbol === "NVDAx")!;
  console.log(`the stand-in xStock shows its amounts through ${standIn.multiplier}; its labels: ${standIn.labels.map((l) => l.title).join(", ")}`);

  // Signing in costs nothing, so a wallet with no SOL does to read the picker.
  await installTestWallet(page, await generateKeyPairSigner());
  await startLaunch(page);
  const picker = page.getByTestId("quote-picker");
  await expect(picker.getByRole("radio", { name: /^SOL/ })).toBeChecked();
  await expect(page.getByTestId("quote-labels")).toHaveCount(0);

  // The stand-in xStock: chosen to read, its labels read from its mint, and no way on until Meteora badges it.
  await picker.getByRole("radio", { name: /^NVDAx/ }).check();
  await expect(picker).toContainText("It waits for Meteora's TokenBadge");
  const labels = page.getByTestId("quote-labels");
  for (const title of ["Can pause transfers", "Issuer can move tokens", "Can freeze wallets", "Scaled balances"]) await expect(labels).toContainText(title);
  await expect(labels).toContainText(`(${standIn.multiplier.toLocaleString("en-US", { maximumFractionDigits: 4 })} today)`);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await snap(page, "stock-1-picker-stand-in");

  // Devnet USDC: offered, Circle's freeze authority its one label.
  await picker.getByRole("radio", { name: /^USDC/ }).check();
  await expect(labels).toContainText("Can freeze wallets");
  await expect(labels).not.toContainText("Can pause transfers");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await snap(page, "stock-2-picker-usdc");
  expect(errors).toEqual([]);
});

test("an Instant launch in USDC from the picker, bought and sold from its page in USDC", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, trader] = await fundedWallets(30_000_000n, 30_000_000n);
  await fundQuote([trader], [600_000n], USDC, 6);
  try {
    await installTestWallet(page, creator);
    await startLaunch(page);
    await page.getByRole("radio", { name: /Instant launch/ }).check();
    await page.getByTestId("quote-picker").getByRole("radio", { name: /^USDC/ }).check();
    const ticker = newTicker();
    await enterCoin(page, "Heat Dollar", ticker);
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Launched" })).toBeVisible({ timeout: 150_000 });
    const mint = (await page.locator("dd").first().textContent())!.trim();

    // The coin's page reads in USDC: its price, market cap, chart, Graduation and labels.
    const traderPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    const traderErrors = pageErrors(traderPage);
    await installTestWallet(traderPage, trader);
    await traderPage.goto(`/coin/${mint}`);
    await expect(traderPage.getByRole("heading", { level: 1 })).toContainText("Heat Dollar", { timeout: 60_000 });
    const coin = await api(`/coins/${mint}`, Coin);
    expect(coin.quote).toMatchObject({ symbol: "USDC", decimals: 6, multiplier: 1 });
    expect(coin.config).toBe((await api("/quotes", QuoteList)).quotes.find((q) => q.symbol === "USDC")!.settings!.instantConfig);
    const head = traderPage.locator("header dl");
    await expect(head).toContainText("USDC");
    await expect(head).not.toContainText("SOL");
    await expect(traderPage.getByText("Market cap, USDC")).toBeVisible();
    await expect(traderPage.getByTestId("quote-labels")).toContainText("About USDC");
    await expect(traderPage.getByRole("region", { name: "Graduation" })).toContainText("USDC");
    await connectTestWallet(traderPage, traderPage.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const panel = traderPage.getByRole("region", { name: "Quick trade" });
    await expect(panel.getByTestId("quick-trade-held")).toContainText("0.6 USDC");
    await snap(traderPage, "stock-3-coin-usdc");

    // Past the sniper tax's minute, a buy of the 0.5 USDC preset, then a sell of every coin bought, both in USDC.
    await untilChainTime(BigInt(Math.floor(Date.parse(coin.activatedAt) / 1000)) + 62n);
    await panel.getByRole("radio", { name: "Buy", exact: true }).click();
    await panel.getByRole("button", { name: "0.5 USDC", exact: true }).click();
    await expect(panel.getByTestId("quick-trade-fee")).toContainText("USDC");
    await snap(traderPage, "stock-4-buy-usdc");
    await panel.getByRole("button", { name: /^Buy .* with 0\.5\sUSDC$/ }).click();
    await expect(panel.getByTestId("quick-trade-done")).toContainText(/Bought .* for 0\.5\sUSDC/, { timeout: 60_000 });
    const row = traderPage.locator("[data-trade]").first();
    await expect(row).toContainText("0.5");
    await expect(traderPage.getByRole("columnheader", { name: "USDC" })).toBeVisible();
    // The chart draws the coin's first trade once the indexer has its candle, without a reload of the page.
    await expect(traderPage.getByText("No trades yet: the chart starts with the first one.")).toBeHidden({ timeout: 20_000 });
    const coins = await coinBalance(trader.address, mint as Address);
    expect(coins).toBeGreaterThan(0n);
    await panel.getByRole("radio", { name: "Sell", exact: true }).click();
    await panel.getByRole("button", { name: "All", exact: true }).click();
    await panel.getByRole("button", { name: /^Sell / }).click();
    await expect(panel.getByTestId("quick-trade-done")).toContainText(/Sold .* USDC/, { timeout: 60_000 });
    await snap(traderPage, "stock-5-sold-usdc");
    expect(await coinBalance(trader.address, mint as Address)).toBe(0n);
    expect(traderErrors).toEqual([]);
  } finally {
    await sweepDepositors([trader], USDC).catch((e) => console.error("sweeping the trader failed", e));
    await sweepDepositors([creator]).catch((e) => console.error("sweeping the creator failed", e));
  }
  expect(errors).toEqual([]);
});

test("a Fair Open in USDC from the picker, deposited in USDC from its page and opened by the keeper", async ({ page }) => {
  test.setTimeout(22 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator] = await fundedWallets(SOL / 10n);
  await fundQuote([creator], [900_000n], USDC, 6);
  try {
    const wallet = await installTestWallet(page, creator);
    await startLaunch(page);
    await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
    await page.getByTestId("quote-picker").getByRole("radio", { name: /^USDC/ }).check();
    const ticker = newTicker();
    await enterCoin(page, "Heat Dollar Open", ticker);

    // The schedule is in USDC: its minimum raise, the pot's cap and the calendar entry.
    await expect(page.getByRole("heading", { name: "Schedule the window" })).toBeVisible();
    await expect(page.getByLabel("Minimum raise (USDC, optional)")).toBeVisible();
    await expect(page.getByText(/The pot buys at most [\d.]+\sUSDC\./)).toBeVisible();
    await page.getByLabel("Teaser for the calendar (optional)").fill(newTicker());
    await snap(page, "stock-6-schedule-usdc");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText(/What you sign: the schedule and 64 versions of the open/).click();
    await expect(page.getByText(/the pot buys [\d.]+\sUSDC/).first()).toBeVisible();
    await page.getByRole("button", { name: "Sign your open in advance" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
    // The sign-in message, then the schedule and every rung in one approval.
    expect(wallet.approvals).toEqual([1, 65]);

    await page.getByRole("link", { name: "Open its page" }).click();
    await page.waitForURL(/\/fair-open\//);
    const launch = page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
    const view = await api(`/fair-opens/${launch}`, FairOpen);
    expect(view.quote).toMatchObject({ symbol: "USDC", decimals: 6 });
    const account = (await fetchLaunch(rpc, launch)).data;
    expect(account.quoteMint).toBe(DEVNET_USDC);
    expect(account.step).toBe(BigInt(view.step));

    // The creator, Scored by the X account they linked, deposits 8 steps from the page, typed as 0.8 and rounded down.
    await expect(page.getByTestId("quote-labels")).toContainText("About USDC");
    const amount = page.getByLabel(/^Amount \(USDC, in steps of/);
    await amount.fill("0.8");
    const eight = (8n * BigInt(view.step)).toString().padStart(7, "0");
    const shown = `${eight.slice(0, -6)}.${eight.slice(-6)}`.replace(/0+$/, "");
    await snap(page, "stock-7-deposit-usdc");
    await page.getByRole("button", { name: `Deposit ${shown} USDC` }).click();
    await expect(page.getByTestId("fair-open-done")).toContainText(`Deposited ${shown} USDC`, { timeout: 90_000 });
    expect(await quoteHeld(creator.address, USDC)).toBe(900_000n - 8n * BigInt(view.step));

    // Nobody does anything: the keeper opens it at its time, and the coin trades in USDC.
    await untilChainTime(account.opensAt);
    await expect(page.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 180_000 });
    await expect(page.getByTestId("fair-open-coin")).toContainText(ticker, { timeout: 60_000 });
    expect((await fetchLaunch(rpc, launch)).data.status).toBe(LaunchStatus.Opened);
    await expect(page.getByText(/USDC a coin/)).toBeVisible({ timeout: 60_000 });
    await snap(page, "stock-8-opened-usdc");
    const opened = await api(`/fair-opens/${launch}`, FairOpen);
    const mint = opened.open!.mint;
    await page.goto(`/coin/${mint}`);
    await expect(page.locator("header dl")).toContainText("USDC", { timeout: 60_000 });
    await expect(page.getByText("Market cap, USDC")).toBeVisible();
    await snap(page, "stock-9-fair-open-coin-usdc");

    // The keeper settles it: the creator's coins locked, its refund and Tax Share paid in USDC, the launch closed.
    for (let i = 0; i < 40 && (await fetchLaunch(rpc, launch).catch(() => null)); i++) await sleep(15_000);
    console.log(`the creator holds ${await quoteHeld(creator.address, USDC)} raw USDC after the launch closed`);
  } finally {
    await sweepDepositors([creator], USDC).catch((e) => console.error("sweeping the creator failed", e));
  }
  expect(errors).toEqual([]);
});
