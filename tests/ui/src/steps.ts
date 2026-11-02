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
/**
 * A coin's picture made for one run, drawn from `seed` in the page's canvas: shapes, colours and the seed's text, so no
 * two runs share a picture. Every Fair Open's coin becomes a protected Heat coin at its open (spec 6.2), so a picture
 * used twice would be refused as a copy of the first coin's, as would a name.
 */
export async function uniqueCoinImage(page: Page, seed: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate(async (seed) => {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const random = () => {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      return (h >>> 0) / 4294967296;
    };
    const size = 256;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    const hue = Math.floor(random() * 360);
    ctx.fillStyle = `hsl(${hue} 60% 20%)`;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = `hsl(${Math.floor(random() * 360)} ${50 + Math.floor(random() * 40)}% ${35 + Math.floor(random() * 40)}%)`;
      const x = random() * size;
      const y = random() * size;
      const r = 18 + random() * 70;
      ctx.beginPath();
      const kind = Math.floor(random() * 3);
      if (kind === 0) ctx.arc(x, y, r, 0, Math.PI * 2);
      else if (kind === 1) ctx.rect(x - r, y - r / 2, r * 2, r);
      else {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.lineTo(x - r, y + r);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.fillStyle = `hsl(${(hue + 180) % 360} 90% 85%)`;
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(seed.slice(-6), size / 2, size / 2 + 16);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }, seed);
  return { name: `${seed.toLowerCase()}.png`, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

/** A coin's name made for one run: a protected Heat coin's name is refused to every later launch, like its ticker. */
export const runName = (base: string, ticker: string) => `${base} ${ticker.slice(-5)}`;

/** Waits for Vamp Shield to clear the coin: its ticker, name and image, the image's check maybe waking the vision service. */
export async function expectVampClear(page: Page) {
  await expect(page.getByTestId("vamp-headline")).toHaveText("Clear", { timeout: 90_000 });
}

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
  // Every picture that will load, loaded: a coin's picture comes from its gateway a moment after the page.
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: 5_000 }).catch(() => undefined);
  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.colorScheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `${step}-${view.name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
}

/**
 * Links X as a new creator, launches an Instant launch signed by `creator`, and leaves the page on the Done step; with
 * `linked`, the browser has linked X already and the creator launches again. The coin's name gets the ticker's ending,
 * and its picture is drawn for the run (uniqueCoinImage).
 */
export async function launchCoin(
  page: Page,
  creator: KeyPairSigner,
  coin: { name: string; ticker: string },
  { linked = false }: { linked?: boolean } = {},
): Promise<{ mint: string; wallet: TestWallet }> {
  const wallet = await installTestWallet(page, creator);
  await page.goto("/launch");
  if (!linked) {
    await page.getByRole("link", { name: "Link X" }).click();
    await page.getByLabel("Handle").fill(newHandle());
    await page.getByRole("button", { name: "Authorize app" }).click();
  }
  await expect(page.getByRole("heading", { name: "How should your coin start trading?" })).toBeVisible();
  await page.getByRole("radio", { name: /Instant launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Ticker").fill(coin.ticker);
  await page.getByLabel("Name").fill(runName(coin.name, coin.ticker));
  await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, coin.ticker));
  await expectVampClear(page);
  await page.getByRole("button", { name: "Continue" }).click();
  // A creator launching again finds the wallet it connected before connected again on its own.
  if (!linked) await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
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
