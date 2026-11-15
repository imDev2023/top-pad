// The Fairness card end to end (#58's devnet demo, spec 9): on real devnet coins already on Heat (a Fair Open whose
// creator's coins were locked and whose Tax Share was paid, a graduated Instant launch, and a coin Bundle Radar flags
// red), every row the API states is recomputed from the chain (the open, creation, claim and collection transactions,
// the Jupiter Lock escrow, the DBC curve or the DAMM v2 positions, the Creator wallet's token accounts) and Postgres,
// then found on the coin page: the flags strip above the chart, each flag opening its row, and the whole card a tap away,
// opening with its counts, red first and its border red when there is any red. The coin page's link card tags name the
// card's image, which is fetched and checked: a 2:1 PNG under 5 MB, kept for good once drawn. Each step is photographed
// on a phone and a desktop, in both themes, for the pixel check. It reads only: no SOL is spent. No page may report an
// error.
import { expect, test, type Page } from "@playwright/test";
import { address, type Address } from "@solana/kit";
import { CLUSTERS, identityHash } from "@top-pad/chain";
import { fetchPosition } from "@top-pad/clients/damm-v2";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchVestingEscrow } from "@top-pad/clients/jupiter-lock";
import { CreatorRecord, FairnessCard, countsInOrder } from "@top-pad/contract";
import { bars, coins, coinRadar, createDb, fairOpens, fairOpenSeatEvents, graduations, trades } from "@top-pad/db";
import { decodeTransaction, radarOf, radarSummary } from "@top-pad/indexer";
import { coinBalance, landed, rpc } from "@top-pad/tests-devnet/devnet";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pageErrors, snap } from "./steps";
import { TARGET } from "./target";

const devnet = CLUSTERS.devnet!;
const shots = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "shots");
// The database the API reads: devnet's, or the local one; `E2E_DATABASE_URL` names another, for a local API on devnet's.
const database = () =>
  createDb(process.env.E2E_DATABASE_URL || (TARGET.name === "devnet" ? process.env.DATABASE_URL! : "postgres://toppad:toppad@127.0.0.1:5452/toppad"));
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000);

type Db = ReturnType<typeof createDb>["db"];

/** The coins the demo reads: the latest of each kind on devnet. */
async function pickCoins(db: Db) {
  const [fairOpen] = await db
    .select({ mint: fairOpens.mint })
    .from(fairOpens)
    .innerJoin(coins, eq(coins.mint, fairOpens.mint))
    .where(and(isNotNull(fairOpens.lockEscrow), isNotNull(fairOpens.taxShareCollectedAt), gt(fairOpens.seats, 1), eq(fairOpens.taxShareToTreasury, false)))
    .orderBy(desc(fairOpens.openedAt))
    .limit(1);
  const [graduated] = await db
    .select({ mint: coins.mint })
    .from(graduations)
    .innerJoin(coins, eq(coins.mint, graduations.mint))
    .where(eq(coins.launchMode, "instant"))
    .orderBy(desc(graduations.graduatedAt))
    .limit(1);
  // Red: wallets Bundle Radar links to the creator, or a published finding.
  const [linked] = await db
    .select({ mint: coins.mint })
    .from(coinRadar)
    .innerJoin(coins, eq(coins.mint, coinRadar.mint))
    .where(and(sql`cardinality(${coinRadar.linkedWallets}) > 0`, eq(coins.launchMode, "instant")))
    .orderBy(desc(coins.createdAt))
    .limit(1);
  expect(fairOpen?.mint, "a Fair Open whose creator's coins were locked and whose Tax Share was paid").toBeTruthy();
  expect(graduated?.mint, "a graduated Instant launch").toBeTruthy();
  expect(linked?.mint, "a coin Bundle Radar flags red").toBeTruthy();
  return { fairOpen: fairOpen!.mint!, graduated: graduated!.mint, red: linked!.mint };
}

/**
 * Every fact of the card recomputed from the chain and Postgres, and each row checked to state its own: the row's
 * words come from these facts alone (apps/api/src/fairness.ts), and `fairness.test.ts` checks the wording.
 */
