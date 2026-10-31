// A Fair Open's open seen from its page (#46's demo, end to end): a launch scheduled by script, its ladder signed as its
// creator would sign it at scheduling, takes a deposit from its page and another straight to the program; at its time
// the rung the pot covers is sent as our keeper's Workflow will send it (#47), and the page reveals the coin, what the pot
// bought and at what price. The depositor on the page claims their coins and refund from it before any push; the other
// seat is pushed, and the page counts every seat delivered. The coin's own page shows the coin. Every step is
// photographed in every view. Real devnet SOL: about 0.05 a run, the pot's coins sold back once the tax window ends.
import { expect, test } from "@playwright/test";
import type { Address } from "@solana/kit";
import { allocate, rungAtOrBelow, Tier } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { bank, chainTime, coinBalance, fundedWallets, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import {
  admitted,
  closeNonce,
  deposit,
  newPerson,
  pushAll,
  recoverDeposits,
  scheduleFairOpen,
  seatOf,
  sellAll,
  signedLadder,
  type ScheduledFairOpen,
} from "@top-pad/tests-devnet/fair-open";
import { pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** SOL as the page writes it: as many places as the amount needs, at most `max`. */
const sol = (lamports: bigint, max: number) => (Number(lamports) / 1e9).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: max });

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

test("a Fair Open opens: the page reveals its coin and what the pot bought, and a depositor claims their coins from it", async ({ page }) => {
  test.setTimeout(14 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [depositor, other] = await fundedWallets(SOL / 5n, SOL / 2n);
  let scheduled: ScheduledFairOpen | null = null;
  try {
    // A window closing in three minutes, time for both deposits and the ladder.
    const launch = (scheduled = await scheduleFairOpen(await bank(), (await chainTime()) + 180n - 600n));
    await expect.poll(async () => (await fetch(`${TARGET.api}/fair-opens/${launch.launch}`)).status, { timeout: 30_000 }).toBe(200);
    const { ladder } = await signedLadder(launch);

    // The page's depositor puts in 0.1 SOL, Unverified; the other 0.4 SOL, Scored, straight to the program.
    await installTestWallet(page, depositor);
    await page.goto(`/fair-open/${launch.launch}`);
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await page.getByLabel("Amount (SOL, in steps of 0.01)").fill("0.1");
    await page.getByRole("button", { name: "Deposit 0.1 SOL" }).click();
    await expect(page.getByTestId("fair-open-done")).toContainText("Deposited 0.1 SOL", { timeout: 90_000 });
    await deposit(launch.launch, other, 40n * 10_000_000n, await admitted(launch.launch, other.address, newPerson(), Tier.Scored));

    // At its time, the rung the pot covers.
    const account = (await fetchLaunch(rpc, launch.launch)).data;
    const { spend } = allocate(account.counts, account.unverifiedCounts, account.step, account.potCap);
    const rung = rungAtOrBelow(account.potCap, spend)!;
    await untilChainTime(account.opensAt);
    await rpc.sendTransaction(ladder.find((r) => r.rung === rung)!.transaction as never, { encoding: "base64" }).send();

    // The page reveals the coin and what the pot bought.
    await expect(page.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 90_000 });
    await expect(page.getByTestId("fair-open-coin")).toContainText(launch.coin.ticker, { timeout: 60_000 });
    await expect(page.getByTestId("fair-open-spent")).toHaveText(sol(rung, 4));
    await expect(page.getByRole("button", { name: "Claim my coins and refund" })).toBeVisible();
    await snap(page, "fair-open-opens-1-opened");

    // The depositor claims from the page before any push.
    await page.getByRole("button", { name: "Claim my coins and refund" }).click();
    await expect(page.getByTestId("fair-open-done")).toContainText("Your coins and refund are in your wallet", { timeout: 90_000 });
    const mint = (await fetchLaunch(rpc, launch.launch)).data.mint as Address;
    expect(await coinBalance(depositor.address, mint)).toBeGreaterThan(0n);
    await expect(page.getByTestId("fair-open-coins")).toBeVisible();
    await snap(page, "fair-open-opens-2-claimed");

    // The other seat is pushed, as our keeper pushes.
    await pushAll(launch.launch, mint, [{ seat: (await seatOf(launch.launch, other.address))!.address, wallet: other.address }]);
    await expect(page.getByTestId("fair-open-delivered")).toContainText("Every seat has its coins and refund", { timeout: 60_000 });
    await snap(page, "fair-open-opens-3-delivered");

    // The coin's own page.
    await page.goto(`/coin/${mint}`);
    await expect(page.getByRole("main")).toContainText(launch.coin.ticker, { timeout: 30_000 });
    await snap(page, "fair-open-opens-4-coin");
    expect(errors).toEqual([]);
  } finally {
    if (scheduled) {
      const account = await fetchLaunch(rpc, scheduled.launch).catch(() => null);
      if (account?.data.status === LaunchStatus.Opened) {
        // Sold back once the tax window is over, the pot's coins return most of what they cost.
        await untilChainTime(account.data.opensAt + 75n);
        for (const w of [depositor, other]) await sellAll(w, account.data.mint);
        await closeNonce(scheduled.nonce, scheduled.creator.address);
      } else {
        await recoverDeposits(scheduled.launch, other, [depositor, other]);
      }
    }
    await sweep(depositor, other);
  }
});
