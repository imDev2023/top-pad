// What the end-to-end specs share: the views every step is photographed in, a new creator's X handle, and the launch
// flow walked through quickly, for a spec that needs a coin rather than the flow itself.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import type { KeyPairSigner } from "@solana/kit";
import { connectTestWallet, installTestWallet, type TestWallet } from "./wallet";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "..", "test-results", "shots");
export const coinImage = join(here, "..", "fixtures", "coin.png");

/** An address as the pages and the API shorten it. */
export const short = (a: string) => `${a.slice(0, 4)}\u{2026}${a.slice(-4)}`;
export const newTicker = () => `E2E${Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
/** A creator new to Heat: a fresh handle on the stand-in for X makes a fresh Creator record. */
export const newHandle = () => `e2e_creator_${Math.floor(Math.random() * 9e9 + 1e9)}`;

export const VIEWS = [
  { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
  { name: "desktop-light", width: 1440, height: 900, colorScheme: "light" },
  { name: "phone-dark", width: 390, height: 844, colorScheme: "dark" },
  { name: "phone-light", width: 390, height: 844, colorScheme: "light" },
] as const;

/** The page as it is now, in every view, then back to the desktop in dark. */
export async function snap(page: Page, step: string) {
  mkdirSync(shots, { recursive: true });
  // Off the page, so no hover state or chart crosshair shows.
  await page.mouse.move(0, 0);
  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `${step}-${view.name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
}

/** Links X as a new creator, launches an Instant launch signed by `creator`, and leaves the page on the Done step. */
export async function launchCoin(page: Page, creator: KeyPairSigner, coin: { name: string; ticker: string }): Promise<{ mint: string; wallet: TestWallet }> {
  const wallet = await installTestWallet(page, creator);
  await page.goto("/launch");
  await page.getByRole("link", { name: "Link X" }).click();
  await page.getByLabel("Handle").fill(newHandle());
  await page.getByRole("button", { name: "Authorize app" }).click();
  await page.getByRole("radio", { name: /Instant launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Ticker").fill(coin.ticker);
  await page.getByLabel("Name").fill(coin.name);
  await page.locator('input[type="file"]').setInputFiles(coinImage);
  await expect(page.getByText("No protected coin matches this ticker or name.")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launched" })).toBeVisible({ timeout: 150_000 });
  return { mint: (await page.locator("dd").first().textContent())!.trim(), wallet };
}

/**
 * Every error the page reports from now on, uncaught or logged: a hydration mismatch, a failed fetch, a crash. A spec
 * expects none.
 */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}
