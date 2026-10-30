// A Fair Open's window and its failure path end to end (#45's devnet demo): a launch scheduled by script takes deposits
// and withdrawals from its page, an Unverified wallet becomes Scored by linking X, a second wallet of the same person is
// refused, and another depositor's deposit shows on the page as it lands. The launch never opens: by default its pot
// misses its minimum raise and fails as the window closes; with E2E_LATE=1 it has none and fails 15 minutes after its
// open, the ticket's demo, which takes about 20 minutes. The depositor marks it failed from the page and takes back their
// deposit and both rents in the same transaction; the other depositor takes theirs back on chain with no Heat server.
// Every step is photographed in every view. Real devnet SOL: deposits and rents come back, fees about 0.001 a run.
import { expect, test, type Page } from "@playwright/test";
import type { Address } from "@solana/kit";
import { Tier } from "@top-pad/chain";
import { fetchLaunch } from "@top-pad/clients/fair-open";
import { FairOpen } from "@top-pad/contract";
import { bank, chainTime, fundedWallets, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { admitted, deposit, newPerson, recoverDeposits, refund, scheduleFairOpen, seatOf, type ScheduledFairOpen } from "@top-pad/tests-devnet/fair-open";
import { newHandle, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const LATE = process.env.E2E_LATE === "1";
const SOL = 1_000_000_000n;
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
const view = async (launch: string, wallet?: string) =>
  FairOpen.parse(await (await fetch(`${TARGET.api}/fair-opens/${launch}${wallet ? `?wallet=${wallet}` : ""}`)).json());
/** One signature's network fee; a deposit pays two, its admission's precompile counting like a transaction's own. */
const SIGNATURE_FEE = 5_000n;

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await new Promise((r) => setTimeout(r, Math.min(Number(at - now) * 1_000, 30_000) + 1_000));
  }
}

/** Deposits or withdraws `amount` (SOL, as typed) from the page, and waits for the page to say it landed. */
async function move(page: Page, mode: "Deposit" | "Withdraw", amount: string, done: RegExp) {
  await page.getByRole("radio", { name: mode }).click();
  await page.getByLabel("Amount (SOL, in steps of 0.01)").fill(amount);
  await page.getByRole("button", { name: `${mode} ${amount} SOL` }).click();
  await expect(page.getByTestId("fair-open-done")).toContainText(done, { timeout: 90_000 });
}

