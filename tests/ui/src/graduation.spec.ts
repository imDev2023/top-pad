// Graduation end to end (#51's devnet demo): a creator launches an Instant launch from the site, and a trader buys it
// to its 8.5 SOL Graduation Target from the coin's page once the sniper tax's minute is over, the buy filling only what
// the curve still holds. Heat's keeper then migrates the coin into DAMM v2 with nobody online, and the page shows it
// graduating, then the checkered flag, the graduated pool, its fee and both halves of its liquidity locked forever. The
// trader goes on trading from the same panel, now on the DAMM v2 pool, each trade paying Heat's referral account its
// share; the creator's page shows their LP fees beside their curve earnings and claims both in one transaction; and the
// trader sells everything back. The page is photographed in every view at each step. Real devnet SOL: about 2 a run,
// mostly the fifth of the target that stays locked in the graduated pool forever, and the fees. No page may report an
// error.
import { expect, test, type Page } from "@playwright/test";
import { address, type Address } from "@solana/kit";
import { CLUSTERS, graduatedPoolAddress, swapInstructions } from "@top-pad/chain";
import { fetchMaybePool } from "@top-pad/clients/damm-v2";
import { Coin, CreatorEarnings } from "@top-pad/contract";
import { coinBalance, fundedWallets, landed, rpc, send, sweep } from "@top-pad/tests-devnet/devnet";
import { launchCoin, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const devnet = CLUSTERS.devnet!;
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;

/** How a landed transaction changed the treasury's quote account: Heat's referral share of a swap. */
async function referralShare(signature: string) {
  type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  const meta = (await landed(signature)).meta as { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  const of = (balances: Balance[] = []) =>
    BigInt(balances.find((b) => b.owner === devnet.keys!.treasury && b.mint === devnet.quote.mint)?.uiTokenAmount.amount ?? "0");
  return of(meta.postTokenBalances) - of(meta.preTokenBalances);
}

/** One quick trade from the panel, sent and confirmed; its signature. */
async function trade(page: Page, side: "buy" | "sell", pick: { amount: string } | { preset: string }, shot?: string) {
  const panel = page.getByRole("region", { name: "Quick trade" });
  await panel.getByRole("radio", { name: side === "buy" ? "Buy" : "Sell", exact: true }).click();
  if ("amount" in pick) await panel.getByLabel(side === "buy" ? "Spend" : "Sell", { exact: true }).fill(pick.amount);
  else await panel.getByRole("button", { name: pick.preset, exact: true }).click();
  await expect(panel.getByTestId("quick-trade-fee")).toBeVisible();
  if (shot) await snap(page, shot);
  const button = panel.getByRole("button", { name: side === "buy" ? /^Buy / : /^Sell / });
  await expect(button).toBeEnabled();
  await button.click();
  const done = panel.getByTestId("quick-trade-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  return (await done.getByRole("link").getAttribute("href"))!.match(/\/tx\/(\w+)/)![1]!;
}

test("a coin bought to its Graduation Target graduates into DAMM v2 by Heat's keeper and trades on from its page", async ({ page, browser }) => {
  test.setTimeout(12 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const target = devnet.graduationTarget;
  const [creator, trader] = await fundedWallets(40_000_000n, (target * 104n) / 100n + 150_000_000n);

  const traderPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  const traderErrors = pageErrors(traderPage);
  await installTestWallet(traderPage, trader);
  await traderPage.goto("/");
  await connectTestWallet(traderPage, traderPage.getByRole("banner").getByRole("button", { name: "Connect wallet" }));

  let mint: string | null = null;
  try {
    ({ mint } = await launchCoin(page, creator, { name: "Heat Graduation", ticker: newTicker() }));
    await traderPage.goto(`/coin/${mint}`);
    await expect(traderPage.getByRole("heading", { level: 1 })).toContainText("Heat Graduation", { timeout: 30_000 });
    const coin = await api(`/coins/${mint}`, Coin);
    const opened = Date.parse(coin.activatedAt);
    const offset = Date.parse(coin.servedAt) - Date.now();
    // After the sniper tax's minute, at the 1.25% curve fee.
    while (Date.now() + offset - opened < 63_000) await sleep(500);

    // The buy that reaches Graduation: more than the curve holds, so only part of it fills, as the panel says first.
    const panel = traderPage.getByRole("region", { name: "Quick trade" });
    await panel.getByRole("radio", { name: "Buy", exact: true }).click();
    await panel.getByLabel("Spend", { exact: true }).fill("8.9");
    await expect(panel.getByText(/^Only [\d.]+ SOL of it fills$/)).toBeVisible({ timeout: 15_000 });
    await snap(traderPage, "graduation-1-buy-to-target");
    const completing = await trade(traderPage, "buy", { amount: "8.9" });
    console.log(`the buy that completed the curve: ${completing}`);

    // The curve completes; Heat's keeper graduates the coin with nobody online, and the page follows it live.
    const graduated = traderPage.getByTestId("coin-graduated");
    await expect(traderPage.getByTestId("coin-graduating").or(graduated)).toBeVisible({ timeout: 60_000 });
    if (await traderPage.getByTestId("coin-graduating").isVisible()) await snap(traderPage, "graduation-2-graduating");
    const completedAt = Date.now();
    await expect(graduated).toBeVisible({ timeout: 180_000 });
    console.log(`graduated ${((Date.now() - completedAt) / 1000).toFixed(1)} s after the page showed the curve complete`);
    await expect(traderPage.getByTestId("coin-graduated-flag")).toBeVisible();
    await expect(graduated).toContainText("100% locked forever");
    await expect(traderPage.getByTestId("coin-graduated-fee")).toHaveText("1.25%");
    await snap(traderPage, "graduation-3-graduated");

    const after = await api(`/coins/${mint}`, Coin);
    const g = after.graduation!.graduated!;
    expect(g.pool).not.toBe(after.pool);
    // The keeper's steps after the migration: the surplus split, then the leftover burnt.
    const keeperDone = async () => {
      const g = (await api(`/coins/${mint}`, Coin)).graduation!;
      return g.surplus !== null && g.graduated!.leftoverBurnt !== null;
    };
    await expect.poll(keeperDone, { timeout: 90_000 }).toBe(true);

    // Trading goes on from the same panel, on the graduated pool, paying Heat's referral account its share.
    const buy = await trade(traderPage, "buy", { preset: "0.1 SOL" }, "graduation-4-buy-on-damm");
    const half = await trade(traderPage, "sell", { preset: "50%" });
    for (const signature of [buy, half]) {
      await expect(traderPage.locator(`[data-trade="${signature}:0"]`)).toHaveCount(1, { timeout: 30_000 });
      expect(await referralShare(signature), `Heat's referral share of ${signature}`).toBeGreaterThan(0n);
    }
    await snap(traderPage, "graduation-5-traded-on-damm");

    // The creator's page, in the browser they launched from: their LP fees from the graduated pool beside their curve
    // earnings, both claimed in one go.
    await page.goto("/creator");
    const waiting = page.getByTestId("earnings-waiting");
    const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
    await expect(waiting.or(connect)).toBeVisible({ timeout: 30_000 });
    if (await connect.isVisible()) await connectTestWallet(page, connect);
    await expect(page.getByTestId("earnings-lp-fees")).toBeVisible({ timeout: 30_000 });
    await snap(page, "graduation-6-creator-lp-fees");
    const earnings = await api(`/earnings/${creator.address}`, CreatorEarnings);
    const shown = earnings.quotes.flatMap((q) => q.coins).find((c) => c.mint === mint)!;
    expect(BigInt(shown.lpFees)).toBeGreaterThan(0n);
    const before = await lamports(creator.address);
    await page.getByRole("button", { name: /^Claim / }).click();
    await expect(page.getByText(/^Claimed [\d.]+\sSOL$/)).toBeVisible({ timeout: 60_000 });
    await snap(page, "graduation-7-creator-claimed");
    // At least what the page showed, less the network fee and the coin account the LP claim opens.
    const rent = await rpc.getMinimumBalanceForRentExemption(165n).send();
    expect((await lamports(creator.address)) - before).toBeGreaterThanOrEqual(BigInt(shown.waiting) - 5_000n - rent);

    // Everything the trader holds goes back into the graduated pool.
    await trade(traderPage, "sell", { preset: "All" });
    expect(await coinBalance(trader.address, address(mint))).toBe(0n);
    await snap(traderPage, "graduation-8-sold-all");
  } finally {
    // A run stopped after Graduation sells back what the trader still holds, so its SOL comes home.
    if (mint) await sellBack(trader, address(mint)).catch((e: Error) => console.error(`selling back failed: ${e.message}`));
    await sweep(trader, creator);
    expect(errors).toEqual([]);
    expect(traderErrors).toEqual([]);
  }
});

/** Sells everything `trader` holds of a graduated coin into its DAMM v2 pool. */
async function sellBack(trader: Parameters<typeof sweep>[0], mint: Address) {
  const held = await coinBalance(trader.address, mint);
  const pool = await graduatedPoolAddress(mint, devnet.quote.mint);
  if (held === 0n || !(await fetchMaybePool(rpc, pool)).exists) return;
  const instructions = await swapInstructions({
    config: devnet.configs!.instant,
    pool,
    mint,
    quoteMint: devnet.quote.mint,
    trader,
    side: "sell",
    amountIn: held,
    minimumOut: 1n,
    graduatedPool: pool,
  });
  await send(trader, instructions);
}
