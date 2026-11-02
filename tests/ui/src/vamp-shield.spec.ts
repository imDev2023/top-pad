// Vamp Shield's images and the protected set (spec 6.2, #52), on the launch flow: a launch using a Protected coin's
// picture rotated or mirrored, or its folded ticker, is refused, with an appeal link; a near one launches labelled
// "looks like X", the label on its coin page and on its creator's coin row; and a protected Heat coin's ticker is
// refused to a new launch. The Protected coins are the protected set's own, read from the database the deployed site
// uses (`direnv exec` gives DATABASE_URL), so the protected set must have refreshed, its images signed. Each step is
// photographed on a phone and a desktop in both themes for the pixel check, and the image check's answer times, woken
// and warm, are logged.
import { expect, test, type Page } from "@playwright/test";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { ImageVerdict, LaunchRefusal, VampShieldVerdict } from "@top-pad/contract";
import { createDb, protectedCoins, protectedImages } from "@top-pad/db";
import { fundedWallets } from "@top-pad/tests-devnet/devnet";
import { expectVampClear, newHandle, newTicker, pageErrors, runName, snap, uniqueCoinImage } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const database = () => createDb(TARGET.name === "devnet" ? process.env.DATABASE_URL! : "postgres://toppad:toppad@127.0.0.1:5452/toppad");
const protectsNow = sql`${protectedCoins.protectedFrom} <= now() and (${protectedCoins.protectedUntil} is null or ${protectedCoins.protectedUntil} > now())`;

/** A Protected coin to copy: verified on Jupiter, its picture signed and PDQ-hashable, its ticker a short one. */
async function protectedToCopy() {
  const { db, close } = database();
  try {
    const rows = await db
      .select({ mint: protectedCoins.mint, ticker: protectedCoins.ticker, name: protectedCoins.name, imageUrl: protectedCoins.imageUrl })
      .from(protectedCoins)
      .innerJoin(protectedImages, eq(protectedImages.url, protectedCoins.imageUrl))
      .where(and(eq(protectedCoins.source, "jupiter_verified"), eq(protectedImages.status, "done"), isNotNull(protectedImages.pdq), protectsNow, sql`${protectedCoins.ticker} ~ '^[A-Za-z]{3,5}$'`))
      .orderBy(desc(sql`coalesce((${protectedCoins.details}->>'mcap')::float8, 0)`))
      .limit(20);
    // BONK when the set has it, a coin every Solana trader knows; else the largest such coin.
    return rows.find((r) => r.ticker.toUpperCase() === "BONK") ?? rows[0]!;
  } finally {
    await close();
  }
}

/** A protected Heat coin, with a ticker a launch could otherwise take. */
async function protectedHeatCoin() {
  const { db, close } = database();
  try {
    const [row] = await db
      .select({ mint: protectedCoins.mint, ticker: protectedCoins.ticker, name: protectedCoins.name })
      .from(protectedCoins)
      .where(and(eq(protectedCoins.source, "heat"), protectsNow, sql`${protectedCoins.ticker} ~ '^[A-Z0-9]{2,10}$'`))
      .orderBy(desc(protectedCoins.createdAt))
      .limit(1);
    return row!;
  } finally {
    await close();
  }
}

/** A picture redrawn in the page's canvas: turned a quarter, or mirrored, as a copier would. */
async function transformed(page: Page, bytes: Buffer, how: "rotate" | "mirror") {
  const base64 = await page.evaluate(
    async ({ b64, how }) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw]));
      const side = Math.min(512, Math.max(bitmap.width, bitmap.height));
      const scale = side / Math.max(bitmap.width, bitmap.height);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(how === "rotate" ? h : w, how === "rotate" ? w : h);
      const ctx = canvas.getContext("2d")!;
      if (how === "rotate") {
        ctx.translate(h, 0);
        ctx.rotate(Math.PI / 2);
      } else {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/webp", quality: 0.9 })).arrayBuffer());
      let binary = "";
      for (const b of out) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    { b64: bytes.toString("base64"), how },
  );
  return { name: `copy-${how}.webp`, mimeType: "image/webp", buffer: Buffer.from(base64, "base64") };
}

/** Lookalike letters for a ticker, as a copier types it: O as 0, I as 1, else the ticker itself, which folds the same. */
const folded = (ticker: string) => {
  const up = ticker.toUpperCase();
  return up.includes("O") ? up.replace("O", "0") : up.includes("I") ? up.replace("I", "1") : up;
};

