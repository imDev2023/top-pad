// The fallback for a wallet that cannot sign a batch (ADR 0005, #47): the creator's wallet refuses the 65-transaction
// request, the launch flow offers the schedule alone, and the Fair Open is scheduled with its open to be signed at the
// open. A depositor joins; when the window closes, the creator's page asks for one signature, the rung the pot covers,
// which our keeper co-signs and sends; then the keeper pushes the seat. About 13 minutes and 0.03 devnet SOL a run.
import { expect, test } from "@playwright/test";
import type { Address } from "@solana/kit";
import { Tier } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { chainTime, coinBalance, fundedWallets, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { admitted, deposit, newPerson, sellAll } from "@top-pad/tests-devnet/fair-open";
import { coinImage, newHandle, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

test("a creator whose wallet cannot sign a batch schedules a Fair Open and signs its open at the open", async ({ page }) => {
  test.setTimeout(18 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, other] = await fundedWallets(SOL / 10n, SOL / 2n);
  let launch: Address | null = null;
  try {
    const wallet = await installTestWallet(page, creator, { maxBatch: 1 });
    const ticker = newTicker();
    await page.goto("/launch");
    await page.getByRole("link", { name: "Link X" }).click();
    await page.getByLabel("Handle").fill(newHandle());
    await page.getByRole("button", { name: "Authorize app" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill("E2E Late Signer");
    await page.locator('input[type="file"]').setInputFiles(coinImage);
    await expect(page.getByText("No protected coin matches this ticker or name.")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await page.getByRole("button", { name: "Sign your open in advance" }).click();
    await expect(page.getByText("Your wallet could not sign 65 transactions at once")).toBeVisible({ timeout: 60_000 });
    await snap(page, "fair-open-sign-at-open-1-batch-refused");
    await page.getByRole("button", { name: "Sign the schedule only, and the open at its time" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
    await expect(page.getByText(/Come back at .* to sign your open/)).toBeVisible();
    expect(wallet.approvals).toEqual([1]);
    await snap(page, "fair-open-sign-at-open-2-done");

    await page.getByRole("link", { name: "Open its page" }).click();
    await page.waitForURL(/\/fair-open\//);
    launch = page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }).first());
    await expect(page.getByTestId("sign-open")).toContainText("You chose to sign your open at the open");
    await snap(page, "fair-open-sign-at-open-3-waiting");
    await deposit(launch, other, 30n * 10_000_000n, await admitted(launch, other.address, newPerson(), Tier.Scored));

    // At the window's close the page asks the creator's wallet for the one rung the pot covers.
    const account = (await fetchLaunch(rpc, launch)).data;
    await untilChainTime(account.opensAt);
    await expect(page.getByRole("button", { name: "Sign your open" })).toBeVisible({ timeout: 60_000 });
    await snap(page, "fair-open-sign-at-open-4-due");
    await page.getByRole("button", { name: "Sign your open" }).click();
    await expect(page.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 120_000 });
    expect(wallet.approvals).toEqual([1, 1]);
    expect((await fetchLaunch(rpc, launch)).data.status).toBe(LaunchStatus.Opened);

    // The keeper pushes the seat.
    await expect(page.getByTestId("fair-open-delivered")).toContainText("Every seat has its coins and refund", { timeout: 120_000 });
    expect(await coinBalance(other.address, (await fetchLaunch(rpc, launch)).data.mint)).toBeGreaterThan(0n);
    await snap(page, "fair-open-sign-at-open-5-opened");
    expect(errors).toEqual([]);
  } finally {
    if (launch) {
      const account = await fetchLaunch(rpc, launch).catch(() => null);
      if (account?.data.status === LaunchStatus.Opened) {
        await untilChainTime(account.data.opensAt + 75n);
        await sellAll(other, account.data.mint);
      }
    }
    await sweep(creator, other);
  }
});
