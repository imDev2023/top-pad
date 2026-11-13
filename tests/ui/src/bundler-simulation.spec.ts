// The bundler simulation (spec 11.1; #56's devnet demo), repeatable: a creator links X and funds 4 wallets directly, then
// the Creator wallet and those 4 buy their Instant launch in its creation slot (bundler.ts), buy on past the sniper tax and
// sell 2 minutes after the open. It passes when the bundle lost at least 97% of what its creation-slot buys spent, Bundle
// Radar labelled the coin, a case opened with its evidence pack and an operator confirmed it, our launch key refused the
// creator's next launch, and the 72-hour private window and the appeal form work. Then the rest of the Bar (spec 6.5): the
// creator's X direct message, a barred creator still depositing in another creator's Fair Open and claiming their Creator
// Earnings, the finding published on the record and the coin's page, and an appeal upheld by a second operator, which
// clears the public record while the audit log keeps the finding.
//
// The operators: the deployed operator app signs in only the owner through Cloudflare Access, so the simulation drives two
// operator apps on this Mac against the same database, each with its own stand-in identity (src/operators.ts): start them
// with `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui operators` before the run (OPERATOR_URL and
// SECOND_OPERATOR_URL name them otherwise). The 72 hours cannot be waited out in a run: once the private window is shown,
// the run moves the Bar's publication to now in the database, standing in for the hours passing.
//
// Real devnet SOL: about 0.15 a run (the pools' rent, the creation slot's 99% tax, the other creator's Fair Open rent, all
// but the tax and the fees swept back). It waits out the coin's first hour for its case: about 85 minutes in all. Run it
// alone as `bundler-simulation.spec.ts` with `e2e:devnet`; its wallets derive from the bank's key and the run's name, which
// it logs, so a run stopped partway is swept back with `pnpm exec tsx tests/devnet/src/bundle-sweep.ts <run> <mint>`.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Address, Signature } from "@solana/kit";
import { BundleRadar, CoinTrades, EnforcementCounts } from "@top-pad/contract";
import { auditLog, bars, bundleCases, xMessages } from "@top-pad/db";
import { fundDirectly, landings, runWallets, sellAndClose, sweepRun, wrapSol } from "@top-pad/tests-devnet/bundle";
import { chainTime, fund, fundedWallets, swap, sweep } from "@top-pad/tests-devnet/devnet";
import { recoverDeposits, scheduleFairOpen, type ScheduledFairOpen } from "@top-pad/tests-devnet/fair-open";
import { and, eq, sql } from "drizzle-orm";
import { api, BUY, COPIES, database, FUNDED, INSTANT, launchWithBundle, PAST_TAX, SOL, sleep, waitFor, type Attempt } from "./bundler";
import { expectVampLaunchable, newTicker, pageErrors, runName, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet } from "./wallet";

const OPERATOR = process.env.OPERATOR_URL ?? "http://localhost:8803";
const SECOND_OPERATOR = process.env.SECOND_OPERATOR_URL ?? "http://localhost:8804";

/** The share of what the creation-slot buys spent that the bundle got back, as parts per million. */
const PPM = 1_000_000n;

/** A wallet's creation-slot buys, and what its sells fetched for their share of its coins. */
function slotOutcome(radar: BundleRadar, trades: CoinTrades["trades"], wallet: Address) {
  const w = radar.wallets.find((x) => x.wallet === wallet);
  const slot = (w?.buys ?? []).filter((b) => b.labels.includes("same_slot"));
  const spent = slot.reduce((n, b) => n + BigInt(b.quoteAmount), 0n);
  const slotCoins = slot.reduce((n, b) => n + BigInt(b.baseAmount), 0n);
  const sells = trades.filter((t) => t.trader === wallet && t.side === "sell");
  // A sell's quote amount is what it fetched before the fee, which DBC takes from it.
  const fetched = sells.reduce((n, t) => n + BigInt(t.quoteAmount) - BigInt(t.fee), 0n);
  const sold = sells.reduce((n, t) => n + BigInt(t.baseAmount), 0n);
  // Each wallet sold everything at once, its creation-slot coins with the ones it bought past the tax: those coins get
  // their share of what the sell fetched.
  const back = sold > 0n ? (fetched * slotCoins) / sold : 0n;
  return { spent, back, sells: sells.length };
}