/** Picks the image file, waits for the image's verdict, and returns it with how long the page waited. */
async function pickImage(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const started = Date.now();
  const answer = page.waitForResponse((r) => r.url().endsWith("/vamp-shield/image"), { timeout: 120_000 });
  await page.locator('input[type="file"]').setInputFiles(file);
  const res = await answer;
  const verdict = ImageVerdict.parse(await res.json());
  return { verdict, waitedMs: Date.now() - started };
}

test("Vamp Shield refuses copies of a Protected coin and labels a near one", async ({ browser, page }) => {
  test.setTimeout(600_000);
  const errors = pageErrors(page);
  const copied = await protectedToCopy();
  // The label names the most authoritative protected coin: for a ticker CoinGecko lists too, its Jupiter-verified spelling.
  const label = new RegExp(`\\$${copied.ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const labelled = (before: string, after = "") => new RegExp(`^${before}${label.source}${after}$`, "i");
  console.log(`copying ${copied.name} ($${copied.ticker}, ${copied.mint}), picture ${copied.imageUrl}`);
  const logo = Buffer.from(await (await fetch(copied.imageUrl!)).arrayBuffer());

  const [creator] = await fundedWallets(40_000_000n);
  const wallet = await installTestWallet(page, creator);
  await page.goto("/launch");
  await page.getByRole("link", { name: "Link X" }).click();
  await page.getByLabel("Handle").fill(newHandle());
  await page.getByRole("button", { name: "Authorize app" }).click();
  await page.getByRole("radio", { name: /Instant launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your coin" })).toBeVisible();

  // The folded ticker: refused by its strict key, the protected coin shown with where to see it, and an appeal link.
  const ticker = newTicker();
  await page.getByLabel("Ticker").fill(folded(copied.ticker));
  await page.getByLabel("Name").fill(runName("Vamp Check", ticker));
  await expect(page.getByTestId("vamp-ticker")).toContainText("Refused");
  await expect(page.getByTestId("vamp-headline")).toHaveText(labelled("Refused: copies "));
  await expect(page.getByTestId("vamp-appeal")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await snap(page, "vamp-1-ticker-refused");

  // The picture turned a quarter: refused by PDQ over its 8 orientations. The first check may wake the vision service.
  await page.getByLabel("Ticker").fill(ticker);
  const rotated = await pickImage(page, await transformed(page, logo, "rotate"));
  console.log(`image check, rotated copy: answered in ${rotated.verdict.answerMs} ms, woke ${rotated.verdict.woke}, the page waited ${rotated.waitedMs} ms`);
  expect(rotated.verdict.verdict.status).toBe("refused");
  await expect(page.getByTestId("vamp-image")).toContainText("Refused");
  await expect(page.getByTestId("vamp-image")).toContainText(/rotated|copy detection/);
  await expect(page.getByTestId("vamp-headline")).toHaveText(labelled("Refused: copies "));
  await snap(page, "vamp-2-image-rotated-refused");

  // Mirrored: refused too.
  const mirrored = await pickImage(page, await transformed(page, logo, "mirror"));
  console.log(`image check, mirrored copy: answered in ${mirrored.verdict.answerMs} ms, woke ${mirrored.verdict.woke}, the page waited ${mirrored.waitedMs} ms`);
  expect(mirrored.verdict.verdict.status).toBe("refused");
  await expect(page.getByTestId("vamp-image")).toContainText(/mirrored|copy detection/);
  await snap(page, "vamp-3-image-mirrored-refused");

  // The launch service refuses it too when the page is bypassed: our launch key declines to co-sign.
  const bypass = await page.request.post(`${TARGET.api}/launches`, {
    headers: { origin: TARGET.web },
    multipart: { mode: "instant", name: runName("Vamp Check", ticker), ticker, wallet: creator.address, image: await transformed(page, logo, "mirror") },
  });
  expect(bypass.status()).toBe(422);
  expect(LaunchRefusal.parse(await bypass.json())).toMatchObject({ code: "vamp_shield", imageVerdict: { status: "refused" } });

  // The appeal link: what was refused, and the appeal to the operator queue.
  const appeal = await browser.newPage({ storageState: await page.context().storageState() });
  await appeal.goto(new URL((await page.getByTestId("vamp-appeal").getAttribute("href"))!, TARGET.web).toString());
  await expect(appeal.getByRole("heading", { name: "Appeal a refusal" })).toBeVisible();
  await appeal.getByLabel("Why the refusal is wrong").fill("E2E: an appeal sent by the Vamp Shield demo, to be denied.");
  await snap(appeal, "vamp-4-appeal");
  await appeal.getByRole("button", { name: "Send the appeal" }).click();
  await expect(appeal.getByTestId("appeal-sent")).toBeVisible();
  await snap(appeal, "vamp-5-appeal-sent");
  await appeal.close();

  // A near one: the protected ticker with a derivative word, which launches labelled "looks like".
  let near = "";
  for (const affix of ["BABY", "MINI", "KING", "LIL"]) {
    const candidate = `${affix}${copied.ticker.toUpperCase()}`.slice(0, 10);
    const res = await page.request.post(`${TARGET.api}/vamp-shield/check`, { headers: { origin: TARGET.web }, data: { ticker: candidate, name: "Frog" } });
    const verdict = VampShieldVerdict.parse(await res.json());
    if (verdict.clear && verdict.verdicts.ticker.status === "looks_like") {
      near = candidate;
      break;
    }
  }
  expect(near, "a derivative ticker no coin holds").not.toBe("");
  await page.getByLabel("Ticker").fill(near);
  await page.getByLabel("Name").fill(runName("Vamp Near", ticker));
  const fresh = await pickImage(page, await uniqueCoinImage(page, ticker));
  console.log(`image check, a fresh picture: answered in ${fresh.verdict.answerMs} ms, woke ${fresh.verdict.woke}, the page waited ${fresh.waitedMs} ms`);
  await expect(page.getByTestId("vamp-headline")).toHaveText(labelled('Launches labelled "Looks like ', '"'));
  await expect(page.getByTestId("vamp-ticker")).toContainText(new RegExp(`Looks like ${label.source}`, "i"));
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await snap(page, "vamp-6-near-labelled");

  await page.getByRole("button", { name: "Continue" }).click();
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launched" })).toBeVisible({ timeout: 150_000 });
  expect(wallet.requests).toHaveLength(1);
  await page.getByRole("link", { name: "Watch it trade" }).click();

  // The label on the coin's page, opening why.
  const flag = page.getByTestId("looks-like-flag");
  await expect(flag).toHaveText(labelled("Looks like "), { timeout: 60_000 });
  await flag.click();
  await expect(page.getByTestId("looks-like-panel")).toContainText(new RegExp(`Its ticker builds on ${label.source}`, "i"));
  await snap(page, "vamp-7-coin-page-label");

  // And on the creator's coin row, the wallet that launched it connected.
  await page.goto("/creator");
  const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
  const chip = page.getByTestId("looks-like-chip").first();
  await expect(chip.or(connect)).toBeVisible({ timeout: 60_000 });
  if (await connect.isVisible()) await connectTestWallet(page, connect);
  await expect(chip).toHaveText(labelled("Looks like "), { timeout: 60_000 });
  await snap(page, "vamp-8-creator-row-label");

  // A protected Heat coin's ticker: refused to a new launch, by the strict key the unique index also holds.
  const heat = await protectedHeatCoin();
  console.log(`protected Heat coin: ${heat.name} ($${heat.ticker}, ${heat.mint})`);
  await page.goto("/launch");
  await page.getByRole("radio", { name: /Instant launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Ticker").fill(heat.ticker);
  await page.getByLabel("Name").fill(runName("Heat Copy", ticker));
  await expect(page.getByTestId("vamp-ticker")).toContainText("Refused");
  await expect(page.getByTestId("vamp-headline")).toHaveText(`Refused: copies $${heat.ticker}`);
  await snap(page, "vamp-9-heat-coin-refused");
  const heatBypass = await page.request.post(`${TARGET.api}/launches`, {
    headers: { origin: TARGET.web },
    multipart: { mode: "instant", name: runName("Heat Copy", ticker), ticker: heat.ticker, wallet: creator.address, image: await uniqueCoinImage(page, `${ticker}H`) },
  });
  expect(heatBypass.status()).toBe(422);
  expect(LaunchRefusal.parse(await heatBypass.json()).verdict?.verdicts.ticker).toMatchObject({ status: "refused", match: { mint: heat.mint, source: "heat" } });

  // A clear coin still launches as before.
  await page.getByLabel("Ticker").fill(`${ticker.slice(0, 7)}OK`);
  await page.getByLabel("Name").fill(runName("Vamp Clear", ticker));
  await page.locator('input[type="file"]').setInputFiles(await uniqueCoinImage(page, `${ticker}C`));
  await expectVampClear(page);
  await snap(page, "vamp-10-clear");
  expect(errors).toEqual([]);
});
