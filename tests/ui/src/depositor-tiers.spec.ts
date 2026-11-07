// Depositor tiers end to end (#48's devnet demo): a Fair Open scheduled by script, its creator a fresh wallet. A depositor
// links X and verifies their wallet once by signing a message, and deposits up to 0.5 SOL; an Unverified wallet up to
// 0.1. Five wallets funded from one source, two directly and three through one, two and three hop wallets, are one
// person to the linkage pipeline: the first takes the seat, and the other four are refused with the reason. A wallet the
// Creator wallet funded is refused, sees why, and buys the coin from its page once it has opened. The Unverified seats'
// fills stay within a quarter of what the pot spends. "Verify once" is photographed in every view (phone and desktop,
// both themes). Real devnet SOL: about 0.05 a run, the pot's coins sold back once the tax window ends.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { getTransferSolInstruction } from "@solana-program/system";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { allocate, rungAtOrBelow, Tier } from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { FairOpen } from "@top-pad/contract";
import { chainTime, coinBalance, fundedWallets, rpc, send, sweep } from "@top-pad/tests-devnet/devnet";
import { closeNonce, pushAll, recoverDeposits, scheduleFairOpen, seatOf, seatsOf, sellAll, settleOpened, signedLadder, type ScheduledFairOpen } from "@top-pad/tests-devnet/fair-open";
import { newHandle, pageErrors, short, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const FEE = 5_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = async (launch: string, wallet: string) => FairOpen.parse(await (await fetch(`${TARGET.api}/fair-opens/${launch}?wallet=${wallet}`)).json());

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

/** Sends `to` its SOL from `from` through `hops` fresh single-use wallets, each passing on all it got but its fee. */
async function through(from: KeyPairSigner, to: Address, lamports: bigint, hops: number): Promise<KeyPairSigner[]> {
  const wallets = await Promise.all(Array.from({ length: hops }, () => generateKeyPairSigner()));
  let at = from;
  for (const [i, hop] of wallets.entries()) {
    await send(at, [getTransferSolInstruction({ source: at, destination: hop.address, amount: lamports + BigInt(hops - i) * FEE })]);
    at = hop;
  }
  await send(at, [getTransferSolInstruction({ source: at, destination: to, amount: lamports })]);
  return wallets;
}

/** A page of its own with `wallet` installed and connected on the Fair Open's page. */
async function connected(browser: Browser, launch: Address, wallet: KeyPairSigner): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  await installTestWallet(page, wallet);
  await page.goto(`/fair-open/${launch}`);
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  return page;
}

/** Deposits `amount` (SOL, as typed) from the page, and waits for the page to say it landed. */
async function depositFrom(page: Page, amount: string) {
  await page.getByLabel("Amount (SOL, in steps of 0.01)").fill(amount);
  await page.getByRole("button", { name: `Deposit ${amount} SOL` }).click();
  await expect(page.getByTestId("fair-open-done")).toContainText(`Deposited ${amount}`, { timeout: 90_000 });
}