test("a Fair Open takes deposits and withdrawals from its page, then fails and returns every deposit and both rents", async ({ page, browser }) => {
  test.setTimeout((LATE ? 30 : 12) * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [depositor, secondWallet, other] = await fundedWallets(SOL / 2n, SOL / 50n, SOL / 5n);
  let scheduled: ScheduledFairOpen | null = null;
  try {
    // The window has been open a while and closes in four minutes, giving the page its steps; the default pot's minimum
    // raise of 1 SOL is more than it will hold.
    const launch = (scheduled = await scheduleFairOpen(await bank(), (await chainTime()) + 240n - 600n, LATE ? 0n : SOL));
    const before = await lamports(depositor.address);
    await expect.poll(async () => (await fetch(`${TARGET.api}/fair-opens/${launch.launch}`)).status, { timeout: 30_000 }).toBe(200);

    await installTestWallet(page, depositor);
    await page.goto(`/fair-open/${launch.launch}`);
    await expect(page.getByRole("heading", { name: "Sealed coin" })).toBeVisible();
    await expect(page.getByTestId("fair-open-phase")).toContainText("Window closes in");
    await snap(page, "fair-open-1-window");

    // An Unverified wallet: up to 0.1 SOL. A deposit takes its seat, a second adds to it, a withdrawal takes some back.
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await expect(page.getByTestId("fair-open-tier")).toHaveText("Unverified · cap 0.1 SOL");
    await snap(page, "fair-open-2-connected");
    await move(page, "Deposit", "0.05", /Deposited 0\.05 SOL/);
    await expect(page.getByTestId("fair-open-held")).toHaveText("0.05 SOL");
    await expect(page.getByTestId("fair-open-pot")).toHaveText("0.05");
    await move(page, "Deposit", "0.03", /Deposited 0\.03 SOL/);
    await move(page, "Withdraw", "0.02", /Took back 0\.02 SOL/);
    await expect(page.getByTestId("fair-open-held")).toHaveText("0.06 SOL");
    await snap(page, "fair-open-3-unverified-seat");

    // Linking X makes the person Scored, up to 0.5 SOL, in the same seat.
    await page.getByRole("link", { name: "Link X" }).click();
    const handle = newHandle();
    await page.getByLabel("Handle").fill(handle);
    await page.getByRole("button", { name: "Authorize app" }).click();
    await expect(page.getByTestId("fair-open-tier")).toHaveText("Scored · cap 0.5 SOL", { timeout: 30_000 });
    await move(page, "Deposit", "0.3", /Deposited 0\.3 SOL/);
    await expect(page.getByTestId("fair-open-held")).toHaveText("0.36 SOL");

    // Another depositor deposits straight to the program; the page shows the pot grow as it lands.
    await deposit(launch.launch, other, 10n * 10_000_000n, await admitted(launch.launch, other.address, newPerson(), Tier.Verified));
    await expect(page.getByTestId("fair-open-pot")).toHaveText("0.46", { timeout: 30_000 });
    await snap(page, "fair-open-4-scored-seat");

    // The same person through a second wallet is refused: one person, one seat, one wallet.
    const second = await browser.newPage();
    await second.context().addCookies(await page.context().cookies());
    await installTestWallet(second, secondWallet);
    await second.goto(`/fair-open/${launch.launch}`);
    await connectTestWallet(second, second.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await expect(second.getByRole("main").getByRole("alert")).toContainText("one person, one seat, one wallet");
    await snap(second, "fair-open-5-second-wallet-refused");
    await second.close();

    // The window closes, and the launch never opens: at once when the pot misses its minimum raise, otherwise 15
    // minutes after its open. Anyone may then mark it failed; the depositor does, from the page.
    const { data } = await fetchLaunch(rpc, launch.launch);
    if (LATE) {
      // With no minimum raise to miss, the open falls due as the window closes, and the deposits are locked until it
      // runs or is late; nothing runs it before #46.
      await untilChainTime(data.opensAt);
      await expect(page.getByTestId("fair-open-phase")).toContainText("The open is due", { timeout: 60_000 });
      await expect(page.getByText("Your deposit is locked until the open.")).toBeVisible();
      await expect(page.getByText(/^The window closed at \d\d:\d\d:\d\d UTC\.$/)).toBeVisible();
      await expect(page.getByRole("radio", { name: "Deposit" })).toHaveCount(0);
      await snap(page, "fair-open-6-due");
    }
    await untilChainTime(data.opensAt + (LATE ? 900n : 0n));
    await expect(page.getByTestId("fair-open-phase")).toContainText("This Fair Open cannot open", { timeout: 60_000 });
    await snap(page, "fair-open-7-failing");
    await page.getByRole("button", { name: "Mark it failed and take back my SOL" }).click();
    await expect(page.getByTestId("fair-open-done")).toContainText("Marked failed, and your deposit and both rents are back", { timeout: 90_000 });
    await expect(page.getByTestId("fair-open-phase")).toContainText("This Fair Open failed");
    await snap(page, "fair-open-8-failed");
    expect((await view(launch.launch)).failure).toBe(LATE ? "late" : "min_raise_missed");

    // Everything the depositor put in came back: only the network fees are gone (four deposits and withdrawals, the
    // deposits at two signatures each, and the failure with the refund).
    expect(before - (await lamports(depositor.address))).toBe((2n + 2n + 1n + 2n + 1n) * SIGNATURE_FEE);
    expect(await seatOf(launch.launch, depositor.address)).toBeNull();

    // The other depositor takes theirs back on chain alone, with no Heat server: the refund is built from the chain.
    const otherBefore = await lamports(other.address);
    const seat = (await seatOf(launch.launch, other.address))!;
    await refund(launch.launch, other);
    expect((await lamports(other.address)) - otherBefore).toBe(seat.seat.deposit + seat.seat.coinRent + seat.lamports - SIGNATURE_FEE);
    expect(errors).toEqual([]);
  } finally {
    // A run that stopped partway leaves deposits in the launch, which only come back once it fails.
    if (scheduled) await recoverDeposits(scheduled.launch, other, [depositor, other]);
    await sweep(depositor, secondWallet, other);
  }
});
