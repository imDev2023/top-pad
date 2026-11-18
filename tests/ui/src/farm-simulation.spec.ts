// The farm simulation (spec 11.1, #60), repeatable: 100 wallets funded from one source and 20 honest wallets against one
// Fair Open, which a creator schedules from the site, signing the schedule and the whole ladder in one approval, so the
// keeper's Workflow (the deployed one with `e2e:devnet`) opens it and pushes every seat. Every deposit goes through the
// API the Fair Open page uses, so admission runs as it does for anyone: the linkage pipeline, the creator's cluster, one
// seat a person. Of the honest wallets, 12 link X on the stand-in and verify once (Scored) and 8 stay Unverified; the
// farm is one Unverified person; 4 wallets the Creator wallet funded, one through a pass-through wallet, try too.
//
// It passes when the farm's wallets get one seat between them (the first two are admitted before either deposits, the
// way a farm would race, and the second's deposit is refused on chain, as a second wallet of a seated person; the other
// 98 are refused by admission with why); every wallet tied to the creator's cluster is refused; the Unverified fills stay
// at or under a quarter of what the pot spends; the levels the program worked out at the open match, to the lamport, the
// reference calculation in `@top-pad/chain` and what the API showed the page before the open; and every seat has its
// coins and refund, as the reference says, within 2 minutes of the open. The operator queue keeps every merge and
// refusal (`admission_reviews`, read from the devnet database, so run it with `direnv exec`).
//
// Real devnet SOL: about 3.5 lent for the run (deposits and the farm's funding), about 0.1 spent (rent kept by the
// pool, 1.25% each way on the pot's coins, which every seat sells back once the Tax window ends, and fees). About 20
// minutes, alone with `e2e:devnet` (`farm-simulation.spec.ts`). Its wallets derive from the bank's key and the run's
// name, which it logs, so a run stopped partway is swept back with `pnpm exec tsx tests/ui/src/farm-sweep.ts <run> [mint]`.
import { expect, test, type Browser } from "@playwright/test";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Address, KeyPairSigner } from "@solana/kit";
import { allocate, rungAtOrBelow, seatOutcome, Tier } from "@top-pad/chain";
import { FAIR_OPEN_ERROR__SEAT_HELD_BY_ANOTHER_WALLET, fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { FairOpen } from "@top-pad/contract";
import { admissionReviews } from "@top-pad/db";
import { chainTime, coinBalance, fund, rpc, send } from "@top-pad/tests-devnet/devnet";
import { seatsOf } from "@top-pad/tests-devnet/fair-open";
import { landRefused, newRun, untilChainTime } from "@top-pad/tests-devnet/simulation";
import { eq } from "drizzle-orm";
import { database } from "./bundler";
import { FARM_SIZE, farmWallets, HONEST, linkX, prepareDeposit, SCORED, sendConfirmed, signPrepared, sweepFarm, TIED, verifyOnce } from "./farm";
import { expectVampLaunchable, newHandle, newTicker, pageErrors, runName, short, signInOnLaunch, snap, TEASER, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const STEP = 10_000_000n;
const FEE = 5_000n;
/** What each farm wallet holds: above an empty account's rent, enough to be asked about; the first two can deposit. */
const FARM_FUNDS = 1_500_000n;
const FARM_DEPOSITOR_FUNDS = (SOL * 12n) / 100n;
/** The honest depositors' asks, in steps: the Scored ones 0.1 to 0.25 SOL, every Unverified one its whole 0.1 cap. */
const honestAsk = (i: number) => (i < SCORED ? 10n + BigInt(i % 4) * 5n : 10n);
const view = async (launch: string) => FairOpen.parse(await (await fetch(`${TARGET.api}/fair-opens/${launch}`)).json());

/** A page of its own with `wallet` installed and connected on the Fair Open's page. */
async function connected(browser: Browser, launch: Address, wallet: KeyPairSigner) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  await installTestWallet(page, wallet);
  await page.goto(`/fair-open/${launch}`);
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  return page;
}

test("a farm of 100 wallets gets one seat, the creator's cluster none, and every seat its coins within 2 minutes", async ({ page, browser }) => {
  test.setTimeout(40 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const run = newRun("farm");
  const w = await farmWallets(run);
  console.log(`run ${run}: creator ${w.creator.address}, farm root ${w.root.address}`);
  let launch: Address | null = null;
  let mint: Address | null = null;
  try {
    // Where every wallet's SOL comes from: the farm's from its root, the honest wallets' and the root's from the bank,
    // which as a hub ties nobody together, and the tied wallets' from the Creator wallet.
    await fund([w.creator, w.root], [SOL / 10n, 2n * FARM_DEPOSITOR_FUNDS + BigInt(FARM_SIZE - 2) * FARM_FUNDS + SOL / 50n]);
    await fund(w.honest, w.honest.map((_, i) => honestAsk(i) * STEP + SOL / 80n));
    for (let i = 0; i < FARM_SIZE; i += 16) {
      const batch = w.farm.slice(i, i + 16);
      await send(w.root, batch.map((f, j) => getTransferSolInstruction({ source: w.root, destination: f.address, amount: i + j < 2 ? FARM_DEPOSITOR_FUNDS : FARM_FUNDS })));
    }
    const tiedFunds = 3_000_000n;
    await send(w.creator, w.tied.slice(0, TIED - 1).map((t) => getTransferSolInstruction({ source: w.creator, destination: t.address, amount: tiedFunds })));
    await send(w.creator, [getTransferSolInstruction({ source: w.creator, destination: w.hop.address, amount: tiedFunds + FEE })]);
    await send(w.hop, [getTransferSolInstruction({ source: w.hop, destination: w.tied[TIED - 1]!.address, amount: tiedFunds })]);

    // The Scored honest wallets: each person links X once and verifies their wallet by signing Heat's message.
    for (const wallet of w.honest.slice(0, SCORED)) {
      const handle = newHandle();
      expect(await verifyOnce(await linkX(handle), wallet)).toMatchObject({ tier: "scored", handle });
    }

    // The creator schedules a Fair Open from the site, its window starting now, and signs the whole ladder at once.
    const wallet = await installTestWallet(page, w.creator);
    const ticker = newTicker();
    await page.goto("/launch");
    await signInOnLaunch(page);
    await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill(runName("E2E Farm", ticker));
    await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
    // A drawn picture may look like an earlier test coin's to SSCD (#107): a label does not stop a Fair Open.
    await expectVampLaunchable(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Schedule the window" })).toBeVisible();
    await page.getByRole("radio", { name: /Now/ }).check();
    await page.getByLabel("Teaser for the calendar (optional)").fill(TEASER);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Sign your open in advance" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 150_000 });
    expect(wallet.approvals).toEqual([1, 65]);
    await page.getByRole("link", { name: "Open its page" }).click();
    await page.waitForURL(/\/fair-open\//);
    launch = page.url().split("/fair-open/")[1]!.split(/[?#]/)[0] as Address;
    const account = (await fetchLaunch(rpc, launch)).data;
    console.log(`Fair Open ${launch}: window to ${account.opensAt}, ${Number(account.opensAt - (await chainTime()))} s left`);

    // The honest wallets deposit through the API, as the page would: each its own person, Scored or Unverified.
    for (const [i, h] of w.honest.entries()) {
      const prepared = await prepareDeposit(launch, h.address, honestAsk(i) * STEP);
      expect(prepared, `honest ${i}`).toMatchObject({ status: 200, admission: { tier: i < SCORED ? "scored" : "unverified" } });
      const signed = await signPrepared(h, prepared.transaction!);
      await sendConfirmed(signed.wire, signed.signature);
    }

    // The farm races: its first two wallets are admitted before either deposits, as one person with one pseudonym. The
    // first takes the seat; the second's deposit, its admission valid, is refused on chain: the seat is another wallet's.
    const [first, second] = [w.farm[0]!, w.farm[1]!];
    const a = await prepareDeposit(launch, first.address, 10n * STEP);
    const b = await prepareDeposit(launch, second.address, 10n * STEP);
    expect(a).toMatchObject({ status: 200, admission: { tier: "unverified" } });
    expect(b).toMatchObject({ status: 200, admission: { tier: "unverified" } });
    const signedA = await signPrepared(first, a.transaction!);
    await sendConfirmed(signedA.wire, signedA.signature);
    const refusedOnChain = await landRefused((await signPrepared(second, b.transaction!)).wire);
    expect(refusedOnChain.error).toBe(FAIR_OPEN_ERROR__SEAT_HELD_BY_ANOTHER_WALLET);
    console.log(`the farm's second wallet was refused on chain: ${refusedOnChain.signature}`);

    // The other 98 are refused by admission, each told why; the seat's own wallet is still its person's.
    const merged =
      `Heat counts this wallet as one person with ${short(first.address)}: both got their SOL from ${short(w.root.address)}, this wallet directly. ` +
      `${short(first.address)} holds this Fair Open's seat: one person, one seat, one wallet. You can still buy the coin once it opens.`;
    const started = Date.now();
    for (const f of w.farm.slice(2)) {
      const answer = await prepareDeposit(launch, f.address, STEP);
      expect(answer, f.address).toMatchObject({ status: 403, code: "not_admitted", error: merged });
    }
    console.log(`98 farm wallets refused by admission in ${Math.round((Date.now() - started) / 1000)} s`);
    expect(await prepareDeposit(launch, second.address, STEP), "the farm's second wallet").toMatchObject({ status: 403, error: merged });
    expect(await prepareDeposit(launch, first.address, STEP), "the seat's own wallet").toMatchObject({ status: 409, code: "over_cap" });

    // Every wallet tied to the creator's cluster is refused, and told why.
    for (const [i, t] of w.tied.entries()) {
      const route = i < TIED - 1 ? "directly" : "through 1 pass-through wallet in between";
      expect(await prepareDeposit(launch, t.address, STEP)).toMatchObject({
        status: 403,
        code: "not_admitted",
        error: `The Creator wallet funded this wallet, ${route}. Wallets tied to the creator cannot deposit in their Fair Open. You can still buy the coin once it opens.`,
      });
    }

    // What a farm wallet and a tied wallet see on the Fair Open page.
    const farmPage = await connected(browser, launch, w.farm[7]!);
    await expect(farmPage.getByTestId("fair-open-refused")).toContainText(`${short(first.address)} holds this Fair Open's seat`, { timeout: 60_000 });
    await snap(farmPage, "farm-1-farm-wallet-refused");
    await farmPage.close();
    const tiedPage = await connected(browser, launch, w.tied[TIED - 1]!);
    await expect(tiedPage.getByTestId("fair-open-refused")).toContainText("The Creator wallet funded this wallet, through 1 pass-through wallet", { timeout: 60_000 });
    await snap(tiedPage, "farm-2-tied-wallet-refused");
    await tiedPage.close();

    // One seat for the farm among the honest wallets' 20.
    const seats = await seatsOf(launch);
    const farmSet = new Set<string>(w.farm.map((f) => f.address));
    expect(seats.filter((s) => farmSet.has(s.seat.wallet)).map((s) => s.seat.wallet)).toEqual([first.address]);
    expect(seats).toHaveLength(HONEST + 1);
    for (const t of w.tied) expect(seats.some((s) => s.seat.wallet === t.address)).toBe(false);

    // The operator queue keeps every merge and refusal.
    const { db, close } = database();
    const reviews = await db.select().from(admissionReviews).where(eq(admissionReviews.launch, launch)).finally(close);
    expect(reviews.filter((r) => r.kind === "merged" && farmSet.has(r.wallet))).toHaveLength(FARM_SIZE);
    expect(reviews.filter((r) => r.kind === "refused").map((r) => r.wallet).sort()).toEqual(w.tied.map((t) => t.address).sort());

    // Before the open: the levels the API shows the page, and the reference's from the launch account.
    await untilChainTime(account.opensAt - 4n);
    const shown = (await view(launch)).allocation;
    const closed = (await fetchLaunch(rpc, launch)).data;
    const reference = allocate(closed.counts, closed.unverifiedCounts, closed.step, closed.potCap);
    expect(shown).toMatchObject({ spend: `${reference.spend}`, others: { level: `${reference.others.level}` }, unverified: { level: `${reference.unverified.level}`, limited: true } });
    const rung = rungAtOrBelow(closed.potCap, reference.spend)!;
    expect(shown.rung).toBe(`${rung}`);
    console.log(`the pot: ${reference.spend} of fills, levels ${reference.others.level} and Unverified ${reference.unverified.level}, the ${rung} rung`);

    // The keeper opens it: the program's levels match the reference and the page's to the lamport.
    await expect.poll(async () => (await fetchLaunch(rpc, launch!)).data.status, { timeout: 120_000, intervals: [1_000] }).toBe(LaunchStatus.Opened);
    const opened = (await fetchLaunch(rpc, launch)).data;
    mint = opened.mint;
    expect(opened).toMatchObject({ spend: reference.spend, othersLevel: reference.others.level, unverifiedLevel: reference.unverified.level, spent: rung });
    const history = await rpc.getSignaturesForAddress(launch, { limit: 50 }).send();
    const open = history.filter((h) => !h.err && h.blockTime !== null && h.blockTime >= account.opensAt).at(-1)!;
    console.log(`the keeper's open ${open.signature} landed ${open.blockTime! - account.opensAt} s after its time`);

    // Unverified fills stay at or under a quarter of what the pot spends.
    const tiers = new Map(seats.map((s) => [s.seat.wallet as string, { tier: s.seat.tier as Tier, deposit: s.seat.deposit }]));
    const unverifiedFills = [...tiers.values()].filter((t) => t.tier === Tier.Unverified).reduce((n, t) => n + seatOutcome(opened, t.tier, t.deposit).fill, 0n);
    console.log(`Unverified fills ${unverifiedFills} of ${opened.spend}: ${((Number(unverifiedFills) / Number(opened.spend)) * 100).toFixed(3)}%`);
    expect(4n * unverifiedFills).toBeLessThanOrEqual(opened.spend);

    // Every seat has its coins and refund within 2 minutes of the open: each read until it is delivered, or closed by its
    // Tax Share, which pays only a delivered seat.
    const pending = new Map(seats.map((s) => [s.address as string, s.seat.wallet as string]));
    const deliveredAt = new Map<string, bigint>();
    while (pending.size && (await chainTime()) - open.blockTime! <= 150n) {
      const now = await chainTime();
      const live = new Map((await seatsOf(launch)).map((s) => [s.address as string, s]));
      for (const [seat, holder] of pending) {
        const s = live.get(seat);
        if (s && !s.seat.delivered) continue;
        if (s) {
          const o = seatOutcome(opened, s.seat.tier, s.seat.deposit);
          expect(s.seat, holder).toMatchObject({ delivered: true, coins: o.coins, refund: o.refund, spent: o.spent });
          expect(await coinBalance(holder as Address, opened.mint)).toBe(o.coins);
        }
        deliveredAt.set(holder, now - open.blockTime!);
        pending.delete(seat);
      }
      if (pending.size) await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(pending.size, `seats still waiting: ${[...pending.values()].join(", ")}`).toBe(0);
    const latest = [...deliveredAt.values()].reduce((x, y) => (y > x ? y : x), 0n);
    console.log(`every one of ${deliveredAt.size} seats had its coins and refund ${latest} s after the open, by the chain's clock`);
    expect(latest).toBeLessThanOrEqual(120n);
    await page.reload();
    await expect(page.getByTestId("fair-open-delivered")).toContainText("Every seat has its coins and refund", { timeout: 60_000 });
    // The deposit panel reads the connected wallet's seat a moment after the page: photographed once it has.
    await expect(page.getByText("Reading your seat from the chain")).toHaveCount(0, { timeout: 30_000 });
    await snap(page, "farm-3-opened");

    // The keeper collects the Tax Share at 60 s, pays every seat as it closes, and closes the launch and its nonce.
    await expect.poll(async () => (await rpc.getBalance(launch!, { commitment: "confirmed" }).send()).value, { timeout: 300_000 }).toBe(0n);
    await expect.poll(async () => (await rpc.getBalance(account.nonce, { commitment: "confirmed" }).send()).value, { timeout: 120_000 }).toBe(0n);
    expect(errors).toEqual([]);
  } finally {
    if (launch && !mint) {
      const left = await fetchLaunch(rpc, launch).catch(() => null);
      if (left?.data.status === LaunchStatus.Opened) mint = left.data.mint;
    }
    // Sold back only once the Tax window is over.
    const row = launch && mint ? await view(launch).catch(() => null) : null;
    if (row?.open) await untilChainTime(BigInt(Math.floor(Date.parse(row.open.taxWindowEndsAt) / 1000)) + 5n);
    await sweepFarm(run, mint);
  }
});