test("depositors verify once, a person's wallets share one seat, and the creator's cluster cannot deposit", async ({ page, browser }) => {
  test.setTimeout(16 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, xUser, plain, source] = await fundedWallets(SOL / 5n, (SOL * 56n) / 100n, (SOL * 15n) / 100n, (SOL * 75n) / 100n);
  const five = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
  const creatorFunded = await generateKeyPairSigner();
  const hops: KeyPairSigner[] = [];
  let scheduled: ScheduledFairOpen | null = null;
  let mint: Address | null = null;
  try {
    // Where every wallet's SOL comes from: the five from one source, two directly and three through hop wallets; the
    // last from the Creator wallet. The bank funded the rest, and as a hub ties nobody together.
    for (const w of five.slice(0, 2)) await send(source, [getTransferSolInstruction({ source, destination: w.address, amount: (SOL * 12n) / 100n })]);
    for (const [i, w] of five.slice(2).entries()) hops.push(...(await through(source, w.address, (SOL * 12n) / 100n, i + 1)));
    await send(creator, [getTransferSolInstruction({ source: creator, destination: creatorFunded.address, amount: SOL / 20n })]);

    // A window open for five more minutes; the creator signs the open's ladder, as at scheduling.
    const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + 300n - 600n));
    await expect.poll(async () => (await fetch(`${TARGET.api}/fair-opens/${launch.launch}`)).status, { timeout: 30_000 }).toBe(200);
    const { ladder } = await signedLadder(launch);

    // A depositor with no proof is Unverified, up to 0.1 SOL; linking X and signing once with the wallet makes them
    // Scored, up to 0.5 SOL, in every Fair Open.
    await installTestWallet(page, xUser);
    await page.goto(`/fair-open/${launch.launch}`);
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await expect(page.getByTestId("fair-open-tier")).toHaveText("Unverified · cap 0.1 SOL", { timeout: 60_000 });
    await expect(page.getByTestId("fair-open-verify")).toContainText("Verify once");
    await snap(page, "tiers-1-verify-once");
    await page.getByTestId("fair-open-verify").getByRole("link", { name: "Link X" }).click();
    const handle = newHandle();
    await page.getByLabel("Handle").fill(handle);
    await page.getByRole("button", { name: "Authorize app" }).click();
    const verify = page.getByRole("button", { name: `Verify this wallet as @${handle}` });
    await expect(verify).toBeVisible({ timeout: 30_000 });
    await snap(page, "tiers-2-sign-once");
    await verify.click();
    await expect(page.getByTestId("fair-open-tier")).toHaveText("Scored · cap 0.5 SOL", { timeout: 30_000 });
    await expect(page.getByTestId("fair-open-verified")).toHaveText(`Verified once for @${handle}.`);
    await depositFrom(page, "0.5");
    await expect(page.getByTestId("fair-open-held")).toHaveText("0.5 SOL");
    await snap(page, "tiers-3-scored-deposit");
    // Signed out, in a browser of its own, the wallet is still Scored: it was verified once.
    expect((await view(launch.launch, xUser.address)).you!.admission).toMatchObject({ admitted: true, tier: "scored", via: "x", handle });

    // Anyone else deposits up to 0.1 SOL.
    const plainPage = await connected(browser, launch.launch, plain);
    await expect(plainPage.getByTestId("fair-open-tier")).toHaveText("Unverified · cap 0.1 SOL", { timeout: 60_000 });
    await plainPage.getByLabel("Amount (SOL, in steps of 0.01)").fill("0.2");
    await expect(plainPage.getByText("You can add at most 0.1 SOL.")).toBeVisible();
    await depositFrom(plainPage, "0.1");
    await plainPage.close();

    // The five wallets are one person: the first is told so, and takes the seat.
    const firstPage = await connected(browser, launch.launch, five[0]!);
    await expect(firstPage.getByTestId("fair-open-linked")).toHaveText(
      `Heat counts this wallet as one person with every wallet funded from it: its SOL came from ${short(source.address)}, directly. They share one seat in each Fair Open.`,
      { timeout: 60_000 },
    );
    await depositFrom(firstPage, "0.1");
    await snap(firstPage, "tiers-4-linked-seat");
    await firstPage.close();
    // The other four, through 0 to 3 hop wallets, are refused with why, and can still buy after the open.
    for (const [i, w] of five.slice(1).entries()) {
      const admission = (await view(launch.launch, w.address)).you!.admission;
      const route = i === 0 ? "directly" : `through ${i} pass-through ${i === 1 ? "wallet" : "wallets"} in between`;
      expect(admission).toEqual({
        admitted: false,
        reason:
          `Heat counts this wallet as one person with ${short(five[0]!.address)}: both got their SOL from ${short(source.address)}, this wallet ${route}. ` +
          `${short(five[0]!.address)} holds this Fair Open's seat: one person, one seat, one wallet. You can still buy the coin once it opens.`,
      });
    }
    const lastPage = await connected(browser, launch.launch, five[4]!);
    await expect(lastPage.getByTestId("fair-open-refused")).toContainText("through 3 pass-through wallets in between", { timeout: 60_000 });
    await snap(lastPage, "tiers-5-merged-refused");
    await lastPage.close();

    // A wallet the Creator wallet funded is refused, and sees why.
    const fundedPage = await connected(browser, launch.launch, creatorFunded);
    const creatorReason =
      "The Creator wallet funded this wallet, directly. Wallets tied to the creator cannot deposit in their Fair Open. You can still buy the coin once it opens.";
    await expect(fundedPage.getByTestId("fair-open-refused")).toContainText(creatorReason, { timeout: 60_000 });
    await expect(fundedPage.getByRole("radio", { name: "Deposit" })).toHaveCount(0);
    await snap(fundedPage, "tiers-6-creator-funded-refused");
    const refused = await fetch(`${TARGET.api}/fair-opens/${launch.launch}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TARGET.web },
      body: JSON.stringify({ wallet: creatorFunded.address, amount: `${SOL / 100n}` }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: creatorReason, code: "not_admitted" });

    // One seat among the five, and the Unverified asks over a quarter: the pot meter's line binds them.
    const seats = await seatsOf(launch.launch);
    expect(seats.filter((s) => five.some((w) => w.address === s.seat.wallet)).map((s) => s.seat.wallet)).toEqual([five[0]!.address]);
    const account = (await fetchLaunch(rpc, launch.launch)).data;
    const a = allocate(account.counts, account.unverifiedCounts, account.step, account.potCap);
    expect(a.unverified.limited).toBe(true);
    expect(4n * a.unverified.filled).toBeLessThanOrEqual(a.spend);
    await page.reload();
    await expect(page.getByTestId("fair-open-pot")).toHaveText("0.7", { timeout: 30_000 });
    await snap(page, "tiers-7-pot");

    // The open, on the rung the pot covers, as our keeper sends it.
    const rung = rungAtOrBelow(account.potCap, a.spend)!;
    await untilChainTime(account.opensAt);
    await rpc.sendTransaction(ladder.find((r) => r.rung === rung)!.transaction as never, { encoding: "base64" }).send();
    await expect(page.getByTestId("fair-open-phase")).toContainText("The coin is live", { timeout: 90_000 });
    mint = (await fetchLaunch(rpc, launch.launch)).data.mint as Address;
    const depositors = [xUser, plain, five[0]!];
    await pushAll(
      launch.launch,
      mint,
      await Promise.all(depositors.map(async (w) => ({ seat: (await seatOf(launch.launch, w.address))!.address, wallet: w.address }))),
    );
    // What the Unverified seats spent, as delivered: a quarter of what the pot spent. Their fills are within a quarter to
    // the lamport (above); each seat's spend is its fill scaled to the rung and rounded up (spec 2.1 step 11, owner's
    // rounding), so the delivered total may pass the quarter by at most a lamport a seat: on 2026-11-07, by a quarter of one.
    const delivered = (await seatsOf(launch.launch)).filter((s) => s.seat.tier === Tier.Unverified);
    const unverifiedSpent = delivered.reduce((sum, s) => sum + s.seat.spent, 0n);
    const spent = (await fetchLaunch(rpc, launch.launch)).data.spent;
    expect(delivered).toHaveLength(2);
    expect(4n * unverifiedSpent).toBeLessThanOrEqual(spent + 4n * BigInt(delivered.length));

    // Once the Tax window is over and the Tax Share paid, the refused wallet buys the coin from its page.
    await settleOpened(launch.launch);
    await fundedPage.goto(`/coin/${mint}`);
    const panel = fundedPage.getByRole("region", { name: "Quick trade" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // The wallet stays connected across pages; connect it again only if the page asks.
    const connect = fundedPage.getByRole("banner").getByRole("button", { name: "Connect wallet" });
    await sleep(2_000);
    if (await connect.isVisible()) await connectTestWallet(fundedPage, connect);
    await panel.getByRole("radio", { name: "Buy", exact: true }).click();
    await panel.getByLabel("Spend", { exact: true }).fill("0.01");
    await panel.getByRole("button", { name: /^Buy / }).click();
    await expect(panel.getByTestId("quick-trade-done")).toBeVisible({ timeout: 90_000 });
    expect(await coinBalance(creatorFunded.address, mint)).toBeGreaterThan(0n);
    await snap(fundedPage, "tiers-8-creator-funded-buys");
    await fundedPage.close();
    expect(errors).toEqual([]);
  } finally {
    const everyone = [creator, xUser, plain, source, ...five, creatorFunded, ...hops];
    if (scheduled) {
      const account = await fetchLaunch(rpc, scheduled.launch).catch(() => null);
      if (mint || account?.data.status === LaunchStatus.Opened) {
        mint ??= account!.data.mint as Address;
        if (account) {
          const found = await Promise.all([xUser, plain, five[0]!].map(async (w) => ({ found: await seatOf(scheduled!.launch, w.address), wallet: w.address })));
          await pushAll(scheduled.launch, mint, found.filter((x) => x.found && !x.found.seat.delivered).map((x) => ({ seat: x.found!.address, wallet: x.wallet })));
          await settleOpened(scheduled.launch).catch((e) => console.error("settling the launch failed", e));
        }
        for (const w of [xUser, plain, five[0]!, creatorFunded]) await sellAll(w, mint).catch((e) => console.error("selling back failed", e));
        await closeNonce(scheduled.nonce, scheduled.creator.address);
      } else {
        await recoverDeposits(scheduled.launch, xUser, [xUser, plain, five[0]!]);
      }
    }
    await sweep(...everyone);
  }
});
