// Quick buy and sell end to end (#43's devnet demo): a creator launches an Instant launch from the site, and a trader
// buys and sells it from the coin's page inside the sniper tax's minute and after it, signing in their wallet. The fee
// the page shows before signing must be within one 1-second step of what the chain charged; each trade must show on
// the page the moment it confirms, from the browser's fast path or the indexer, whichever reports it first (locally
// the indexer's logs socket often does; deployed, Helius serves a transaction seconds late and the fast path wins),
// and stay one row once the indexer has; and every swap must pay Heat's referral account its share. The panel is photographed in every view at each step. Real devnet SOL: about
// 0.08 a run, most of it the tax the trader pays. No page may report an error.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { address } from "@solana/kit";
import { FEE_DENOMINATOR, SNIPER_TAX, CLUSTERS, referralAccountOf, TOKEN_PROGRAM_ADDRESS } from "@top-pad/chain";
import { Coin, CoinTrades } from "@top-pad/contract";
import { coinBalance, fundedWallets, landed, sweep } from "@top-pad/tests-devnet/devnet";
import { launchCoin, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const devnet = CLUSTERS.devnet!;
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One of the sniper tax's 1-second steps, in percentage points. */
const STEP = (Number(SNIPER_TAX.reductionFactor) / Number(FEE_DENOMINATOR)) * 100;

/** The percentage a locator shows first, as a number. */
async function rateOf(locator: Locator) {
  return Number((await locator.textContent())!.match(/([\d.]+)%/)![1]);
}

/** How a landed transaction changed the treasury's quote account, from its own token balances. */
async function referralShare(signature: string) {
  type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  const meta = (await landed(signature)).meta as { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  const of = (balances: Balance[] = []) =>
    BigInt(balances.find((b) => b.owner === devnet.keys!.treasury && b.mint === devnet.quote.mint)?.uiTokenAmount.amount ?? "0");
  return of(meta.postTokenBalances) - of(meta.preTokenBalances);
}

/**
 * One quick trade from the panel: the amount typed or picked, the fee read off the panel the moment before signing,
 * then the trade sent; it answers with the fee shown, the trade's row and its signature.
 */
async function trade(page: Page, side: "buy" | "sell", pick: { amount: string } | { preset: string }, shot?: string) {
  const panel = page.getByRole("region", { name: "Quick trade" });
  await panel.getByRole("radio", { name: side === "buy" ? "Buy" : "Sell", exact: true }).click();
  if ("amount" in pick) await panel.getByLabel(side === "buy" ? "Spend" : "Sell", { exact: true }).fill(pick.amount);
  else await panel.getByRole("button", { name: pick.preset, exact: true }).click();
  const fee = panel.getByTestId("quick-trade-fee");
  await expect(fee).toBeVisible();
  if (shot) await snap(page, shot);
  const button = panel.getByRole("button", { name: side === "buy" ? /^Buy / : /^Sell / });
  await expect(button).toBeEnabled();
  const shown = await rateOf(fee);
  await button.click();
  const done = panel.getByTestId("quick-trade-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  const signature = (await done.getByRole("link").getAttribute("href"))!.match(/\/tx\/(\w+)/)![1]!;
  return { shown, signature, row: page.locator(`[data-trade="${signature}:0"]`) };
}

test("a trader buys and sells from the coin's page, seeing the fee before signing, during the sniper tax and after it", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, trader] = await fundedWallets(30_000_000n, 200_000_000n);

  // The trader's browser, its wallet connected before the coin exists, so the trading starts as soon as it does.
  const traderPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  const traderErrors = pageErrors(traderPage);
  await installTestWallet(traderPage, trader);
  await traderPage.goto("/");
  await connectTestWallet(traderPage, traderPage.getByRole("banner").getByRole("button", { name: "Connect wallet" }));

  try {
    const { mint } = await launchCoin(page, creator, { name: "Heat Quick", ticker: newTicker() });
    await traderPage.goto(`/coin/${mint}`);
    await expect(traderPage.getByRole("heading", { level: 1 })).toContainText("Heat Quick", { timeout: 30_000 });
    const panel = traderPage.getByRole("region", { name: "Quick trade" });
    await expect(panel.getByTestId("quick-trade-held")).toContainText("0.2 SOL");
    const coin = await api(`/coins/${mint}`, Coin);
    const opened = Date.parse(coin.activatedAt);
    const offset = Date.parse(coin.servedAt) - Date.now();
    const elapsed = () => (Date.now() + offset - opened) / 1000;

    // More than the wallet holds is refused before anything is built.
    await panel.getByLabel("Spend", { exact: true }).fill("5");
    await expect(panel.getByText("That is more SOL than this wallet holds.")).toBeVisible();

    // Inside the minute: the sniper tax shows yellow on the panel, falling, and the buy pays within a step of it.
    const runs: { at: number; side: string; shown: number; charged: number; first: string }[] = [];
    const record = async (side: string, t: Awaited<ReturnType<typeof trade>>) => {
      // On the page the moment the panel says it confirmed: the fast path's answer is what tells the panel.
      await expect(t.row).toBeVisible({ timeout: 1_000 });
      const first = (await t.row.getAttribute("data-pending")) === "true" ? "fast path" : "indexer";
      const charged = await rateOf(t.row.locator("td").nth(4));
      runs.push({ at: Math.round(elapsed()), side, shown: t.shown, charged, first });
      signatures.push(t.signature);
    };
    const signatures: string[] = [];
    console.log(`trading opens ${elapsed().toFixed(1)} s after the open`);
    const buy = await trade(traderPage, "buy", { amount: "0.02" }, "quick-1-buy-during-tax");
    expect(elapsed()).toBeLessThan(60);
    await record("buy", buy);
    await snap(traderPage, "quick-2-bought-during-tax");
    const sell = await trade(traderPage, "sell", { preset: "50%" });
    await record("sell", sell);
    expect(runs.filter((r) => r.at < 60).length).toBe(2);

    // After the minute: the trading fee, green, a buy and then everything sold.
    while (elapsed() < 63) await sleep(500);
    await expect(traderPage.getByLabel("Sniper tax")).toContainText("Fee now");
    await record("buy", await trade(traderPage, "buy", { preset: "0.05 SOL" }, "quick-3-buy-after-tax"));
    await record("sell", await trade(traderPage, "sell", { preset: "All" }));
    await snap(traderPage, "quick-4-sold-all");

    console.table(runs.map((r) => ({ ...r, shown: `${r.shown}%`, charged: `${r.charged}%` })));
    // The indexer's report of each replaced the page's own in place: one row, never two; and each paid Heat's referral
    // account its share.
    for (const signature of signatures) {
      await expect(traderPage.locator(`[data-trade="${signature}:0"]:not([data-pending])`)).toBeVisible({ timeout: 30_000 });
      await expect(traderPage.locator(`[data-trade="${signature}:0"]`)).toHaveCount(1);
      expect(await referralShare(signature), `Heat's referral share of ${signature}`).toBeGreaterThan(0n);
    }
    for (const r of runs) expect(Math.abs(r.shown - r.charged), `the ${r.side} at ${r.at} s`).toBeLessThanOrEqual(STEP + 0.01);
    expect(runs.at(-1)!.charged).toBe(1.25);
    expect(await coinBalance(trader.address, address(mint))).toBe(0n);
    // Every trade is the indexer's now too, once.
    const { trades } = await api(`/coins/${mint}/trades?limit=50`, CoinTrades);
    expect(trades.filter((t) => t.trader === trader.address)).toHaveLength(4);
    expect(await referralAccountOf(devnet.keys!.treasury, devnet.quote.mint, TOKEN_PROGRAM_ADDRESS)).toBe("CrQJCsFgWLETU8vPcavPV6SWyQsVSFJ5RkYxckpXWXu7");

    // A visitor with no wallet sees the quote and the fee too, and connects from the panel.
    const visitor = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    const visitorErrors = pageErrors(visitor);
    await visitor.goto(`/coin/${mint}`);
    const visitorPanel = visitor.getByRole("region", { name: "Quick trade" });
    await visitorPanel.getByRole("button", { name: "0.1 SOL", exact: true }).click();
    await expect(visitorPanel.getByTestId("quick-trade-fee")).toContainText("1.25%");
    await expect(visitorPanel.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await snap(visitor, "quick-5-no-wallet");
    expect(visitorErrors).toEqual([]);
  } finally {
    expect(errors).toEqual([]);
    expect(traderErrors).toEqual([]);
    await sweep(trader, creator);
  }
});
