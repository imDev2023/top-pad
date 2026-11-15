// "How this is enforced", the P&L share card, and every screen of spec 9 together (#59's devnet demo):
// - "How this is enforced" states every point spec 9 lists, names each of Heat's programs' upgrade authority as the chain
//   holds it, and publishes the counts of bars, appeals and overturned findings that the operator app's Bars page counts
//   from the Bars themselves (an operator app on this Mac against the devnet database, started first with
//   `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui operators`; OPERATOR_URL overrides
//   http://localhost:8803).
// - A trader buys a live Heat coin on devnet and sells half of it from the coin's page; their position's every figure is
//   recomputed from the two transactions on chain (the coins from their token balances, the quote and fee from the swap
//   events) and the price of the snapshot's trade, and found on the page, on the P&L card they share (the image, its
//   link, the post, the saved file) and on the share page X unfurls, whose link card is the card's image. About 0.06
//   devnet SOL a run, most of it bought back; the trader sells the rest and is swept back to the bank at the end.
// - Every screen in spec 9 on real devnet data (Discover, a Fair Open, a Fair Open's coin with its Fairness card open, a
//   graduated coin, a red-flagged coin, the launch flow, a Creator record, How this is enforced, a P&L card, the status
//   page and a missing page), each photographed on a phone and a desktop in both themes, none scrolling sideways, none
//   reporting an error. The operator app's screens are `e2e:operator`'s.
// Run with `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui e2e:devnet heat-screens.spec.ts`.
import { expect, test, type Page } from "@playwright/test";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { CLUSTERS, FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS, priceOfSqrtPrice } from "@top-pad/chain";
import { Coin, CoinTrades, Enforcement, Position } from "@top-pad/contract";
import { coinAmount, pnlPercentText, pnlText } from "@top-pad/contract/format";
import { coins, fairOpens, graduations, pools, coinRadar, trades, bars } from "@top-pad/db";
import { decodeTransaction } from "@top-pad/indexer";
import { coinBalance, fundedWallets, landed, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { and, desc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { database } from "./bundler";
import { pageErrors, VIEWS } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const devnet = CLUSTERS.devnet!;
const OPERATOR = process.env.OPERATOR_URL ?? "http://localhost:8803";
const shots = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "shots");
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * The page in every view, photographed whole, after checking that nothing in it is wider than the screen: a page that
 * scrolls sideways on a phone is off. Then back to the desktop in dark.
 */
async function look(page: Page, step: string) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: 8_000 }).catch(() => undefined);
  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.waitForTimeout(200);
    const wide = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const over = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > width + 1 && getComputedStyle(e).position !== "fixed");
      return { scroll: document.documentElement.scrollWidth, width, over: over.slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`) };
    });
    expect(wide.scroll, `${step} scrolls sideways in ${view.name}: ${wide.over.join(", ")}`).toBeLessThanOrEqual(wide.width);
    await page.screenshot({ path: join(shots, `${step}-${view.name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
}

/** A PNG's width and height, from its IHDR chunk. */
const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

test("How this is enforced states every point spec 9 lists, names who can upgrade each program, and counts as the operator app does", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/enforced");
  await expect(page.getByRole("heading", { level: 1, name: "How this is enforced" })).toBeVisible();

  // Spec 9's list, a promise each, each saying what keeps it and who could still change it.
  const promise = (id: string) => page.getByTestId(`promise-${id}`);
  const says = async (id: string, ...words: (string | RegExp)[]) => {
    await expect(promise(id).getByRole("heading", { name: "What keeps it" })).toBeVisible();
    await expect(promise(id).getByRole("heading", { name: "Who could still change it" })).toBeVisible();
    for (const w of words) await expect(promise(id)).toContainText(w);
  };
  await says("fees", "sniper tax", "Meteora's bonding curve config", "nobody can edit either after it launches", "Nobody can edit a config, Heat included");
  await says("fair-open", "15 minutes after its time", "Fair Open program", "7-day timelock", "a plain key");
  await says("creator-lock", "Nobody can cancel", "Heat included", "Jupiter Lock");
  await says("liquidity", "Nobody can withdraw a coin's liquidity before Graduation, or unlock it after", "locked permanently");
  await says("meteora", "pause a graduated pool", "withdrawals still work", "dynamic fee", "cannot change its base fee until the schedule expires", "Meteora can upgrade its own programs");
  await says("bars", "Heat's judgement", "evidence", "Creators barred", "Appeals filed", "Findings overturned");
  await says("listed", "only coins Heat's launch key co-signed", "only those are listed", "Not launched through");

  // Who can upgrade each program, as the page says it and as the program data account on chain holds it.
  const body = await api("/enforcement", Enforcement);
  for (const [name, program] of [
    ["fee", FEE_PROGRAM_ADDRESS],
    ["fair_open", FAIR_OPEN_PROGRAM_ADDRESS],
  ] as const) {
    const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(address(program))] });
    const { value } = await rpc.getAccountInfo(programData, { encoding: "jsonParsed", commitment: "confirmed" }).send();
    const authority = (value!.data as { parsed: { info: { authority: string | null } } }).parsed.info.authority;
    const said = body.chain!.programs.find((p) => p.name === name)!;
    expect({ read: said.read, upgradeable: said.upgradeable, authority: said.authority?.address ?? null }).toEqual({ read: true, upgradeable: authority !== null, authority });
    if (authority) await expect(page.getByTestId(`authority-${name}`)).toContainText(`${authority.slice(0, 4)}\u{2026}${authority.slice(-4)}`);
  }

  // The counts, on the page, in the API and on the operator app's Bars page, which counts them from the Bars itself.
  const shown = {
    bars: Number(await page.getByTestId("count-bars").textContent()),
    appeals: Number(await page.getByTestId("count-appeals").textContent()),
    overturned: Number(await page.getByTestId("count-overturned").textContent()),
  };
  const operatorPage = await fetch(`${OPERATOR}/bars`).catch(() => null);
  expect(operatorPage?.ok, `the operator app at ${OPERATOR}: start it with \`pnpm --filter @top-pad/tests-ui operators\``).toBe(true);
  const html = await operatorPage!.text();
  const counted = (kind: string) => Number(html.match(new RegExp(`data-testid="public-count-${kind}">(\\d+)<`))![1]);
  const operator = { bars: counted("bars"), appeals: counted("appeals"), overturned: counted("overturned") };
  console.log("counts", { page: shown, api: { bars: body.bars, appeals: body.appeals, overturned: body.overturned }, operator });
  expect(shown).toEqual(operator);
  expect({ bars: body.bars, appeals: body.appeals, overturned: body.overturned }).toEqual(operator);
  // Devnet has published Bars from the bundler simulations: the counts are worth comparing.
  expect(operator.bars).toBeGreaterThan(0);

  // Each Fairness row says where its promise is kept: the page's anchors exist.
  for (const id of ["fees", "fair-open", "creator-lock", "liquidity", "meteora", "bars", "listed", "quotes"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  await look(page, "screens-enforced");
  expect(errors).toEqual([]);
});

