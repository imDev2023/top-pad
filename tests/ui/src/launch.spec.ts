// A creator launches an Instant launch from the site: link X, choose Instant launch, enter the coin, connect a wallet,
// sign once. The coin then exists on devnet as a Heat coin, its metadata on Arweave naming the creator's X. Each step is
// photographed on a phone and a desktop, in both themes, for the pixel check (spec 14: every screen ships both).
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  assertIsTransactionWithBlockhashLifetime,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { CLUSTERS } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda, LaunchMode } from "@top-pad/clients/fee";
import { connectTestWallet, installTestWallet } from "./wallet";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "..", "test-results", "shots");
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);

const VIEWS = [
  { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
  { name: "desktop-light", width: 1440, height: 900, colorScheme: "light" },
  { name: "phone-dark", width: 390, height: 844, colorScheme: "dark" },
  { name: "phone-light", width: 390, height: 844, colorScheme: "light" },
] as const;

/** The page as it is now, in every view, then back to the desktop in dark. */
async function snap(page: Page, step: string) {
  mkdirSync(shots, { recursive: true });
  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `${step}-${view.name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
}

/** A creator's wallet with a little devnet SOL from the Solana CLI's wallet: enough for the rent and the fees. */
async function fundedCreator() {
  const bank = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8"))));
  const creator = await generateKeyPairSigner();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transfer = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(bank, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: bank, destination: creator.address, amount: 30_000_000n }), m),
    ),
  );
  assertIsTransactionWithBlockhashLifetime(transfer);
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) })(transfer, { commitment: "confirmed" });
  return creator;
}

test("a creator launches an Instant launch from the site", async ({ page }) => {
  const handle = process.env.E2E_X_HANDLE!;
  const creator = await fundedCreator();
  const wallet = await installTestWallet(page, creator);
  const ticker = `E2E${Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;

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
  await page.locator('input[type="file"]').setInputFiles(join(here, "..", "fixtures", "coin.png"));
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
  expect(image).toEqual(new Uint8Array(readFileSync(join(here, "..", "fixtures", "coin.png"))));

  // The record now has its Creator wallet: the one that signed its first launch.
  await page.getByRole("button", { name: "Launch another" }).click();
  await page.getByRole("button", { name: "Link X" }).click();
  await expect(page.getByText(`Creator wallet: ${creator.address.slice(0, 4)}…${creator.address.slice(-4)}`)).toBeVisible();
});
