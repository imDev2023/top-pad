// A creator launches an Instant launch from the site: link X, choose Instant launch, enter the coin, connect a wallet,
// sign once. The coin then exists on devnet as a Heat coin, its metadata on Arweave naming the creator's X, and no other
// wallet can launch for the same record. Each step is photographed on a phone and a desktop, in both themes, for the
// pixel check (spec 14: every screen ships both).
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { address, generateKeyPairSigner } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda, LaunchMode } from "@top-pad/clients/fee";
import { fundedWallets, rpc } from "@top-pad/tests-devnet/devnet";
import { coinImage, newHandle, newTicker, pageErrors, short, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

test("a creator launches an Instant launch from the site", async ({ browser, page }) => {
  const errors = pageErrors(page);
  const handle = newHandle();
  const [creator] = await fundedWallets(30_000_000n);
  const wallet = await installTestWallet(page, creator);
  const ticker = newTicker();

  await page.goto("/launch");
  await expect(page.getByRole("heading", { name: "Link your X account" })).toBeVisible();
  await snap(page, "1-link-x");

  await page.getByRole("link", { name: "Link X" }).click();
  // The stand-in for X's authorize page (tests/x-stand-in): link as this run's own new creator.
  await expect(page.getByRole("heading", { name: "Heat wants to read your X account" })).toBeVisible();
  await page.getByLabel("Handle").fill(handle);
  await snap(page, "1b-x-stand-in");
  await page.getByRole("button", { name: "Authorize app" }).click();
  await expect(page.getByText("Your X account is linked.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible();
  await expect(page.getByText(`@${handle}`)).toBeVisible();
  // Fair Open is preselected and not yet open: nothing goes forward until Instant launch is chosen.
  await expect(page.getByRole("radio", { name: /Fair Open/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
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
  await page.getByLabel("Name").fill("E2E Lumen");
  await page.locator('input[type="file"]').setInputFiles(coinImage);
  await expect(page.getByText("No protected coin matches this ticker or name.")).toBeVisible();
  await expect(page.getByText(/coin\.png · 160 × 160/)).toBeVisible();
  await snap(page, "4-coin-clear");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Sign the launch" })).toBeVisible();
  await snap(page, "5-sign-connect");
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(page.getByText(/which becomes your Creator wallet/)).toBeVisible();
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

  // On Arweave: the metadata, with the creator's X, and an image that is the one uploaded.
  const metadataUri = await page.getByRole("link", { name: "Its metadata on Arweave" }).getAttribute("href");
  const metadata = (await (await fetch(metadataUri!)).json()) as { name: string; symbol: string; image: string; twitter: string };
  expect(metadata).toMatchObject({ name: "E2E Lumen", symbol: ticker, twitter: `https://x.com/${handle}` });
  const image = new Uint8Array(await (await fetch(metadata.image)).arrayBuffer());
  expect(image).toEqual(new Uint8Array(readFileSync(coinImage)));

  // The record now has its Creator wallet: the one that signed its first launch.
  await page.getByRole("button", { name: "Launch another" }).click();
  await page.getByRole("button", { name: "Link X" }).click();
  await expect(page.getByText(`Creator wallet: ${short(creator.address)}`)).toBeVisible();

  // Another wallet on the same record cannot launch: the page says why and offers no launch, and the API refuses it
  // even when the page is bypassed.
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
  await otherPage.getByRole("radio", { name: /Instant launch/ }).check();
  await otherPage.getByRole("button", { name: "Continue" }).click();
  await otherPage.getByLabel("Ticker").fill(otherTicker);
  await otherPage.getByLabel("Name").fill("E2E Lumen");
  await otherPage.locator('input[type="file"]').setInputFiles(coinImage);
  await expect(otherPage.getByText("No protected coin matches this ticker or name.")).toBeVisible();
  await otherPage.getByRole("button", { name: "Continue" }).click();
  await connectTestWallet(otherPage, otherPage.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(otherPage.getByText("This is not your Creator wallet")).toBeVisible();
  await expect(otherPage.getByText(`Your launches are signed by ${short(creator.address)}`)).toBeVisible();
  await expect(otherPage.getByRole("button", { name: "Launch", exact: true })).toHaveCount(0);
  await snap(otherPage, "8-not-the-creator-wallet");

  const refused = await otherPage.request.post(`${TARGET.api}/launches`, {
    headers: { origin: TARGET.web },
    multipart: {
      mode: "instant",
      name: "E2E Lumen",
      ticker: otherTicker,
      wallet: otherWallet.address,
      image: { name: "coin.png", mimeType: "image/png", buffer: readFileSync(coinImage) },
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