async function recompute(db: Db, card: FairnessCard) {
  const { facts, mint } = card;
  const [coin] = await db.select().from(coins).where(eq(coins.mint, mint));
  const configs = new Set([coin!.config]);
  const wallet = coin!.creatorWallet;

  if (facts.launch.mode === "fair_open") {
    // The open on chain: the coin it created, hashed as its schedule sealed it, the pot's buy and its seats, sent and paid for by Heat's keeper.
    const raw = await landed(facts.launch.opened);
    expect(raw.meta?.err ?? null).toBeNull();
    const decoded = decodeTransaction(raw, configs);
    const created = decoded.pools.find((p) => p.mint === mint)!;
    const sealed = Buffer.from(await identityHash({ name: created.name, ticker: created.ticker, uri: created.uri })).toString("hex");
    expect(sealed).toBe(facts.launch.identityHash);
    const [row] = await db.select().from(fairOpens).where(eq(fairOpens.mint, mint));
    expect(row!.identityHash).toBe(sealed);
    const opened = decoded.fairOpenOpens[0]!;
    expect({ launch: opened.launch, people: opened.seats, spent: `${opened.spent}`, coins: `${opened.coins}` }).toEqual({
      launch: facts.launch.launch,
      people: facts.launch.people,
      spent: facts.launch.spent,
      coins: facts.launch.coins,
    });
    // Every seat got its coins: a delivery or the creator's lock each.
    const [delivered] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fairOpenSeatEvents)
      .where(and(eq(fairOpenSeatEvents.launch, opened.launch), inArray(fairOpenSeatEvents.kind, ["delivery", "lock"])));
    expect(delivered!.n).toBe(facts.launch.people);
    expect(raw.transaction.message.accountKeys[0]).toBe(devnet.keys!.keeper);
    expect(facts.keeper).toEqual({ address: devnet.keys!.keeper, signature: facts.launch.opened });

    // The Creator lock: the escrow on chain holds the creator's coins for them, cancellable by nobody, with the cliff and end stated.
    const lock = facts.creatorLock!;
    if (lock.status === "locked" && lock.escrow) {
      const escrow = (await fetchVestingEscrow(rpc, address(lock.escrow), { commitment: "confirmed" })).data;
      expect(escrow).toMatchObject({ recipient: wallet, tokenMint: mint, cancelMode: 0 });
      expect(`${escrow.cliffUnlockAmount + escrow.amountPerPeriod * escrow.numberOfPeriod}`).toBe(lock.coins);
      expect(escrow.cliffTime).toBe(seconds(lock.cliffAt!));
      expect(escrow.cliffTime + escrow.frequency * escrow.numberOfPeriod).toBe(seconds(lock.endsAt!));
      const [locked] = await db.select().from(fairOpenSeatEvents).where(and(eq(fairOpenSeatEvents.launch, opened.launch), eq(fairOpenSeatEvents.kind, "lock")));
      expect(`${locked!.deposit}`).toBe(lock.deposit);
    }

    // The Tax Share's collection on chain, and the seats Postgres saw paid.
    const tax = facts.tax;
    expect(tax.to).toBe("depositors");
    if (tax.to === "depositors" && tax.collected) {
      const collection = decodeTransaction(await landed(tax.collected.signature), configs).taxShares[0]!;
      expect({ total: `${collection.taxShare}`, toTreasury: collection.toTreasury }).toEqual({ total: tax.collected.total, toTreasury: tax.collected.toTreasury });
      const [paid] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(fairOpenSeatEvents)
        .where(and(eq(fairOpenSeatEvents.launch, opened.launch), eq(fairOpenSeatEvents.kind, "tax_share")));
      expect(paid!.n).toBe(tax.collected.paidSeats);
    }
  } else {
    // The creation on chain: whatever it bought, which an Instant launch through Heat never does.
    const creation = decodeTransaction(await landed(facts.launch.creation), configs);
    expect(creation.pools.some((p) => p.mint === mint)).toBe(true);
    const bought = creation.swaps.filter((s) => s.mint === mint && s.side === "buy").reduce((n, s) => n + s.baseAmount, 0n);
    expect(`${bought}`).toBe(facts.launch.creationBuy);
    expect(facts.creatorLock).toBeNull();
    expect(facts.keeper).toBeNull();
    // The window claim on chain: the first minute's tax to Heat.
    const tax = facts.tax;
    expect(tax.to).toBe("heat");
    if (tax.to === "heat" && tax.claimed) {
      const claim = decodeTransaction(await landed(tax.claimed.signature), configs).windowClaims.find((w) => w.mint === mint)!;
      expect(`${claim.amount}`).toBe(tax.claimed.amount);
    }
  }

  // What the Creator wallet holds now, from its token accounts, and what it bought on the pool, from the indexed trades.
  expect(facts.holdings.wallet).toBe(wallet);
  expect(facts.holdings.coins).toBe(`${await coinBalance(wallet as Address, mint as Address)}`);
  const [bought] = await db
    .select({ coins: sql<string>`coalesce(sum(${trades.baseAmount}), 0)::text` })
    .from(trades)
    .where(and(eq(trades.mint, mint), eq(trades.trader, wallet), eq(trades.side, "buy")));
  expect(facts.holdings.bought).toBe(bought!.coins);

  // Liquidity: still in a curve that has not migrated, or both DAMM v2 positions permanently locked.
  const [graduation] = await db.select().from(graduations).where(eq(graduations.mint, mint));
  if (graduation) {
    expect(facts.liquidity.graduated).toEqual({
      at: graduation.graduatedAt.toISOString(),
      pool: graduation.pool,
      creatorPosition: graduation.creatorPosition,
      heatPosition: graduation.heatPosition,
    });
    for (const position of [graduation.creatorPosition, graduation.heatPosition]) {
      const p = (await fetchPosition(rpc, address(position), { commitment: "confirmed" })).data;
      expect(p.pool).toBe(graduation.pool);
      expect(p.unlockedLiquidity).toBe(0n);
      expect(p.vestedLiquidity).toBe(0n);
      expect(p.permanentLockedLiquidity > 0n).toBe(true);
    }
  } else {
    expect(facts.liquidity.graduated).toBeNull();
    expect((await fetchVirtualPool(rpc, address(facts.liquidity.curve), { commitment: "confirmed" })).data.poolState.isMigrated).toBe(0);
  }

  // Bundle Radar from the indexed rows, a published finding from the Bars, and the record as its own page states it.
  const radar = radarSummary((await radarOf(db, mint))!);
  expect(facts.radar).toEqual({ linkedWallets: radar.linkedWallets.length, linkedCoins: `${radar.linkedCoins}`, earlyBuys: radar.earlyBuys });
  const published = await db.select().from(bars).where(and(eq(bars.mint, mint), isNull(bars.liftedAt), lte(bars.publishAt, new Date())));
  expect(facts.finding !== null).toBe(published.length > 0);
  if (facts.record) {
    const record = await api(`/creators/${facts.record.id}`, CreatorRecord);
    expect(facts.record).toMatchObject({ id: record.summary.id, coins: record.summary.coins, graduations: record.summary.graduations, barred: record.summary.barred });
  }

  // Each row's flag follows from its facts.
  const flag = Object.fromEntries(card.rows.map((r) => [r.key, r.flag]));
  expect(flag.radar).toBe(facts.radar.linkedWallets > 0 ? "red" : facts.radar.earlyBuys > 0 ? "yellow" : "neutral");
  expect(flag.liquidity).toBe(graduation ? "checkered" : "green");
  expect(flag.holdings).toBe(facts.holdings.coins === null ? "neutral" : BigInt(facts.holdings.coins) > 0n ? "yellow" : "green");
  expect(card.counts).toEqual({
    green: card.rows.filter((r) => r.flag === "green" || r.flag === "checkered").length,
    yellow: card.rows.filter((r) => r.flag === "yellow").length,
    red: card.rows.filter((r) => r.flag === "red").length,
  });
}