/** A swap's figures from its transaction on chain: the coins from the trader's token balances, the quote and fee from DBC's event. */
async function swapOnChain(signature: string, trader: string, mint: string, config: string) {
  const raw = await landed(signature);
  expect(raw.meta?.err ?? null).toBeNull();
  type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  const meta = raw.meta as { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  const held = (balances: Balance[] = []) => BigInt(balances.find((b) => b.owner === trader && b.mint === mint)?.uiTokenAmount.amount ?? "0");
  const coins = held(meta.postTokenBalances) - held(meta.preTokenBalances);
  const [swap] = decodeTransaction(raw, new Set([config])).swaps;
  expect(swap!.trader).toBe(trader);
  expect(swap!.baseAmount).toBe(coins < 0n ? -coins : coins);
  return { side: swap!.side, coins: swap!.baseAmount, quote: swap!.quoteAmount, fee: swap!.fee };
}

/** One quick trade from the coin page's panel, answering with its signature once it confirmed. */
async function quickTrade(page: Page, side: "buy" | "sell", pick: { amount: string } | { preset: string }) {
  const panel = page.getByRole("region", { name: "Quick trade" });
  await panel.getByRole("radio", { name: side === "buy" ? "Buy" : "Sell", exact: true }).click();
  if ("amount" in pick) await panel.getByLabel(side === "buy" ? "Spend" : "Sell", { exact: true }).fill(pick.amount);
  else await panel.getByRole("button", { name: pick.preset, exact: true }).click();
  const button = panel.getByRole("button", { name: side === "buy" ? /^Buy / : /^Sell / });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  const done = panel.getByTestId("quick-trade-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  return (await done.getByRole("link").getAttribute("href"))!.match(/\/tx\/(\w+)/)![1]!;
}

test("a trader shares a P&L card whose numbers match their trades on chain", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const { db, close } = database();
  const errors = pageErrors(page);
  // A live Heat coin in SOL on the curve, past its sniper tax, with room before Graduation.
  const [picked] = await db
    .select({ mint: coins.mint, config: coins.config })
    .from(coins)
    .innerJoin(pools, eq(pools.mint, coins.mint))
    .leftJoin(graduations, eq(graduations.mint, coins.mint))
    .where(
      and(
        eq(coins.config, devnet.configs!.instant),
        isNull(graduations.mint),
        isNull(pools.curveCompletedAt),
        sql`${pools.quoteReserve} < ${pools.graduationTarget} - 2000000000`,
        lte(pools.activatedAt, new Date(Date.now() - 5 * 60_000)),
      ),
    )
    .orderBy(desc(coins.createdAt))
    .limit(1);
  expect(picked, "a live Instant coin on devnet").toBeTruthy();
  const { mint, config } = picked!;
  const [trader] = await fundedWallets(120_000_000n);
  console.log(`trader ${trader.address} on ${mint}`);
  const shared = { errors: [] as string[] };
  try {
    await installTestWallet(page, trader);
    await page.goto(`/coin/${mint}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await expect(page.getByRole("region", { name: "Quick trade" }).getByTestId("quick-trade-held")).toContainText("0.12 SOL");
    // No position before the first trade.
    await expect(page.getByTestId("position")).toHaveCount(0);

    const bought = await quickTrade(page, "buy", { amount: "0.05" });
    const sold = await quickTrade(page, "sell", { preset: "50%" });
    const buy = await swapOnChain(bought, trader.address, mint, config);
    const sell = await swapOnChain(sold, trader.address, mint, config);
    expect([buy.side, sell.side]).toEqual(["buy", "sell"]);

    // The position once the indexer has both trades: its snapshot, and the price of the trade it names, from the chain.
    const read: { position: Position | null } = { position: null };
    await expect
      .poll(
        async () => {
          const res = await fetch(`${TARGET.api}/coins/${mint}/positions/${trader.address}`);
          read.position = res.ok ? Position.nullable().parse(await res.json()) : null;
          return read.position?.swaps ?? 0;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(2);
    const p = read.position!;
    const { trades: around } = await api(`/coins/${mint}/trades?limit=200`, CoinTrades);
    const priced = around.find((t) => t.orderKey === p.at)!;
    expect(priced, "the trade the snapshot is priced at").toBeTruthy();
    const pricedOnChain = decodeTransaction(await landed(priced.signature), new Set([config])).swaps[priced.eventIndex]!;
    expect(Number(p.price)).toBe(Number(priceOfSqrtPrice(pricedOnChain.sqrtPrice, 9)));

    // Every figure, worked out here from the chain alone, by average cost.
    const held = buy.coins - sell.coins;
    const costSold = (buy.quote * sell.coins) / buy.coins;
    const costHeld = buy.quote - costSold;
    const received = sell.quote - sell.fee;
    const [whole, fraction = ""] = p.price.split(".");
    const value = (held * BigInt(`${whole}${fraction}`) * 10n ** 9n) / (10n ** BigInt(fraction.length) * 10n ** 6n);
    const pnl = received - costSold + (value - costHeld);
    expect(p).toMatchObject({
      bought: `${buy.coins}`,
      spent: `${buy.quote}`,
      sold: `${sell.coins}`,
      received: `${received}`,
      fees: `${buy.fee + sell.fee}`,
      held: `${held}`,
      costHeld: `${costHeld}`,
      value: `${value}`,
      realized: `${received - costSold}`,
      unrealized: `${value - costHeld}`,
      pnl: `${pnl}`,
      pnlPercent: Number((pnl * 10_000n) / buy.quote) / 100,
      taxShare: "0",
      fills: 0,
    });
    console.log("position", { spent: p.spent, received: p.received, held: p.held, value: p.value, pnl: p.pnl, pnlPercent: p.pnlPercent, at: p.at });

    // The panel says the same, once it has read the same snapshot.
    const quote = (await api(`/coins/${mint}`, Coin)).quote;
    const panel = page.getByTestId("position");
    await expect(panel.getByTestId("position-pnl")).toHaveText(pnlText(p.pnl, quote, { signed: true }), { timeout: 30_000 });
    await expect(panel.getByTestId("position-spent")).toHaveText(pnlText(p.spent, quote));
    await expect(panel.getByTestId("position-received")).toHaveText(pnlText(p.received, quote));
    await expect(panel.getByTestId("position-held")).toHaveText(`${coinAmount(p.held, 6)} ${p.ticker}`);
    await expect(panel.getByTestId("position-pnl-percent")).toHaveText(pnlPercentText(p.pnlPercent!));

    // The card: the image of the snapshot shown, the post and the link naming its share page.
    await panel.getByTestId("position-share").click();
    const image = panel.getByTestId("position-card-image");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 30_000 }).toBe(1200);
    const card = (await image.getAttribute("src"))!;
    expect(card).toMatch(new RegExp(`^${TARGET.api}/coins/${mint}/positions/${trader.address}/card\\.png\\?at=\\d+$`));
    const at = new URL(card).searchParams.get("at")!;
    // The card shown is of the newest snapshot the panel had, never older than the one checked above.
    expect(BigInt(at) >= BigInt(p.at)).toBe(true);
    const sharePage = `${TARGET.web}/pnl/${mint}/${trader.address}?at=${at}`;
    const post = new URL((await panel.getByTestId("position-share-x").getAttribute("href"))!);
    expect(post.origin + post.pathname).toBe("https://x.com/intent/post");
    expect(post.searchParams.get("url")).toBe(sharePage);
    expect(post.searchParams.get("text")).toContain(`My $${p.ticker} P&L on Heat:`);
    const png = new Uint8Array(await (await fetch(card)).arrayBuffer());
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(sizeOf(png)).toEqual({ width: 1200, height: 600 });
    expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);
    const [download] = await Promise.all([page.waitForEvent("download"), panel.getByTestId("position-download").click()]);
    expect(download.suggestedFilename()).toBe(`heat-pnl-${p.ticker.toLowerCase()}-${at}.png`);
    await look(page, "screens-pnl-1-coin-page");

    // The share page X unfurls: the same figures, its link card the card's image, 2:1.
    const share = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    shared.errors = pageErrors(share);
    await share.goto(sharePage);
    const snapshot = await api(`/coins/${mint}/positions/${trader.address}?at=${at}`, Position);
    await expect(share.getByTestId("pnl-figure")).toContainText(pnlText(snapshot.pnl, quote, { signed: true }));
    expect(await share.locator('meta[property="og:image"]').getAttribute("content")).toBe(card);
    expect(await share.locator('meta[name="twitter:image"]').getAttribute("content")).toBe(card);
    expect(await share.locator('meta[name="twitter:card"]').getAttribute("content")).toBe("summary_large_image");
    await look(share, "screens-pnl-2-share-page");
  } finally {
    // The rest sold back, then everything swept to the bank.
    const left = await coinBalance(trader.address, address(mint)).catch(() => 0n);
    if (left > 0n) await quickTrade(page, "sell", { preset: "All" }).catch((e) => console.warn("selling the rest failed", e));
    await sweep(trader);
    await close();
  }
  expect(errors).toEqual([]);
  expect(shared.errors).toEqual([]);
});

test("every screen of spec 9 on real devnet data, on a phone and a desktop, in both themes", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const { db, close } = database();
  const errors = pageErrors(page);
  try {
    const [fairOpenCoin] = await db
      .select({ mint: fairOpens.mint, launch: fairOpens.launch, creator: fairOpens.creator })
      .from(fairOpens)
      .innerJoin(coins, eq(coins.mint, fairOpens.mint))
      .where(and(isNotNull(fairOpens.lockEscrow), isNotNull(fairOpens.taxShareCollectedAt), gt(fairOpens.seats, 1)))
      .orderBy(desc(fairOpens.openedAt))
      .limit(1);
    const [graduated] = await db.select({ mint: graduations.mint }).from(graduations).innerJoin(coins, eq(coins.mint, graduations.mint)).orderBy(desc(graduations.graduatedAt)).limit(1);
    const [red] = await db
      .select({ mint: coins.mint })
      .from(coinRadar)
      .innerJoin(coins, eq(coins.mint, coinRadar.mint))
      .where(sql`cardinality(${coinRadar.linkedWallets}) > 0`)
      .orderBy(desc(coins.createdAt))
      .limit(1);
    const [barred] = await db.select({ creatorId: bars.creatorId }).from(bars).where(or(lte(bars.publishAt, new Date()), isNotNull(bars.liftedAt))).orderBy(desc(bars.confirmedAt)).limit(1);
    // A Creator record with coins: the latest coin's that has one (a Fair Open a script scheduled has none).
    const [record] = await db.select({ creatorId: coins.creatorId }).from(coins).where(isNotNull(coins.creatorId)).orderBy(desc(coins.createdAt)).limit(1);
    const [traded] = await db
      .select({ mint: trades.mint, trader: trades.trader })
      .from(trades)
      .innerJoin(coins, eq(coins.mint, trades.mint))
      .where(eq(trades.side, "sell"))
      .orderBy(desc(trades.orderKey))
      .limit(1);
    const found = { fairOpenCoin, graduated, red, record, traded };
    expect(Object.entries(found).filter(([, v]) => !v).map(([k]) => k), "devnet has each kind of screen's data").toEqual([]);

    const screens: { name: string; path: string; ready: (p: Page) => Promise<void> }[] = [
      { name: "discover", path: "/", ready: (p) => expect(p.getByRole("heading", { name: "Live now" })).toBeVisible() },
      { name: "fair-open", path: `/fair-open/${fairOpenCoin!.launch}`, ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
      {
        name: "coin-fair-open-card",
        path: `/coin/${fairOpenCoin!.mint}#fairness`,
        ready: async (p) => {
          await expect(p.getByTestId("fairness-card")).toBeVisible({ timeout: 20_000 });
          await expect(p.getByTestId("fairness-enforced-launch")).toHaveAttribute("href", "/enforced#fair-open");
        },
      },
      { name: "coin-graduated", path: `/coin/${graduated!.mint}`, ready: (p) => expect(p.getByTestId("coin-graduated-flag")).toBeVisible() },
      { name: "coin-red", path: `/coin/${red!.mint}`, ready: (p) => expect(p.getByTestId("fairness")).toBeVisible() },
      { name: "launch", path: "/launch", ready: (p) => expect(p.getByRole("heading", { name: "Connect your wallet" })).toBeVisible() },
      { name: "creator-record", path: `/creator/${record!.creatorId}`, ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
      ...(barred ? [{ name: "creator-barred", path: `/creator/${barred.creatorId}`, ready: (p: Page) => expect(p.getByText(/Barred/).first()).toBeVisible() }] : []),
      { name: "enforced", path: "/enforced", ready: (p) => expect(p.getByTestId("promise-fees")).toBeVisible() },
      { name: "pnl", path: `/pnl/${traded!.mint}/${traded!.trader}`, ready: (p) => expect(p.getByTestId("pnl-image")).toBeVisible() },
      { name: "status", path: "/status", ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
      { name: "missing", path: "/no-such-page", ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
    ];
    for (const screen of screens) {
      await page.goto(screen.path);
      await screen.ready(page);
      // Live figures and pictures settle.
      await page.waitForTimeout(1_500);
      await look(page, `screens-${screen.name}`);
    }
    // From the board, a coin row's flags open its Fairness card.
    await page.goto("/");
    const flagged = page.getByTestId("coin-row-flags").first();
    if (await flagged.count()) {
      await flagged.click();
      await expect(page.getByTestId("fairness-card")).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await close();
  }
  // A missing page answers 404, which the browser logs as a failed load; nothing else may be reported.
  expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
});
