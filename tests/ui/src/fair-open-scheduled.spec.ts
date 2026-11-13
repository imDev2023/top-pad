// A full Fair Open from the site (#47's devnet demo): a creator links X, keeps Fair Open, enters the coin, schedules a
// window starting now with a teaser, and signs the schedule and the whole 64-rung ladder in one wallet approval. Two
// depositors join, one from the page and one straight to the program; then nobody does anything: at the window's close
// the keeper's Workflow (the API's, under `wrangler dev` locally, or the deployed one) uploads the coin's metadata,
// sends the rung the pot covers, pushes every seat its coins and refund, and once the Tax window ends collects the Tax
// Share, pays every seat its share as it closes, and closes the launch, its rent back to the creator (#49). The spec
// measures how late the open landed by the chain's clock and checks every seat was delivered within 2 minutes of the
// open. Every step of the launch flow is photographed in every view. About 15 minutes and 0.05 devnet SOL a run: the
// deposits' coins are sold back after the tax window.
// The sealed identity (#50): until the open the depositor's page shows a "?" tile, and nothing it receives (its source,
// its API answers, its live room's messages) names the coin's name, ticker, mint, metadata or image; at the open it
// reveals the coin, whose name, ticker and metadata URI hash to what the launch account committed at scheduling, and
// whose metadata, served through Turbo, names the same coin and the image the page shows.
import { expect, test } from "@playwright/test";
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { identityHash, Tier } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { FairOpen } from "@top-pad/contract";
import { chainTime, coinBalance, fundedWallets, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { admitted, deposit, newPerson, sellAll } from "@top-pad/tests-devnet/fair-open";
import { expectVampClear, signInOnLaunch, newTicker, pageErrors, runName, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = async (launch: string) => FairOpen.parse(await (await fetch(`${TARGET.api}/fair-opens/${launch}`)).json());
const hex = (bytes: Uint8Array | ReadonlyUint8Array) => Buffer.from(bytes).toString("hex");

/** The coin a launch revealed at its open, once the indexer has seen it. */
async function revealedCoin(launch: string) {
  for (let i = 0; i < 60; i++) {
    const coin = (await view(launch)).open?.coin;
    if (coin) return coin;
    await sleep(1_000);
  }
  throw new Error(`${launch} never revealed its coin`);
}

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

test("a creator schedules a Fair Open from the site and signs once; the keeper opens it and pushes every seat", async ({ page, browser }) => {
  test.setTimeout(20 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, depositor, other] = await fundedWallets(SOL / 10n, SOL / 5n, SOL / 2n);
  let launch: Address | null = null;
  try {
    const wallet = await installTestWallet(page, creator);
    const ticker = newTicker();
    const teaser = newTicker();
    await page.goto("/launch");
    await signInOnLaunch(page);
    await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
    await snap(page, "fair-open-scheduled-1-mode");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill(runName("E2E Heartbeat", ticker));
    await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
    await expectVampClear(page);
    await page.getByRole("button", { name: "Continue" }).click();

    // The schedule: refused teasers say why as they are typed; a later start shows when the coin opens.
    await expect(page.getByRole("heading", { name: "Schedule the window" })).toBeVisible();
    await page.getByLabel("Teaser for the calendar (optional)").fill("see heat.fun for $PEPE");
    await expect(page.getByText(/links and web addresses cannot go in it/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await page.getByRole("radio", { name: /Later/ }).check();
    await expect(page.getByLabel("Starts at, your local time")).toBeVisible();
    await page.getByLabel("Minimum raise (SOL, optional)").fill("0.25");
    await snap(page, "fair-open-scheduled-2-schedule-later");
    await page.getByRole("radio", { name: /Now/ }).check();
    await page.getByLabel("Minimum raise (SOL, optional)").fill("0.2");
    // A teaser's words are read as names and tickers against the live protected set, folded (a "10" reads as IO),
    // and ordinary words keep being refused as coins join it (#93: "one" as $ONE and "10" as IO on 2026-11-04), so the
    // teaser is one word drawn for the run, which no Protected coin has; never the coin's ticker, which the calendar
    // would show before the open.
    await page.getByLabel("Teaser for the calendar (optional)").fill(teaser);
    await expect(page.getByTestId("schedule-timeline")).toContainText("open now");
    await snap(page, "fair-open-scheduled-3-schedule-now");
    await page.getByRole("button", { name: "Continue" }).click();

    // One approval: the schedule and every rung.
    await expect(page.getByRole("heading", { name: "Sign your open in advance" })).toBeVisible();
    await page.getByText(/What you sign: the schedule and 64 versions of the open/).click();
    await expect(page.getByText("Open 64")).toBeVisible();
    await snap(page, "fair-open-scheduled-4-sign");
    await page.getByRole("button", { name: "Sign your open in advance" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
    // The sign-in message, then the schedule and every rung in one approval.
    expect(wallet.approvals).toEqual([1, 65]);
    await expect(page.getByText("Your open is signed")).toBeVisible();
    await snap(page, "fair-open-scheduled-5-done");

    await page.getByRole("link", { name: "Open its page" }).click();
    await page.waitForURL(/\/fair-open\//);
    launch = page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
    await expect(page.getByText(`\u{201C}${teaser}\u{201D}`)).toBeVisible();
    const account = (await fetchLaunch(rpc, launch)).data;
    expect(account.creator).toBe(creator.address);
    expect(account.minRaise).toBe(200_000_000n);

    // The depositors: one on the page, Unverified, and one straight to the program, Scored. Everything the depositor's
    // page receives before the open is kept, to be searched for the coin once it is revealed.
    const depositorPage = await browser.newPage();
    const seen: string[] = [];
    let sealed = true;
    depositorPage.on("response", (r) => {
      if (sealed && r.url().startsWith(TARGET.api)) void r.text().then((t) => seen.push(t), () => {});
    });
    depositorPage.on("websocket", (ws) => ws.on("framereceived", (f) => void (sealed && seen.push(String(f.payload)))));
    await installTestWallet(depositorPage, depositor);
    await depositorPage.goto(`/fair-open/${launch}`);
    await expect(depositorPage.getByTestId("fair-open-tile")).toHaveText("?");
    await expect(depositorPage.getByRole("heading", { name: "Sealed coin" })).toBeVisible();
    await connectTestWallet(depositorPage, depositorPage.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await depositorPage.getByLabel("Amount (SOL, in steps of 0.01)").fill("0.1");
    await depositorPage.getByRole("button", { name: "Deposit 0.1 SOL" }).click();
    await expect(depositorPage.getByTestId("fair-open-done")).toContainText("Deposited 0.1 SOL", { timeout: 90_000 });
    await deposit(launch, other, 30n * 10_000_000n, await admitted(launch, other.address, newPerson(), Tier.Scored));
    await expect(depositorPage.getByTestId("fair-open-phase")).toContainText("Window closes in");
    await snap(depositorPage, "fair-open-scheduled-6-window");

    // Then nobody does anything: the keeper uploads the coin's metadata 15 s before the open, opens it at its time and
    // pushes every seat. Until the open, the page's source and the API still show nothing of the coin.
    await untilChainTime(account.opensAt - 3n);
    seen.push(await (await fetch(`${TARGET.web}/fair-open/${launch}`)).text(), await (await fetch(`${TARGET.api}/fair-opens/${launch}`)).text());
    seen.push(await depositorPage.content());
    await expect(depositorPage.getByTestId("fair-open-tile")).toHaveText("?");
    sealed = false;
    await untilChainTime(account.opensAt);
    await expect(depositorPage.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 120_000 });
    await expect(depositorPage.getByTestId("fair-open-coin")).toContainText(ticker, { timeout: 60_000 });
    const opened = (await fetchLaunch(rpc, launch)).data;
    expect(opened.status).toBe(LaunchStatus.Opened);

    // The coin revealed is the one sealed: its name, ticker and metadata URI hash to the launch's identity hash, and its
    // metadata names the same coin and the image the page shows.
    const revealed = await revealedCoin(launch);
    expect(revealed).toMatchObject({ name: runName("E2E Heartbeat", ticker), ticker });
    expect(hex(await identityHash(revealed))).toBe(hex(opened.identityHash));
    const metadata = (await (await fetch(revealed.uri)).json()) as { name: string; symbol: string; image: string };
    expect(metadata).toMatchObject({ name: revealed.name, symbol: revealed.ticker, image: revealed.imageUri });
    expect((await fetch(revealed.imageUri!)).ok).toBe(true);
    await expect(depositorPage.getByTestId("fair-open-tile").locator("img")).toHaveAttribute("src", revealed.imageUri!);
    const secrets = [revealed.name, revealed.ticker, opened.mint, revealed.uri, revealed.imageUri!, revealed.uri.split("/").at(-1)!, revealed.imageUri!.split("/").at(-1)!];
    expect(seen.length).toBeGreaterThan(3);
    for (const text of seen) for (const secret of secrets) expect(text.includes(secret), `${secret} showed before the open`).toBe(false);
    console.log(`sealed until the open: ${seen.length} answers, page sources and live messages named none of the coin`);

    // How late the open landed, by the chain's clock: the creation transaction's block time against the scheduled open.
    const history = await rpc.getSignaturesForAddress(launch, { limit: 50 }).send();
    const open = history.filter((h) => !h.err && h.blockTime !== null && h.blockTime >= account.opensAt).at(-1)!;
    const landedLate = Number(open.blockTime! - account.opensAt);
    console.log(`the open ${open.signature} landed ${landedLate} s after its time (block time, whole seconds)`);
    expect(landedLate).toBeLessThanOrEqual(15);

    // Every seat has its coins and refund within 2 minutes of the open, pushed by the keeper.
    await expect(depositorPage.getByTestId("fair-open-delivered")).toContainText("Every seat has its coins and refund", { timeout: 120_000 });
    expect(Number((await chainTime()) - account.opensAt)).toBeLessThanOrEqual(120);
    for (const w of [depositor, other]) expect(await coinBalance(w.address, opened.mint)).toBeGreaterThan(0n);
    expect((await view(launch)).open?.delivered).toBe(2);
    await snap(depositorPage, "fair-open-scheduled-7-opened");

    // At 60 s the keeper collects the Tax Share and pays it, every seat closing, and closes the launch.
    await expect(depositorPage.getByTestId("fair-open-tax-share")).toContainText("Every depositor has been paid theirs", { timeout: 240_000 });
    await expect(depositorPage.getByTestId("fair-open-your-tax-share")).toContainText("SOL");
    await expect.poll(async () => (await rpc.getBalance(launch!, { commitment: "confirmed" }).send()).value, { timeout: 120_000 }).toBe(0n);
    await snap(depositorPage, "fair-open-scheduled-8-tax-share");

    // The keeper closes the nonce, its rent back to the creator.
    await expect.poll(async () => (await rpc.getBalance(account.nonce, { commitment: "confirmed" }).send()).value, { timeout: 120_000 }).toBe(0n);
    expect(errors).toEqual([]);
  } finally {
    if (launch) {
      // The coin, once opened, outlives its launch account, which the keeper closes when it is done.
      const row = await view(launch).catch(() => null);
      if (row?.open) {
        // Sold back once the tax window is over, the pot's coins return most of what they cost.
        await untilChainTime(BigInt(Math.floor(Date.parse(row.opensAt) / 1000)) + 75n);
        for (const w of [depositor, other]) await sellAll(w, row.open.mint as Address);
      }
    }
    await sweep(creator, depositor, other);
  }
});
