// The Discover board (spec 8, 9 screen 1; #57's devnet demo). A test cohort: two Fair Opens scheduled from the site, one
// taking deposits now and one later, and three Instant launches from the site, each sniped by the same bot wallet, its
// buys signed in advance and sent as the launch goes out, as a bot would; then wallets buy the three coins past the
// sniper tax, four, two and one of them, and strangers buy a pool made around Heat's flow. The board shows the sealed
// Fair Opens in Live now and Up next, nothing of their coins; ranks the three coins by their unique net buyers, pushed
// over its live room every 15 s; lists the bot on the known-bot list once it bought in the first 2 seconds of 3 launches,
// after which Trending never counts it, until an operator takes it off (in an operator app on this Mac, against the devnet
// database); never shows the pool made around Heat's flow, on the board or in search; and lists the Fair Open's coin in
// New at its open. Every view of the board is photographed.
// Run it alone with `e2e:devnet board.spec.ts`, after starting the operator apps:
// `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui operators` (OPERATOR_URL overrides http://localhost:8803).
// About 30 minutes and 0.25 devnet SOL a run, most of it three pools' rent; the wallets derive from the bank's key and the
// run's name, which it logs, and are swept back at the end; a stopped run is swept with
// `pnpm exec tsx tests/ui/src/boardRun.ts <run> [--fair-open <mint>] [instant mint...]`.
import { expect, test, type Page } from "@playwright/test";
import type { Address, KeyPairSigner } from "@solana/kit";
import { Tier } from "@top-pad/chain";
import { fetchLaunch } from "@top-pad/clients/fair-open";
import { Board, LiveBatch, PreparedLaunch, SearchResults } from "@top-pad/contract";
import { coinRadar, coins, fairOpens, knownBots, launches, pools, trades } from "@top-pad/db";
import { signedBundle, spray, wrapSol } from "@top-pad/tests-devnet/bundle";
import { chainTime, fund, poolAroundHeat, rpc, swap } from "@top-pad/tests-devnet/devnet";
import { admitted, deposit, newPerson } from "@top-pad/tests-devnet/fair-open";
import { and, eq, inArray, sql } from "drizzle-orm";
import { api, BUY, COPIES, database, INSTANT, SOL, sleep, waitFor } from "./bundler";
import { boardWallets, sweepBoardRun } from "./boardRun";
import { expectVampLaunchable, launchCoin, newTicker, pageErrors, runName, signInOnLaunch, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { installTestWallet } from "./wallet";

const OPERATOR = process.env.OPERATOR_URL ?? "http://localhost:8803";
const board = () => api("/board", Board);

/** Schedules a Fair Open from the site, now or with its window starting `startIn` ms from now, and returns its launch. */
async function scheduleFromSite(page: Page, creator: KeyPairSigner, teaser: string, startIn: number | null): Promise<Address> {
  await installTestWallet(page, creator);
  const ticker = newTicker();
  await page.goto("/launch");
  await signInOnLaunch(page);
  await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Ticker").fill(ticker);
  await page.getByLabel("Name").fill(runName("Board Open", ticker));
  await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
  // A drawn picture may look like an earlier test coin's to SSCD (#107): the label does not stop a launch.
  await expectVampLaunchable(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Schedule the window" })).toBeVisible();
  if (startIn !== null) {
    await page.getByRole("radio", { name: /Later/ }).check();
    const at = new Date(Date.now() + startIn);
    const pad = (n: number) => String(n).padStart(2, "0");
    await page.getByLabel("Starts at, your local time").fill(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`);
  }
  await page.getByLabel("Teaser for the calendar (optional)").fill(teaser);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Sign your open in advance" }).click();
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
  await page.getByRole("link", { name: "Open its page" }).click();
  await page.waitForURL(/\/fair-open\//);
  return page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
}

/**
 * Launches an Instant coin from the site while the bot's buys, signed the moment the launch is prepared, go out from the
 * moment it is submitted, 100 ms apart for 1.6 s: the creation lands 0.4 to 1.4 s after the submit (2026-11-02).
 */
async function launchSniped(page: Page, creator: KeyPairSigner, bot: KeyPairSigner): Promise<Address> {
  let signing: ReturnType<typeof signedBundle> | null = null;
  let sent: Promise<void> | null = null;
  const onResponse = async (res: import("@playwright/test").Response) => {
    if (res.request().method() !== "POST" || new URL(res.url()).pathname !== "/launches" || !res.ok()) return;
    const prepared = PreparedLaunch.parse(await res.json());
    if (prepared.mode !== "instant") return;
    signing = signedBundle([[bot]], prepared.mint as Address, INSTANT, BUY, COPIES);
  };
  const onRequest = (req: import("@playwright/test").Request) => {
    if (req.method() !== "POST" || !/\/launches\/[^/]+\/submit$/.test(new URL(req.url()).pathname)) return;
    sent = signing!.then((copies) => spray(copies.map((c) => [c]), 100));
  };
  page.on("response", onResponse);
  page.on("request", onRequest);
  try {
    const { mint } = await launchCoin(page, creator, { name: "Board Coin", ticker: newTicker() }, { looksLike: true });
    await sent;
    return mint as Address;
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
  }
}

test("the board ranks a cohort's coins by their people, every 15 s, and shows only Heat coins", async ({ page, browser }) => {
  test.setTimeout(60 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const run = `board-${Date.now()}`;
  const w = await boardWallets(run);
  console.log(`board run ${run}: bot ${w.bot.address}`);
  const { db, close } = database();
  const mints: Address[] = [];
  let around: { mint: Address } | null = null;
  let openedMint: Address | null = null;
  let laterLaunch: Address | null = null;
  const all = w.all;
  try {
    await fund(all, [...w.creators.map(() => SOL / 20n), SOL / 20n, SOL / 20n, SOL / 20n, ...w.buyers.map(() => SOL / 50n), (SOL * 35n) / 100n, SOL / 20n]);
    await wrapSol(w.bot, BUY * BigInt(COPIES) * 6n);

    // The calendar: a Fair Open taking deposits now, and one whose window starts in 6 minutes.
    const teaserNow = newTicker();
    const teaserLater = newTicker();
    const now = await scheduleFromSite(page, w.openNow, teaserNow, null);
    const laterPage = await browser.newPage();
    const later = await scheduleFromSite(laterPage, w.openLater, teaserLater, 6 * 60_000);
    await laterPage.close();
    laterLaunch = later;
    const sealed = await db.select({ ticker: launches.ticker, mint: launches.mint, name: launches.name }).from(launches).where(inArray(launches.fairOpen, [now, later]));
    expect(sealed).toHaveLength(2);

    await deposit(now, w.depositor, 30n * 10_000_000n, await admitted(now, w.depositor.address, newPerson(), Tier.Scored));
    const calendar = await waitFor(board, (b) => b.liveNow.some((e) => e.launch === now && e.pot.total === "300000000") && b.upNext.some((e) => e.launch === later), 120_000);
    expect(calendar.liveNow.find((e) => e.launch === now)).toMatchObject({ teaser: teaserNow, phase: "window", pot: { seats: 1 }, creator: { wallet: w.openNow.address } });
    expect(calendar.upNext.find((e) => e.launch === later)).toMatchObject({ teaser: teaserLater, phase: "scheduled" });

    await page.goto("/");
    const live = page.getByTestId("section-live");
    await expect(live.getByTestId("calendar-entry").filter({ hasText: teaserNow })).toContainText("0.3\u{a0}SOL from 1 person");
    await expect(page.getByTestId("section-next").getByTestId("calendar-entry").filter({ hasText: teaserLater })).toBeVisible();
    // Sealed: nothing of either coin in the page, its source or the API's answer.
    const texts = [await page.content(), await (await fetch(`${TARGET.web}/`)).text(), JSON.stringify(await board())];
    for (const s of sealed) for (const text of texts) for (const secret of [s.ticker, s.mint, s.name]) expect(text.includes(secret), `${secret} showed before the open`).toBe(false);
    await snap(page, "board-1-calendar");

    // Three Instant launches, each sniped by the bot; more, at most three, while the bot has not bought in the first 2
    // seconds of three launches: its buys must land within 2 seconds of the creation.
    const early = async () =>
      (
        await db
          .selectDistinct({ mint: trades.mint })
          .from(trades)
          .innerJoin(pools, eq(pools.mint, trades.mint))
          .where(and(eq(trades.trader, w.bot.address), inArray(trades.mint, mints.length ? mints : ["none"]), sql`${trades.at} < ${pools.activatedAt} + interval '2 seconds'`))
      ).length;
    for (let i = 0; i < w.creators.length && (mints.length < 3 || (await early()) < 3); i++) {
      const launchPage = await browser.newPage();
      mints.push(await launchSniped(launchPage, w.creators[i]!, w.bot));
      await launchPage.close();
      await waitFor(async () => (await db.select().from(coins).where(eq(coins.mint, mints.at(-1)!))).length, (n) => n === 1, 60_000);
      await sleep(15_000);
      console.log(`launch ${i + 1}: ${mints.at(-1)}, the bot early in ${await early()}`);
    }
    expect(await early()).toBeGreaterThanOrEqual(3);
    const [a, b, c] = mints as [Address, Address, Address];

    // The pool made around Heat's flow, which strangers buy.
    around = await poolAroundHeat(w.around);

    // Past the sniper tax, wallets buy: four of the first coin, two of the second, one of the third; and three the pool
    // made around Heat's flow.
    await sleep(65_000);
    const buy = (buyer: KeyPairSigner, mint: Address) => swap(buyer, mint, "buy", SOL / 500n);
    for (const buyer of w.buyers.slice(0, 4)) await buy(buyer, a);
    for (const buyer of w.buyers.slice(4, 6)) await buy(buyer, b);
    await buy(w.buyers[6]!, c);
    for (const buyer of w.buyers.slice(0, 3)) await buy(buyer, around.mint);

    // Trending ranks them by people. The bot bought all three: counted until the known-bot job lists it, except where its
    // buy landed in the four transactions right after the creation, which Bundle Radar takes for a direct link to the
    // creator (spec 6.5), so Trending never counts it on that coin.
    const counts = (t: Board["trending"]) => [a, b, c].map((m) => t.find((x) => x.mint === m)?.trending?.buyers ?? 0);
    await waitFor(async () => (await db.select().from(coinRadar).where(inArray(coinRadar.mint, [a, b, c]))).length, (n) => n === 3, 120_000);
    const radars = await db.select().from(coinRadar).where(inArray(coinRadar.mint, [a, b, c]));
    const botTied = [a, b, c].map((m) => radars.find((r) => r.mint === m)!.linkedWallets.includes(w.bot.address));
    const listedCounts = [4, 2, 1];
    const unlistedCounts = listedCounts.map((n, i) => n + (botTied[i] ? 0 : 1));
    console.log(`the bot is tied to the creator on ${botTied.filter(Boolean).length} of the 3 coins`);
    const same = (x: number[], y: number[]) => JSON.stringify(x) === JSON.stringify(y);
    const ranked = await waitFor(board, (x) => same(counts(x.trending), unlistedCounts) || same(counts(x.trending), listedCounts), 180_000);
    // Ranked by people: more buyers first.
    const order = ranked.trending.map((x) => x.mint).filter((m) => ([a, b, c] as string[]).includes(m));
    expect(order.map((m) => counts(ranked.trending)[[a, b, c].indexOf(m as Address)])).toEqual([...counts(ranked.trending)].sort((x, y) => y - x));
    expect(order[0]).toBe(a);
    console.log(`trending: ${JSON.stringify(counts(ranked.trending))}`);

    // Pushed every 15 s over the board's live room, read without a reload.
    const pushes: number[] = [];
    page.on("websocket", (ws) =>
      ws.on("framereceived", (f) => {
        const batch = LiveBatch.safeParse(JSON.parse(String(f.payload)));
        for (const e of batch.success ? batch.data.events : []) if (e.type === "trending") pushes.push(Date.parse(e.at));
      }),
    );
    await page.reload();
    await expect.poll(() => pushes.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    const gaps = pushes.slice(1).map((t, i) => (t - pushes[i]!) / 1000);
    console.log(`trending pushed ${gaps.map((g) => `${g.toFixed(1)} s`).join(", ")} apart`);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(14);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(20);
    await expect(page.getByTestId("section-trending").locator(`[data-mint="${a}"]`)).toBeVisible();

    // The known-bot job lists the bot, and Trending stops counting it.
    const listed = await waitFor(async () => (await db.select().from(knownBots).where(eq(knownBots.wallet, w.bot.address)))[0] ?? null, (r) => r !== null, 7 * 60_000);
    expect(listed!.earlyLaunches).toBeGreaterThanOrEqual(3);
    await waitFor(board, (x) => same(counts(x.trending), listedCounts), 60_000);
    await expect(page.locator(`[data-testid="coin-row"][data-mint="${a}"]`).getByTestId("buyers")).toContainText("4 buyers", { timeout: 30_000 });
    await snap(page, "board-2-trending");

    // An operator takes the bot off the list: Trending counts it again within 15 s.
    const operator = await browser.newPage();
    await operator.goto(`${OPERATOR}/bots`);
    const row = operator.locator(`tr[data-wallet="${w.bot.address}"]`);
    await expect(row).toContainText(/Bought in the first 2 seconds of \d+ launches/);
    await snap(operator, "board-3-operator-bots");
    await row.getByLabel(/is no bot/).fill(`Board demo ${run}: taken off to show Trending counting it again.`);
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(operator.getByText("Done, and written to the audit log")).toBeVisible();
    await operator.close();
    await waitFor(board, (x) => same(counts(x.trending), unlistedCounts), 60_000);
    await expect(page.locator(`[data-testid="coin-row"][data-mint="${a}"]`).getByTestId("buyers")).toContainText(`${unlistedCounts[0]} buyers`, { timeout: 30_000 });

    // The pool made around Heat's flow is nowhere: not on the board, the page, nor in search by its mint or its name.
    expect(JSON.stringify(await board())).not.toContain(around.mint);
    expect(await page.content()).not.toContain(around.mint);
    expect((await api(`/search?q=${around.mint}`, SearchResults)).coins).toEqual([]);
    expect((await api(`/search?q=AROUND`, SearchResults)).coins.map((x) => x.mint)).not.toContain(around.mint);
    const coinA = ranked.trending.find((x) => x.mint === a)!;
    await page.getByLabel("Search Heat coins").fill(coinA.ticker);
    await expect(page.getByTestId("section-search").getByTestId("coin-row")).toHaveCount(1);
    await expect(page.getByTestId("section-search").locator(`[data-mint="${a}"]`)).toBeVisible();
    await snap(page, "board-4-search");
    await page.getByLabel("Search Heat coins").fill("");

    // The Fair Open opens: its coin joins New at its open, and leaves Live now.
    const account = (await fetchLaunch(rpc, now)).data;
    while ((await chainTime()) < account.opensAt) await sleep(5_000);
    const opened = await waitFor(async () => (await db.select().from(fairOpens).where(eq(fairOpens.launch, now)))[0] ?? null, (r) => r?.mint != null, 180_000);
    openedMint = opened!.mint as Address;
    const after = await waitFor(board, (x) => x.new.some((n) => n.mint === openedMint) && !x.liveNow.some((e) => e.launch === now), 120_000);
    expect(after.new.find((n) => n.mint === openedMint)).toMatchObject({ launchMode: "fair_open", fairOpen: now as string });
    await page.reload();
    await expect(page.getByTestId("section-new").locator(`[data-mint="${openedMint}"]`)).toBeVisible();
    await snap(page, "board-5-opened");
    expect(errors.filter((e) => !/WebSocket/.test(e))).toEqual([]);
  } finally {
    // The later Fair Open, which nobody deposited in, fails at its open and returns its creator's rent; then every wallet
    // sells what it holds and sends the rest back to the bank.
    if (laterLaunch) {
      const done = (r: { status: string } | null) => r?.status === "failed" || r?.status === "closed";
      await waitFor(async () => (await db.select().from(fairOpens).where(eq(fairOpens.launch, laterLaunch!)))[0] ?? null, done, 25 * 60_000).catch(() =>
        console.warn(`the later Fair Open ${laterLaunch} has not failed yet: sweep ${w.openLater.address} once it has`),
      );
    }
    // The Fair Open's coins are sold once its Tax window has ended and the keeper has pushed them.
    if (openedMint) await sleep(70_000);
    await sweepBoardRun(run, [...mints, ...(around ? [around.mint] : [])], openedMint).catch((e) => console.warn("sweeping failed", e));
    await close();
  }
});
