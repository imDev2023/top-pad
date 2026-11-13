// A creator launches an Instant launch from the site with a wallet alone (ADR 0008): connect it and sign in with one
// message, choose Instant launch, enter the coin, sign once. Linking X is offered once and never required. The coin then
// exists on devnet as a Heat coin, its metadata on Arweave naming no X account, and no other wallet can launch for the
// same record. Each step is photographed on a phone and a desktop, in both themes, for the pixel check (spec 14: every
// screen ships both).
import { expect, test } from "@playwright/test";
import { address, generateKeyPairSigner } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda, LaunchMode } from "@top-pad/clients/fee";
import { fundedWallets, rpc } from "@top-pad/tests-devnet/devnet";
import { expectVampClear, newTicker, pageErrors, runName, short, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

test("a creator launches an Instant launch from the site, signed in with a wallet alone", async ({ browser, page }) => {
  const errors = pageErrors(page);
  const [creator] = await fundedWallets(30_000_000n);
  const wallet = await installTestWallet(page, creator);
  const ticker = newTicker();

  await page.goto("/launch");
  await expect(page.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  // No Link X step: the steps start with the wallet.
  await expect(page.getByRole("list", { name: "Steps" })).toHaveText(/^Connect walletLaunch modeCoinScheduleSignDone$/);
  await snap(page, "1-connect-wallet");

  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(page.getByRole("button", { name: "Sign in with this wallet" })).toBeVisible();
  await snap(page, "1b-sign-in");
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  // One message, no transaction: the Sign In With Solana message naming the site and the wallet.
  expect(wallet.messages).toHaveLength(1);
  expect(wallet.messages[0]).toContain(`${new URL(TARGET.web).host} wants you to sign in with your Solana account:\n${creator.address}`);
  expect(wallet.requests).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible();
  // The card names the Creator wallet, there being no X account.
  await expect(page.getByRole("complementary").getByText(short(creator.address))).toBeVisible();
  // Fair Open is preselected; this spec launches an Instant launch (fair-open-scheduled.spec.ts schedules a Fair Open).
  await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await snap(page, "2-launch-mode");

  await page.getByRole("radio", { name: /Instant launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your coin" })).toBeVisible();

  // Refused as typed, with the reason shown.
  await page.getByLabel("Ticker").fill("e2e-coin");
  await page.getByLabel("Name").fill("E2E Lum\u{435}n");
  await page.getByLabel("Name").blur();
  await expect(page.getByText(/only use the letters A to Z/)).toBeVisible();
  await expect(page.getByText(/mixes Latin letters with Cyrillic or Greek/)).toBeVisible();
  await snap(page, "3-coin-refused");

  await page.getByLabel("Ticker").fill(ticker.toLowerCase());
  await expect(page.getByLabel("Ticker")).toHaveValue(ticker);
  const name = runName("E2E Lumen", ticker);
  const picture = await uniqueCoinImage(page, ticker);
  await page.getByLabel("Name").fill(name);
  await page.locator('input[type="file"]').setInputFiles(picture);
  await expectVampClear(page);
  await expect(page.getByText(`${picture.name} · 256 × 256`)).toBeVisible();
  await snap(page, "4-coin-clear");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Sign the launch" })).toBeVisible();
  await expect(page.getByText(/your Creator wallet\.$/)).toBeVisible();
  await snap(page, "6-sign-ready");

  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launched" })).toBeVisible({ timeout: 150_000 });
  expect(wallet.requests).toHaveLength(1);
  await snap(page, "7-done");

  // On devnet: the pool on Heat's Instant config, created by the creator's wallet, and the fee program's record.
  const mint = address((await page.locator("dd").first().textContent())!.trim());
  const [coinRecord] = await findCoinRecordPda({ mint });
  const record = await fetchCoinRecord(rpc, coinRecord);
  expect(record.data.launchMode).toBe(LaunchMode.Instant);
  const pool = await fetchVirtualPool(rpc, record.data.pool);
  expect(pool.data.poolState).toMatchObject({ config: CLUSTERS.devnet!.configs!.instant, creator: creator.address, baseMint: mint });

  // On Arweave: the metadata, naming no X account since the creator linked none, and an image that is the one uploaded.
  const metadataUri = await page.getByRole("link", { name: "Its metadata on Arweave" }).getAttribute("href");
  const metadata = (await (await fetch(metadataUri!)).json()) as Record<string, unknown> & { image: string };
  expect(metadata).toMatchObject({ name, symbol: ticker });
  expect(metadata).not.toHaveProperty("twitter");
  const image = new Uint8Array(await (await fetch(metadata.image)).arrayBuffer());
  expect(image).toEqual(new Uint8Array(picture.buffer));

  // The first step, signed in: the Creator wallet and its launch, and X offered as optional.
  await page.getByRole("button", { name: "Launch another" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.getByTestId("signed-in")).toContainText(`Signed in as ${short(creator.address)}`);
  await expect(page.getByTestId("signed-in")).toContainText("1 launch so far.");
  await expect(page.getByRole("link", { name: "Link X" })).toBeVisible();
  await expect(page.getByText(/^Optional\./)).toBeVisible();
  await snap(page, "8-signed-in");

  // Another wallet in the same browser is told it is not the one signed in, and the API refuses its launch for this
  // record even when the page is bypassed.
  const otherWallet = await generateKeyPairSigner();
  const other = await browser.newContext({
    storageState: await page.context().storageState(),
    baseURL: TARGET.web,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const otherPage = await other.newPage();
  await installTestWallet(otherPage, otherWallet);
  const otherTicker = newTicker();
  await otherPage.goto("/launch");
  await expect(otherPage.getByText(`This browser is signed in as ${short(creator.address)}. Connect that wallet to go on.`)).toBeVisible();
  await connectTestWallet(otherPage, otherPage.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(otherPage.getByText(`This browser is signed in as ${short(creator.address)}. Connect that wallet, or sign in with this one.`)).toBeVisible();
  await expect(otherPage.getByRole("button", { name: "Continue" })).toBeDisabled();
  await snap(otherPage, "9-another-wallet");
  const otherPicture = await uniqueCoinImage(otherPage, otherTicker);

  const refused = await otherPage.request.post(`${TARGET.api}/launches`, {
    headers: { origin: TARGET.web },
    multipart: {
      mode: "instant",
      name: runName("E2E Lumen", otherTicker),
      ticker: otherTicker,
      wallet: otherWallet.address,
      image: otherPicture,
    },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({
    error: `Your Creator wallet is ${short(creator.address)}, the only wallet that can sign your launches. Connect it to launch.`,
    code: "not_the_creator_wallet",
  });
  await other.close();
  expect(errors).toEqual([]);
});