/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The coin page's link card tags as X reads them, from the page the server renders, and the image they name. */
async function checkLinkCard(card: FairnessCard, name: string) {
  const html = await (await fetch(`${TARGET.web}/coin/${card.mint}`)).text();
  const meta = (key: string) => new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html)?.[1]?.replaceAll("&amp;", "&");
  expect(meta("twitter:card")).toBe("summary_large_image");
  const image = meta("og:image")!;
  expect(meta("twitter:image")).toBe(image);
  expect(image).toMatch(new RegExp(`^${TARGET.api}/coins/${card.mint}/card\\.png\\?v=[0-9a-f]{16}$`));
  expect(meta("og:image:width")).toBe("1200");
  expect(meta("og:image:height")).toBe("600");
  expect(meta("og:description")).toContain(`Fairness card: ${countsInOrder(card.counts).map((c) => `${c.count} ${c.flag}`).join(", ")}.`);

  const first = await fetch(image);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("image/png");
  const png = Buffer.from(await first.arrayBuffer());
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(pngSize(png)).toEqual({ width: 1200, height: 600 });
  expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}-x-card.png`), png);
  // Drawn once, then kept in R2 for good: the same bytes, cached forever.
  await expect
    .poll(async () => {
      const again = await fetch(image);
      return again.headers.get("cache-control");
    })
    .toBe("public, max-age=31536000, immutable");
  expect(Buffer.from(await (await fetch(image)).arrayBuffer()).equals(png)).toBe(true);
}

/** The card on the coin page: a flag a row, each opening its row; then the whole card, opening with its counts. */
async function checkPage(page: Page, card: FairnessCard, name: string) {
  await page.goto(`/coin/${card.mint}`);
  const strip = page.getByRole("region", { name: "Fairness card" });
  await expect(strip.getByTestId("fairness-toggle")).toBeEnabled({ timeout: 30_000 });
  for (const r of card.rows) {
    if (r.key === "radar") {
      const radar = strip.getByTestId(card.facts.radar.linkedWallets > 0 ? "radar-linked" : card.facts.radar.earlyBuys > 0 ? "radar-same-slot" : "radar-clear");
      await expect(radar).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(strip.getByTestId(`fairness-flag-${r.key}`)).toHaveText(r.short);
      await expect(strip.getByTestId(`fairness-flag-${r.key}`)).toHaveAttribute("data-flag", r.flag);
    }
  }
  // The strip sits above the chart.
  const stripBox = (await strip.boundingBox())!;
  const chartBox = (await page.getByText("Market cap, SOL").boundingBox())!;
  expect(stripBox.y + stripBox.height).toBeLessThan(chartBox.y);
  await snap(page, `${name}-01-strip`);

  // A flag opens its row below the strip, and closes again.
  const launchFlag = strip.getByTestId("fairness-flag-launch");
  await launchFlag.click();
  const launchRow = card.rows.find((r) => r.key === "launch")!;
  await expect(strip.getByTestId("fairness-detail")).toContainText(launchRow.value);
  await expect(strip.getByTestId("fairness-detail")).toContainText(launchRow.detail);
  await snap(page, `${name}-02-flag-open`);
  await launchFlag.click();
  await expect(strip.getByTestId("fairness-detail")).toBeHidden();

  // The whole card: its counts first, red first when there is any, and every row with its words and links.
  await strip.getByTestId("fairness-toggle").click();
  const whole = strip.getByTestId("fairness-card");
  await expect(whole).toBeVisible();
  const order = countsInOrder(card.counts).map((c) => `${c.count} ${c.flag}`);
  await expect(whole.getByTestId("fairness-counts").locator(".chip")).toHaveText(order);
  for (const r of card.rows) {
    const row = whole.getByTestId(`fairness-row-${r.key}`);
    await expect(row).toContainText(r.title, { ignoreCase: true });
    await expect(row).toContainText(r.value);
    for (const link of r.links) await expect(row.getByRole("link", { name: link.label })).toBeVisible();
  }
  await expect(whole.getByRole("link", { name: "How this is enforced" })).toHaveAttribute("href", "/enforced");
  await expect(whole.getByTestId("fairness-image")).toHaveAttribute("href", card.image);
  const share = new URL((await whole.getByTestId("fairness-share-x").getAttribute("href"))!);
  expect(share.origin + share.pathname).toBe("https://x.com/intent/post");
  expect(share.searchParams.get("url")).toBe(`${TARGET.web}/coin/${card.mint}`);
  const red = card.counts.red > 0;
  await expect(whole).toHaveAttribute("data-red", String(red));
  const stop = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--stop").trim());
  const border = await whole.evaluate((e) => getComputedStyle(e).borderTopColor);
  const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  if (red) {
    expect(border).toBe(rgb(stop));
    await expect(whole.getByTestId("fairness-counts").locator(".chip").first()).toHaveText(`${card.counts.red} red`);
    await expect(whole.locator("li").first()).toHaveAttribute("data-flag", "red");
  } else {
    expect(border).not.toBe(rgb(stop));
  }
  await snap(page, `${name}-03-card`);
}

test.describe("the Fairness card on devnet coins", () => {
  test.setTimeout(600_000);

  test("a Fair Open's, a graduated Instant launch's and a red-flagged coin's cards: recomputed, on the page and as X link cards", async ({ page }) => {
    const { db, close } = database();
    const errors = pageErrors(page);
    try {
      const picked = await pickCoins(db);
      for (const [name, mint] of [
        ["fair-open", picked.fairOpen],
        ["instant-graduated", picked.graduated],
        ["red", picked.red],
      ] as const) {
        await test.step(name, async () => {
          const card = await api(`/coins/${mint}/fairness`, FairnessCard);
          console.log(`${name}: ${mint}, ${countsInOrder(card.counts).map((c) => `${c.count} ${c.flag}`).join(", ")}`);
          await recompute(db, card);
          if (name === "fair-open") expect(card.rows.map((r) => r.key)).toEqual(expect.arrayContaining(["launch", "creator_lock", "holdings", "liquidity", "radar", "creator", "keeper", "tax"]));
          if (name === "instant-graduated") expect(card.rows.find((r) => r.key === "liquidity")!.flag).toBe("checkered");
          if (name === "red") expect(card.counts.red).toBeGreaterThan(0);
          await checkPage(page, card, name);
          await checkLinkCard(card, name);
        });
      }
    } finally {
      await close();
    }
    expect(errors).toEqual([]);
  });
});
