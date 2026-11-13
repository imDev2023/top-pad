// The Creator record end to end (#55's devnet demo, spec 7 and 9 screen 5): a creator who linked X launches an Instant
// coin, sells some of it from the Creator wallet and claims their earnings; hands the coin's creator role to another
// creator's wallet from their page; a rotation of their Creator wallet through X is asked for from another browser and
// cancelled by the Creator wallet; then they hand their Creator wallet over, the old wallet offering and the new one
// taking, each signing one message. The record shows both, the coin stays on it marked "handed over to ...", the other
// record shows it handed over to it, and the next earnings claim pays the new role holder. Every fact on the record is
// then recomputed from the chain and Postgres and matched to the API and the page, and each step is photographed on a
// phone and a desktop, in both themes, for the pixel check. Real devnet SOL: about 0.08 a run. No page may report an error.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { address, generateKeyPairSigner, getBase58Encoder, getPublicKeyFromAddress, verifySignature, type Address, type KeyPairSigner, type SignatureBytes } from "@solana/kit";
import { CLUSTERS, creatorShare } from "@top-pad/chain";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import { Coin, CreatorEarnings, CreatorRecord } from "@top-pad/contract";
import { coins, createDb, creatorWallets, fairOpens, feeClaims, graduations, launches, lpFeeClaims, poolCreatorTransfers, trades } from "@top-pad/db";
import { coinBalance, fundedWallets, landed, rpc, swap, sweep } from "@top-pad/tests-devnet/devnet";
import { decodeTransaction } from "@top-pad/indexer";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { launchCoin, newTicker, pageErrors, short, signInOnLaunch, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const devnet = CLUSTERS.devnet!;
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
const database = () => createDb(TARGET.name === "devnet" ? process.env.DATABASE_URL! : "postgres://toppad:toppad@127.0.0.1:5452/toppad");
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
const partnerFees = async (pool: Address) => (await fetchVirtualPool(rpc, pool)).data.poolState.partnerQuoteFee;
/** The SOL a page writes for a raw amount: every lamport, as the creator's page and the record show it. */
const shown = (raw: bigint) => `${(Number(raw) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
/** A transaction's network fee: one signature, no priority fee. */
const NETWORK_FEE = 5_000n;
const verifies = async (wallet: string, message: string, base58: string) =>
  verifySignature(await getPublicKeyFromAddress(wallet as Address), getBase58Encoder().encode(base58) as SignatureBytes, new TextEncoder().encode(message));

/** A page in a browser of its own with `signer`'s test wallet, in the desktop's dark view. */
async function browserOf(browser: Browser, signer: KeyPairSigner) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors = pageErrors(page);
  await installTestWallet(page, signer);
  return { page, errors };
}

/** Opens the creator's page with the page's test wallet connected, and waits for its earnings to load. */
async function openCreatorPage(page: Page) {
  await page.goto("/creator");
  const waiting = page.getByTestId("earnings-waiting");
  const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
  await expect(waiting.or(connect)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await connectTestWallet(page, connect);
  await expect(waiting).toBeVisible({ timeout: 30_000 });
}

/** Opens a record's page, connecting the page's wallet if it is not, and waits for its facts. */
async function openRecord(page: Page, key: string) {
  await page.goto(`/creator/${key}`);
  await expect(page.getByTestId("fact-launches")).toBeVisible({ timeout: 30_000 });
}

/**
 * Every fact on a record recomputed from the chain and Postgres, apart from the API's code, and matched to the record the
 * API answers and to what its page shows (#55's third criterion).
 */
async function recomputeAndMatch(page: Page, key: string) {
  const record = await api(`/creators/${key}`, CreatorRecord);
  const { db, close } = database();
  try {
    const id = record.summary.id;
    const wallets = await db.select().from(creatorWallets).where(eq(creatorWallets.creatorId, id)).orderBy(asc(creatorWallets.startedAt));
    const own = wallets.map((w) => w.wallet);
    // Each Creator wallet proves itself: its signature over the message it signed.
    for (const w of wallets) if (w.proofMessage) expect(await verifies(w.wallet, w.proofMessage, w.proof)).toBe(true);
    expect(record.wallets.map((w) => [w.wallet, w.via, w.until === null])).toEqual(wallets.map((w) => [w.wallet, w.via, w.endedAt === null]));
    expect(record.summary.wallet).toBe(wallets.find((w) => !w.endedAt)?.wallet ?? null);
    for (const change of record.changes) {
      if (change.fromSignature) expect(await verifies(change.from, change.message, change.fromSignature)).toBe(true);
      if (change.toSignature) expect(await verifies(change.to, change.message, change.toSignature)).toBe(true);
      if (change.cancelSignature) expect(await verifies(change.from, change.cancelMessage!, change.cancelSignature)).toBe(true);
    }

    // Its coins: each one its launch made, registered on chain by the fee program in that mode.
    const launched = await db.select().from(coins).where(eq(coins.creatorId, id)).orderBy(desc(coins.createdAt));
    expect(record.coins.map((c) => c.mint)).toEqual(launched.map((c) => c.mint));
    let graduated = 0;
    let handedOver = 0;
    for (const coin of launched) {
      const shownCoin = record.coins.find((c) => c.mint === coin.mint)!;
      const onChain = await fetchCoinRecord(rpc, (await findCoinRecordPda({ mint: address(coin.mint) }))[0]);
      expect(onChain.data.launchMode === 0 ? "instant" : "fair_open").toBe(shownCoin.launchMode);
      // The creator role, read from DBC's pool, and every hand-over of it re-read from its transaction.
      const pool = await fetchVirtualPool(rpc, address(coin.pool));
      expect(shownCoin.role.holder).toBe(pool.data.poolState.creator);
      expect(shownCoin.role.handedOver).toBe(!own.includes(pool.data.poolState.creator));
      if (shownCoin.role.handedOver) handedOver++;
      const transfers = await db.select().from(poolCreatorTransfers).where(eq(poolCreatorTransfers.pool, coin.pool)).orderBy(asc(poolCreatorTransfers.slot));
      for (const t of transfers) {
        expect(decodeTransaction(await landed(t.signature), HEAT).creatorTransfers).toContainEqual(expect.objectContaining({ pool: coin.pool, from: t.fromWallet, to: t.toWallet }));
      }
      expect(transfers.at(-1)?.toWallet ?? coin.creatorWallet).toBe(pool.data.poolState.creator);
      // Graduated: DBC says the curve migrated, and Heat recorded its Graduation.
      const [graduation] = await db.select().from(graduations).where(eq(graduations.mint, coin.mint));
      expect(pool.data.poolState.isMigrated === 1).toBe(!!graduation);
      expect(shownCoin.state === "graduated").toBe(!!graduation);
      if (graduation) graduated++;
      // The Creator wallets' sells, each re-read from its transaction.
      const sells = await db.select().from(trades).where(and(eq(trades.mint, coin.mint), eq(trades.side, "sell"), inArray(trades.trader, own)));
      let sold = 0n;
      let fetched = 0n;
      for (const s of sells) {
        const swapOnChain = decodeTransaction(await landed(s.signature), HEAT).swaps[s.eventIndex]!;
        expect(swapOnChain).toMatchObject({ trader: s.trader, side: "sell", baseAmount: s.baseAmount, quoteAmount: s.quoteAmount });
        sold += swapOnChain.baseAmount;
        fetched += swapOnChain.quoteAmount;
      }
      expect(shownCoin.sells).toEqual({ count: sells.length, coins: `${sold}`, quote: `${fetched}` });
      const [fairOpen] = await db.select().from(fairOpens).where(eq(fairOpens.mint, coin.mint));
      expect(shownCoin.lock === null).toBe(!fairOpen);
    }
    expect(record.summary).toMatchObject({
      coins: launched.length,
      graduations: graduated,
      graduationRate: launched.length ? graduated / launched.length : null,
      handedOver,
    });
    expect(record.launches.instant).toBe(launched.filter((c) => c.launchMode === "instant").length);
    const scheduled = await db
      .select({ status: fairOpens.status, failure: fairOpens.failure })
      .from(fairOpens)
      .innerJoin(launches, eq(launches.fairOpen, fairOpens.launch))
      .where(eq(launches.creatorId, id));
    expect(record.launches.fairOpen.failed).toBe(scheduled.filter((f) => f.failure).length);

    // What claims paid its wallets, each re-read from its transaction.
    const claims = own.length ? await db.select().from(feeClaims).where(inArray(feeClaims.creator, own)) : [];
    let curve = 0n;
    for (const claim of claims) {
      const decoded = decodeTransaction(await landed(claim.signature), HEAT).feeClaims[claim.eventIndex]!;
      expect(decoded).toMatchObject({ creator: claim.creator, creatorAmount: claim.creatorAmount });
      curve += decoded.creatorAmount;
    }
    const lp = own.length ? await db.select().from(lpFeeClaims).where(inArray(lpFeeClaims.owner, own)) : [];
    const lpPaid = lp.reduce((sum, l) => sum + l.quoteAmount, 0n);
    expect(record.earnings).toEqual({ claimed: `${curve + lpPaid}`, curve: `${curve}`, lp: `${lpPaid}` });

    // Coins another record launched whose role a wallet of this one holds now.
    const toOwn = own.length ? await db.select().from(poolCreatorTransfers).where(inArray(poolCreatorTransfers.toWallet, own)) : [];
    const theirs = toOwn.length ? await db.select().from(coins).where(inArray(coins.pool, toOwn.map((t) => t.pool))) : [];
    const received = [];
    for (const coin of theirs.filter((c) => c.creatorId !== id)) {
      const holder = (await fetchVirtualPool(rpc, address(coin.pool))).data.poolState.creator;
      if (own.includes(holder)) received.push(coin.mint);
    }
    expect(record.received.map((r) => r.mint).sort()).toEqual(received.sort());

    // The page says the same.
    await openRecord(page, key);
    await expect(page.getByTestId("fact-launches")).toContainText(`${record.launches.instant} Instant · ${record.launches.fairOpen.opened} Fair Open`);
    await expect(page.getByTestId("fact-graduations")).toContainText(
      record.summary.graduationRate === null ? "No coin yet" : `${graduated} of ${launched.length} (${Math.round(record.summary.graduationRate * 100)}%)`,
    );
    await expect(page.getByTestId("fact-handed-over")).toContainText(`${handedOver}`);
    await expect(page.getByTestId("fact-quiet")).toContainText(`${record.summary.quiet}`);
    await expect(page.getByTestId("fact-sells")).toContainText(`${record.coins.reduce((n, c) => n + c.sells.count, 0)}`);
    await expect(page.getByTestId("fact-claimed")).toContainText(shown(curve + lpPaid));
    await expect(page.getByTestId("record-coin")).toHaveCount(launched.length);
    await expect(page.getByTestId("received-coin")).toHaveCount(received.length);
    await expect(page.getByTestId("record-wallet-row")).toHaveCount(wallets.length);
    if (record.summary.wallet) await expect(page.getByTestId("record-wallet")).toHaveText(short(record.summary.wallet));
    return record;
  } finally {
    await close();
  }
}

test("a creator hands over a coin's creator role and their Creator wallet; the record shows both, and the next claim pays the new holder", async ({ page, browser }) => {
  test.setTimeout(20 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, heir, trader] = await fundedWallets(60_000_000n, 10_000_000n, 300_000_000n);
  const [successor, rotated] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const others: string[][] = [];
  let launched: Address | null = null;
  try {
    // The creator links X and launches; the heir is another creator, signed in with a wallet only.
    const { mint, handle } = await launchCoin(page, creator, { name: "Heat Record", ticker: newTicker() }, { linkX: true, looksLike: true });
    launched = address(mint);
    const coin = await expect
      .poll(async () => (await fetch(`${TARGET.api}/coins/${mint}`)).status, { timeout: 60_000 })
      .toBe(200)
      .then(() => api(`/coins/${mint}`, Coin));
    const pool = address(coin.pool);
    const heirSide = await browserOf(browser, heir);
    others.push(heirSide.errors);
    await heirSide.page.goto("/launch");
    await signInOnLaunch(heirSide.page);

    // A buy pays the sniper tax, which the keeper's window claim takes for the treasury at 60 s.
    await swap(trader, address(mint), "buy", 20_000_000n);
    await expect.poll(async () => (await api(`/coins/${mint}`, Coin)).windowClaim, { timeout: 150_000, intervals: [3_000] }).not.toBeNull();
    // Then the Creator wallet buys and sells half, and a trader's buy leaves Creator Earnings.
    await swap(creator, address(mint), "buy", 10_000_000n);
    await swap(creator, address(mint), "sell", (await coinBalance(creator.address, address(mint))) / 2n);
    await swap(trader, address(mint), "buy", 80_000_000n);

    // The record's page, once the indexer has the sell: the coin's summary links to it.
    await expect
      .poll(async () => (await api(`/creators/${creator.address}`, CreatorRecord)).coins[0]?.sells.count, { timeout: 90_000, intervals: [2_000] })
      .toBe(1);
    await page.goto(`/coin/${mint}`);
    const summary = page.getByTestId("creator-summary");
    await expect(summary).toContainText(`@${handle}`);
    await snap(page, "record-1-coin-summary");
    await summary.getByRole("link", { name: "See the Creator record" }).click();
    await expect(page.getByTestId("record-name")).toHaveText(`@${handle}`);
    const recordId = page.url().split("/creator/")[1]!;
    await expect(page.getByTestId("fact-sells")).toContainText("1");
    await snap(page, "record-2-own-record");

    // The creator claims what waits, then hands the coin's creator role to the heir from their page.
    await openCreatorPage(page);
    const fees = await partnerFees(pool);
    await page.getByRole("button", { name: `Claim ${shown(creatorShare(fees))}` }).click();
    await expect(page.getByRole("status")).toContainText(`Claimed ${shown(creatorShare(fees))}`, { timeout: 60_000 });
    await page.getByTestId("earnings-coin").getByRole("button", { name: "Hand over creator role" }).click();
    await page.getByLabel(`Hand ${coin.ticker}'s creator role to`).fill(heir.address);
    await snap(page, "record-3-role-handover-form");
    await page.getByRole("button", { name: "Sign and hand over" }).click();
    await expect(page.getByTestId("earnings-coin")).toHaveCount(0, { timeout: 60_000 });
    expect((await fetchVirtualPool(rpc, pool)).data.poolState.creator).toBe(heir.address);

    // A rotation through X is asked for from another browser signed in by X alone, to a new wallet...
    const rotationSide = await browserOf(browser, rotated);
    others.push(rotationSide.errors);
    await rotationSide.page.goto(`${TARGET.api}/auth/x/start?return=/creator`);
    await rotationSide.page.getByLabel("Handle").fill(handle!);
    await rotationSide.page.getByRole("button", { name: "Authorize app" }).click();
    await openCreatorPage(rotationSide.page);
    await expect(rotationSide.page.getByTestId("rotation-panel")).toContainText(`@${handle}`);
    await snap(rotationSide.page, "record-4-rotation-offered");
    await rotationSide.page.getByRole("button", { name: "Rotate to this wallet" }).click();
    await expect(rotationSide.page.getByTestId("rotation-requested")).toBeVisible();
    await snap(rotationSide.page, "record-5-rotation-requested");
    // ...public on the record at once, and cancelled there by the Creator wallet.
    await openRecord(page, recordId);
    await expect(page.getByTestId("pending-change")).toContainText(`A rotation through X to ${short(rotated.address)} takes effect on`);
    await snap(page, "record-6-rotation-pending");
    await page.getByRole("button", { name: "Cancel this rotation" }).click();
    await expect(page.getByTestId("pending-change")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("ended-change")).toContainText("Cancelled");

    // The Creator wallet is handed over: the old wallet offers, the new one takes it on its own page.
    await page.getByLabel("New Creator wallet").fill(successor.address);
    await snap(page, "record-7-handover-form");
    await page.getByRole("button", { name: "Sign the handover" }).click();
    await expect(page.getByTestId("pending-change")).toContainText(`A handover to ${short(successor.address)} waits for that wallet's signature`);
    await snap(page, "record-8-handover-offered");
    const successorSide = await browserOf(browser, successor);
    others.push(successorSide.errors);
    await openCreatorPage(successorSide.page);
    await expect(successorSide.page.getByTestId("handover-offer")).toContainText(`@${handle}`);
    await snap(successorSide.page, "record-9-handover-offer");
    await successorSide.page.getByRole("button", { name: "Take the Creator wallet" }).click();
    await expect(successorSide.page.getByRole("status")).toContainText(`This wallet is the Creator wallet of @${handle} now`);
    await snap(successorSide.page, "record-10-handover-taken");

    // The record shows both: the new Creator wallet with its history, and the coin handed over to the heir's record.
    await openRecord(page, recordId);
    await expect(page.getByTestId("record-wallet")).toHaveText(short(successor.address));
    await expect(page.getByTestId("record-wallet-row")).toHaveCount(2);
    await expect(page.getByTestId("handed-over")).toContainText(`Creator role handed over to ${short(heir.address)}`);
    await page.getByTestId("record-wallet-row").first().getByText("The signed message").click();
    await snap(page, "record-11-record-after");
    await openRecord(heirSide.page, heir.address);
    await expect(heirSide.page.getByTestId("received-coin")).toContainText(`Handed over by @${handle}`);
    await snap(heirSide.page, "record-12-heir-record");

    // The next claim pays the role's new holder.
    await swap(trader, address(mint), "buy", 40_000_000n);
    await openCreatorPage(heirSide.page);
    const inherited = await partnerFees(pool);
    const listed = await api(`/earnings/${heir.address}`, CreatorEarnings);
    expect(listed.coins).toEqual([expect.objectContaining({ mint, waiting: creatorShare(inherited).toString() })]);
    const before = await lamports(heir.address);
    await heirSide.page.getByRole("button", { name: `Claim ${shown(creatorShare(inherited))}` }).click();
    await expect(heirSide.page.getByRole("status")).toContainText(`Claimed ${shown(creatorShare(inherited))}`, { timeout: 60_000 });
    expect(await lamports(heir.address)).toBe(before + creatorShare(inherited) - NETWORK_FEE);
    await snap(heirSide.page, "record-13-heir-claimed");

    // Every fact on both records, recomputed from the chain and Postgres, matches the API and the page.
    const launcherRecord = await recomputeAndMatch(page, recordId);
    expect(launcherRecord.summary).toMatchObject({ coins: 1, handedOver: 1, wallet: successor.address });
    expect(BigInt(launcherRecord.earnings.claimed)).toBe(creatorShare(fees));
    const heirRecord = await recomputeAndMatch(heirSide.page, heir.address);
    expect(heirRecord.received).toEqual([expect.objectContaining({ mint, holder: heir.address, launcher: expect.objectContaining({ id: recordId, handle }) })]);
    expect(BigInt(heirRecord.earnings.claimed)).toBe(creatorShare(inherited));
    await openRecord(page, recordId);
    await snap(page, "record-14-recomputed");

    expect([...errors, ...others.flat()]).toEqual([]);
  } finally {
    // The trader's coins back to SOL, then every wallet's SOL back to the bank.
    const held = launched ? await coinBalance(trader.address, launched).catch(() => 0n) : 0n;
    if (launched && held > 0n) await swap(trader, launched, "sell", held).catch((e) => console.warn("the trader's coins could not be sold back", e));
    await sweep(trader, creator, heir);
  }
});
