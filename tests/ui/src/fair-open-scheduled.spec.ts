// A full Fair Open from the site (#47's devnet demo): a creator links X, keeps Fair Open, enters the coin, schedules a
// window starting now with a teaser, and signs the schedule and the whole 64-rung ladder in one wallet approval. Two
// depositors join, one from the page and one straight to the program; then nobody does anything: at the window's close
// the keeper's Workflow (the API's, under `wrangler dev` locally, or the deployed one) uploads the coin's metadata,
// sends the rung the pot covers, and pushes every seat its coins and refund. The spec measures how late the open landed
// by the chain's clock and checks every seat was delivered within 2 minutes of the open. Every step of the launch flow
// is photographed in every view. About 14 minutes and 0.05 devnet SOL a run: the deposits' coins are sold back after
// the tax window; the creator's launch account keeps its rent until the Tax Share closes it (#49).
import { expect, test } from "@playwright/test";
import type { Address } from "@solana/kit";
import { Tier } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { FairOpen } from "@top-pad/contract";
import { chainTime, coinBalance, fundedWallets, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { admitted, deposit, newPerson, sellAll } from "@top-pad/tests-devnet/fair-open";
import { coinImage, newHandle, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = async (launch: string) => FairOpen.parse(await (await fetch(`${TARGET.api}/fair-opens/${launch}`)).json());

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
    await page.goto("/launch");
    await page.getByRole("link", { name: "Link X" }).click();
    await page.getByLabel("Handle").fill(newHandle());
    await page.getByRole("button", { name: "Authorize app" }).click();
    await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
    await snap(page, "fair-open-scheduled-1-mode");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill("E2E Heartbeat");
    await page.locator('input[type="file"]').setInputFiles(coinImage);
    await expect(page.getByText("No protected coin matches this ticker or name.")).toBeVisible();
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
    await page.getByLabel("Teaser for the calendar (optional)").fill("Ten minutes, one price, no snipers");
    await expect(page.getByTestId("schedule-timeline")).toContainText("open now");
    await snap(page, "fair-open-scheduled-3-schedule-now");
    await page.getByRole("button", { name: "Continue" }).click();

    // One approval: the schedule and every rung.
    await expect(page.getByRole("heading", { name: "Sign your open in advance" })).toBeVisible();
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await page.getByText(/What you sign: the schedule and 64 versions of the open/).click();
    await expect(page.getByText("Open 64")).toBeVisible();
    await snap(page, "fair-open-scheduled-4-sign");
    await page.getByRole("button", { name: "Sign your open in advance" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
    expect(wallet.approvals).toEqual([65]);
    await expect(page.getByText("Your open is signed")).toBeVisible();
    await snap(page, "fair-open-scheduled-5-done");

    await page.getByRole("link", { name: "Open its page" }).click();
    await page.waitForURL(/\/fair-open\//);
    launch = page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
    await expect(page.getByText("“Ten minutes, one price, no snipers”")).toBeVisible();
    const account = (await fetchLaunch(rpc, launch)).data;
    expect(account.creator).toBe(creator.address);
    expect(account.minRaise).toBe(200_000_000n);

    // The depositors: one on the page, Unverified, and one straight to the program, Scored.
    const depositorPage = await browser.newPage();
    await installTestWallet(depositorPage, depositor);
    await depositorPage.goto(`/fair-open/${launch}`);
    await connectTestWallet(depositorPage, depositorPage.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await depositorPage.getByLabel("Amount (SOL, in steps of 0.01)").fill("0.1");
    await depositorPage.getByRole("button", { name: "Deposit 0.1 SOL" }).click();
    await expect(depositorPage.getByTestId("fair-open-done")).toContainText("Deposited 0.1 SOL", { timeout: 90_000 });
    await deposit(launch, other, 30n * 10_000_000n, await admitted(launch, other.address, newPerson(), Tier.Scored));
    await expect(depositorPage.getByTestId("fair-open-phase")).toContainText("Window closes in");
    await snap(depositorPage, "fair-open-scheduled-6-window");

    // Then nobody does anything: the keeper opens it at its time and pushes every seat.
    await untilChainTime(account.opensAt);
    await expect(depositorPage.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 120_000 });
    await expect(depositorPage.getByTestId("fair-open-coin")).toContainText(ticker, { timeout: 60_000 });
    const opened = (await fetchLaunch(rpc, launch)).data;
    expect(opened.status).toBe(LaunchStatus.Opened);

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

    // The keeper closes the nonce, its rent back to the creator.
    await expect.poll(async () => (await rpc.getBalance(account.nonce, { commitment: "confirmed" }).send()).value, { timeout: 120_000 }).toBe(0n);
    expect(errors).toEqual([]);
  } finally {
    if (launch) {
      const account = await fetchLaunch(rpc, launch).catch(() => null);
      if (account?.data.status === LaunchStatus.Opened) {
        // Sold back once the tax window is over, the pot's coins return most of what they cost.
        await untilChainTime(account.data.opensAt + 75n);
        for (const w of [depositor, other]) await sellAll(w, account.data.mint);
      }
    }
    await sweep(creator, depositor, other);
  }
});