/** Records the operator's decision on an operator app page: the choice, the reason, and the audit row it lands on. */
async function decide(page: Page, choice: RegExp, note: string) {
  await page.getByRole("radio", { name: choice }).check();
  await page.getByLabel("Why (kept in the audit log)").fill(note);
  await page.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("status")).toContainText("written to the audit log as row");
}

/** A fresh browser with no wallet and no session: what anyone sees. */
async function stranger(browser: Browser) {
  const context = await browser.newContext({ baseURL: TARGET.web, viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  return context.newPage();
}

/** Prepares an Instant launch through the API as the browser's session, as the launch flow does, and says how it answered. */
async function prepareStatus(page: Page, wallet: Address) {
  const image = await uniqueCoinImage(page, newTicker());
  const res = await page.request.post(`${TARGET.api}/launches`, {
    headers: { origin: TARGET.web },
    multipart: { mode: "instant", name: runName("Barred Again", newTicker()), ticker: newTicker(), wallet, image },
  });
  return { status: res.status(), body: (await res.json()) as { code?: string; error?: string } };
}

test("the bundler simulation: the bundle loses its creation-slot spend, a confirmed case bars the creator, and an upheld appeal lifts it", async ({ page: first, browser }) => {
  test.setTimeout(120 * 60_000);
  let page = first;
  let errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const run = `bundler-${Date.now()}`;
  const { creator, sniper, funded } = await runWallets(run);
  console.log(`bundler simulation ${run}: creator ${creator.address}`);
  const bundleWallets = [creator, ...funded];
  const { db, close } = database();
  const mints: Address[] = [];
  let other: ScheduledFairOpen | null = null;
  const [otherCreator] = await fundedWallets(SOL / 20n);
  try {
    // The creator pays each try's pool rent and funds its 4 wallets, with 0.02 SOL over to deposit in another's Fair Open.
    await fund([creator, sniper], [(SOL * 37n) / 100n, SOL / 20n]);
    await fundDirectly(creator, funded.map((f) => f.address), FUNDED);
    for (const w of [...bundleWallets, sniper]) await wrapSol(w, BUY * BigInt(COPIES + 2));

    // The bundle must land in the creation slot: a launch whose buys missed it is launched again, at most 5 times.
    let attempt: Attempt | null = null;
    let handle: string | null = null;
    let creationSlot = 0n;
    for (let tries = 0; tries < 5; tries++) {
      if (tries) {
        await page.close();
        page = await first.context().newPage();
        errors = pageErrors(page);
      }
      // The creator links X on the first try, so the Bar owes them a direct message; a try again keeps the record.
      const launched = await launchWithBundle(page, creator, funded, sniper, { linked: tries > 0, linkX: tries === 0 });
      handle ??= launched.handle;
      attempt = launched;
      mints.push(launched.mint);
      const radar = await waitFor(() => api(`/coins/${launched.mint}/radar`, BundleRadar), (r) => r.creation.blockIndex !== null, 60_000);
      creationSlot = BigInt(radar.creation.slot);
      const landed = await landings(launched.copies.map((c) => c.signature));
      const inSlot = new Set(
        launched.copies.flatMap((c) => {
          const l = landed.get(c.signature as Signature);
          return l && !l.err && l.slot === creationSlot ? c.buyers : [];
        }),
      );
      console.log(`try ${tries + 1}: ${launched.mint}, created in slot ${creationSlot}; ${inSlot.size} bundle wallets bought in it`);
      if (bundleWallets.every((w) => inSlot.has(w.address))) break;
      for (const w of [...bundleWallets, sniper]) await sellAndClose(w, launched.mint, INSTANT).catch(() => undefined);
      for (const w of [...bundleWallets, sniper]) await wrapSol(w, BUY * BigInt(COPIES + 2));
      attempt = null;
    }
    expect(attempt, "the Creator wallet and its 4 wallets each bought in the creation slot").not.toBeNull();
    expect(handle, "the creator linked X").not.toBeNull();
    const coin = attempt!.mint;
    const opened = Date.parse((await api(`/coins/${coin}/radar`, BundleRadar)).openedAt);

    // Bundle Radar labels the coin: the 4 funded wallets linked to the creator.
    const linked = await waitFor(
      () => api(`/coins/${coin}/radar`, BundleRadar),
      (r) => funded.every((f) => r.wallets.some((w) => w.wallet === f.address && w.linked)),
      120_000,
    );
    console.log(`Bundle Radar linked ${linked.linked.wallets} wallets to the creator`);
    await page.goto(`/coin/${coin}`);
    await expect(page.getByTestId("radar-linked")).toContainText("wallets linked to the creator", { timeout: 30_000 });
    await snap(page, "sim-01-radar");

    // Past the sniper tax the 4 wallets buy on, over 1% of supply between them; 2 minutes after the open everyone sells.
    await sleep(Math.max(0, opened + 65_000 - Date.now()));
    for (const f of funded) await swap(f, coin, "buy", PAST_TAX);
    await sleep(Math.max(0, opened + 120_000 - Date.now()));
    for (const w of [...bundleWallets, sniper]) await sellAndClose(w, coin, INSTANT);

    // The bundle lost at least 97% of what its creation-slot buys spent (spec 11.1).
    const [radar, trades] = await (async () => {
      for (;;) {
        const [r, t] = [await api(`/coins/${coin}/radar`, BundleRadar), await api(`/coins/${coin}/trades?limit=200`, CoinTrades)];
        if (bundleWallets.every((w) => t.trades.some((x) => x.trader === w.address && x.side === "sell"))) return [r, t.trades] as const;
        await sleep(2_000);
      }
    })();
    const outcomes = bundleWallets.map((w) => slotOutcome(radar, trades, w.address));
    const spent = outcomes.reduce((n, o) => n + o.spent, 0n);
    const back = outcomes.reduce((n, o) => n + o.back, 0n);
    const lostPpm = PPM - (back * PPM) / spent;
    console.log(`the bundle's creation-slot buys spent ${spent} lamports and got back ${back}: ${Number(lostPpm) / 10_000}% lost`);
    expect(spent).toBeGreaterThan(0n);
    expect(lostPpm).toBeGreaterThanOrEqual(970_000n);
    await sweep(...funded, sniper);

    // An hour after the open the case job opens the case, with its evidence pack.
    let found: typeof bundleCases.$inferSelect | undefined;
    while (!found && Date.now() < opened + 75 * 60_000) {
      if (TARGET.name === "local" && Date.now() > opened + 60 * 60_000) await fetch(`${TARGET.api}/cdn-cgi/local/scheduled`).catch(() => undefined);
      [found] = await db.select().from(bundleCases).where(eq(bundleCases.mint, coin));
      if (!found) await sleep(30_000);
    }
    expect(found, "a case opened within 75 minutes of the open").toBeDefined();
    console.log(`case ${found!.id} opened ${((found!.openedAt.getTime() - opened) / 60_000).toFixed(1)} min after the open`);

    // The first operator reads the evidence pack and confirms the case: the creator is barred.
    const operator = await browser.newPage();
    await operator.goto(`${OPERATOR}/cases/${coin}`);
    await operator.getByRole("button", { name: "Open the evidence pack" }).click();
    await expect(operator.getByRole("heading", { name: "Linked wallets" })).toBeVisible();
    await snap(operator, "sim-02-operator-evidence");
    await operator.goto(`${OPERATOR}/cases/${coin}`);
    await expect(operator.getByText("Heat's X account sends them a direct message")).toBeVisible();
    await snap(operator, "sim-03-operator-case");
    await decide(operator, /Confirm the case: bar the creator/, `Simulation ${run}: the Creator wallet funded 4 wallets that bought with it in the creation slot.`);
    const barId = new URL(operator.url()).pathname.split("/").pop()!;
    await expect(operator.getByText("Private window", { exact: true })).toBeVisible();
    await snap(operator, "sim-04-operator-bar");

    // Our launch key refuses the creator's next launch, in the launch flow and at the API.
    await page.goto("/launch");
    await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("radio", { name: /Instant launch/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    const ticker = newTicker();
    await page.getByLabel("Ticker").fill(ticker);
    await page.getByLabel("Name").fill(runName("Barred Again", ticker));
    await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, ticker));
    await expectVampLaunchable(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Heat's launch key no longer co-signs your launches", { timeout: 30_000 });
    await snap(page, "sim-05-launch-refused");
    expect(await prepareStatus(page, creator.address)).toMatchObject({ status: 403, body: { code: "barred" } });

    // The 72-hour private window: the creator's record shows them the evidence, a reply box and the appeal form.
    await page.getByRole("link", { name: /Your Creator record/ }).click();
    const panel = page.getByTestId("private-bar");
    await expect(panel).toContainText("Only you see this until", { timeout: 30_000 });
    await expect(panel.getByTestId("bar-evidence-wallet")).toHaveCount(found!.linkedWallets);
    await snap(page, "sim-06-private-window");
    await panel.getByLabel("Reply to the evidence").fill("These are my own wallets, funded for a launch-day test.");
    await panel.getByRole("button", { name: "Send the reply" }).click();
    await expect(panel.getByTestId("bar-reply")).toContainText("funded for a launch-day test");
    await panel.getByRole("radio", { name: /A launch service/ }).check();
    await panel.getByLabel("Why the link is wrong").fill("A launch service sent these buys for me as part of its package; I did not run them myself.");
    await panel.getByLabel("Evidence, if you have it").fill("The service's invoice and its bundle's signatures.");
    await panel.getByRole("button", { name: "File the appeal" }).click();
    await expect(panel.getByTestId("bar-appeal")).toContainText("Waiting");
    await snap(page, "sim-07-appealed");
    // Nobody else sees any of it before the 72 hours are up.
    const outsider = await stranger(browser);
    await outsider.goto(`/creator/${creator.address}`);
    await expect(outsider.getByTestId("record-name")).toBeVisible();
    await expect(outsider.getByTestId("private-bar")).toHaveCount(0);
    await expect(outsider.getByTestId("public-bar")).toHaveCount(0);
    await expect(outsider.getByTestId("barred-mark")).toHaveCount(0);

    // Heat's X account sends the creator a direct message, by the API's five-minute cron.
    const message = await expect
      .poll(async () => (await db.select().from(xMessages).where(eq(xMessages.barId, barId)))[0] ?? null, { timeout: 7 * 60_000, intervals: [15_000] })
      .toMatchObject({ sentAt: expect.any(Date), xEventId: expect.stringMatching(/^\d+$/) })
      .then(async () => (await db.select().from(xMessages).where(eq(xMessages.barId, barId)))[0]!);
    console.log(`the X direct message went out ${((message.sentAt!.getTime() - message.createdAt.getTime()) / 1000).toFixed(0)} s after the Bar: ${message.text}`);

    // A Bar only stops new launches: the barred creator still deposits in another creator's Fair Open.
    const otherFairOpen = (other = await scheduleFairOpen(otherCreator, (await chainTime()) + 300n - 600n));
    await expect.poll(async () => (await fetch(`${TARGET.api}/fair-opens/${otherFairOpen.launch}`)).status, { timeout: 30_000 }).toBe(200);
    await page.goto(`/fair-open/${otherFairOpen.launch}`);
    const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
    const tier = page.getByTestId("fair-open-tier");
    await expect(tier.or(connect)).toBeVisible({ timeout: 30_000 });
    if (await connect.isVisible()) await connectTestWallet(page, connect);
    await expect(tier).toBeVisible({ timeout: 60_000 });
    await page.getByLabel("Amount (SOL, in steps of 0.01)").fill("0.01");
    await page.getByRole("button", { name: "Deposit 0.01 SOL" }).click();
    await expect(page.getByTestId("fair-open-done")).toContainText("Deposited 0.01", { timeout: 90_000 });
    await expect(page.getByTestId("fair-open-held")).toHaveText("0.01 SOL");
    await snap(page, "sim-08-barred-deposits");

    // And claims their Creator Earnings.
    await page.goto("/creator");
    const waiting = page.getByTestId("earnings-waiting");
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    const claim = page.getByRole("button", { name: /^Claim / });
    await expect(claim).toBeEnabled({ timeout: 60_000 });
    await claim.click();
    await expect(page.getByRole("status")).toContainText("Claimed", { timeout: 60_000 });
    await snap(page, "sim-09-barred-claims");

    // After the 72 hours (moved to now: see the header), the finding is public on the record, its summary and the coin's page.
    const before = await api("/enforcement", EnforcementCounts);
    await db.update(bars).set({ publishAt: sql`now()` }).where(eq(bars.id, barId));
    await outsider.goto(`/creator/${creator.address}`);
    const banner = outsider.getByTestId("public-bar");
    await expect(banner).toContainText("Barred: confirmed creator bundle in $", { timeout: 30_000 });
    await expect(banner).toContainText("Appeal waiting since");
    await expect(outsider.getByTestId("barred-mark").first()).toBeVisible();
    await banner.getByText("The evidence").click();
    await expect(banner.getByTestId("bar-evidence-wallet")).toHaveCount(found!.linkedWallets);
    await snap(outsider, "sim-10-public-record");
    await outsider.goto(`/coin/${coin}`);
    await expect(outsider.getByTestId("coin-finding")).toContainText("Confirmed creator bundle", { timeout: 30_000 });
    await snap(outsider, "sim-11-coin-finding");
    await outsider.goto("/enforced");
    await expect(outsider.getByTestId("count-bars")).toHaveText(`${before.bars + 1}`);
    await snap(outsider, "sim-12-enforced");

    // The operator who confirmed it may not hear the appeal; the second operator upholds it, lifting the Bar.
    await operator.goto(`${OPERATOR}/bars/${barId}`);
    await expect(operator.getByTestId("appeal-not-yours")).toBeVisible();
    await expect(operator.getByTestId("bar-reply")).toContainText("funded for a launch-day test");
    const second = await browser.newPage();
    await second.goto(`${SECOND_OPERATOR}/bars/${barId}`);
    await snap(second, "sim-13-second-operator-appeal");
    await decide(second, /Uphold it: lift the Bar/, `Simulation ${run}: the demo's appeal, upheld to show the Bar lifted.`);
    await expect(second.getByText("Lifted on appeal").first()).toBeVisible();
    await snap(second, "sim-14-appeal-upheld");

    // The public record forgets the finding; the audit log keeps it; the launch key co-signs again.
    await outsider.goto(`/creator/${creator.address}`);
    await expect(outsider.getByTestId("record-name")).toBeVisible();
    await expect(outsider.getByTestId("public-bar")).toHaveCount(0);
    await expect(outsider.getByTestId("barred-mark")).toHaveCount(0);
    await outsider.goto(`/coin/${coin}`);
    await expect(outsider.getByTestId("radar-linked")).toBeVisible({ timeout: 30_000 });
    await expect(outsider.getByTestId("coin-finding")).toHaveCount(0);
    expect(await api("/enforcement", EnforcementCounts)).toMatchObject({ bars: before.bars + 1, overturned: before.overturned + 1 });
    const [kept] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "appeal_upheld"), eq(auditLog.subject, `bar:${barId}`)));
    expect(kept!.detail).toMatchObject({ finding: { mint: coin, creatorWallet: creator.address } });
    await page.goto(`/creator/${creator.address}`);
    await expect(page.getByTestId("private-bar")).toContainText("Lifted on appeal", { timeout: 30_000 });
    await snap(page, "sim-15-lifted");
    expect((await prepareStatus(page, creator.address)).status).toBe(201);
    expect(errors).toEqual([]);
  } finally {
    if (other) await recoverDeposits(other.launch, creator, [creator]).catch((e) => console.error("bringing back the Fair Open deposit failed", e));
    await sweepRun(run, mints);
    await sweep(otherCreator);
    await close();
  }
});
