// Bundle Radar (spec 6.4, 6.5; #53's devnet demo): a creator funds 4 wallets directly, launches an Instant launch from
// the site, and the Creator wallet and those 4 wallets buy in its creation slot, as a bundler would; a sniper with no
// link to the creator buys there too. Within seconds the coin's page flags the 4 linked wallets red and the same-slot
// buys yellow, each with its evidence. Past the sniper tax the 4 wallets buy on until they hold over 1% of supply between
// them, then everyone sells, 2 minutes after the open. An hour after the open the case job opens a case with its
// evidence pack, holding the 4 linked wallets and never the sniper. Devnet runs no Jito block engine, and on Heat our
// launch key sends the creation itself, so the bundle's buys are signed in advance and sent again and again, a lamport
// apart, as the launch goes out (tests/devnet's bundle.ts). Real devnet SOL: about 0.06 a run, most of it the pool's
// rent and the creation slot's 99% tax. It waits out the hour: about 70 minutes, holding no SOL once the sells are done.
// Run it alone as `bundle-radar.spec.ts`: a filter of `bundle-radar` alone matches every spec in a checkout whose folder
// name holds it. Its wallets derive from the bank's key and the run's name, which it logs, so a run stopped partway is
// swept back with `pnpm exec tsx tests/devnet/src/bundle-sweep.ts <run> <mint>`.
import { expect, test, type Page } from "@playwright/test";
import { address, type Address, type KeyPairSigner, type Signature } from "@solana/kit";
import { BundleRadar, PreparedLaunch } from "@top-pad/contract";
import { bundleCases, createDb } from "@top-pad/db";
import { fundDirectly, landings, runWallets, sellAndClose, signedBundle, spray, sweepRun, wrapSol, type BundleCopy } from "@top-pad/tests-devnet/bundle";
import { devnet, fund, swap, sweep } from "@top-pad/tests-devnet/devnet";
import { eq } from "drizzle-orm";
import { launchCoin, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";

const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INSTANT = devnet.configs!.instant;
/** Each creation-slot buy, and how many copies of each bundle transaction go out as the launch is sent. */
const BUY = 300_000n;
const COPIES = 14;
/** What each wallet the creator funds gets, and what it buys past the sniper tax. */
const FUNDED = (35n * SOL) / 1_000n;
const PAST_TAX = (2n * SOL) / 100n;

const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const database = () => createDb(TARGET.name === "devnet" ? process.env.DATABASE_URL! : "postgres://toppad:toppad@127.0.0.1:5452/toppad");

type Attempt = { mint: Address; copies: BundleCopy[]; sniperCopies: BundleCopy[]; submittedAt: number };

/**
 * Launches a coin from the site with the bundle's buys signed the moment the launch is prepared and sent as it is
 * submitted: copies of the two bundle transactions (the Creator wallet with two funded wallets, then the other two), the
 * sniper's buys among them from the second round on, 100 ms apart.
 */
async function launchWithBundle(page: Page, creator: KeyPairSigner, funded: KeyPairSigner[], sniper: KeyPairSigner): Promise<Attempt> {
  let signing: Promise<[BundleCopy[], BundleCopy[]]> | null = null;
  let sent: Promise<void> | null = null;
  let mint: Address | null = null;
  let submittedAt = 0;
  const onResponse = async (res: import("@playwright/test").Response) => {
    if (res.request().method() !== "POST" || new URL(res.url()).pathname !== "/launches" || !res.ok()) return;
    const prepared = PreparedLaunch.parse(await res.json());
    if (prepared.mode !== "instant") return;
    const coin = (mint = address(prepared.mint));
    signing = Promise.all([
      signedBundle([[creator, funded[0]!, funded[1]!], [funded[2]!, funded[3]!]], coin, INSTANT, BUY, COPIES),
      signedBundle([[sniper]], coin, INSTANT, BUY, COPIES - 2),
    ]);
  };
  const onRequest = (req: import("@playwright/test").Request) => {
    if (req.method() !== "POST" || !/\/launches\/[^/]+\/submit$/.test(new URL(req.url()).pathname)) return;
    submittedAt = Date.now();
    sent = (async () => {
      const [bundle, snipes] = await signing!;
      // Two rounds of the bundle first, then the sniper's buys woven in.
      const order = [...bundle.slice(0, 4)];
      for (let i = 4; i < bundle.length; i += 2) order.push(...bundle.slice(i, i + 2), ...(snipes.length ? [snipes.shift()!] : []));
      await spray(order, 100);
    })();
  };
  page.on("response", onResponse);
  page.on("request", onRequest);
  try {
    await launchCoin(page, creator, { name: "Radar Bundle", ticker: newTicker() });
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
  }
  await sent;
  const [copies, sniperCopies] = await signing!;
  return { mint: mint!, copies, sniperCopies, submittedAt };
}

test("Bundle Radar flags a creator's bundle within seconds, and a case opens an hour after the open", async ({ page: first }) => {
  test.setTimeout(90 * 60_000);
  let page = first;
  let errors = pageErrors(page);
  // Locally the indexer only runs once asked; on devnet the cron keeps it up.
  await fetch(`${TARGET.api}/indexer`);
  const run = `radar-${Date.now()}`;
  const { creator, sniper, funded } = await runWallets(run);
  console.log(`bundle run ${run}: creator ${creator.address}`);
  const bundleWallets = [creator, ...funded];
  const { db, close } = database();
  let mint: Address | null = null;
  const mints: Address[] = [];
  try {
    await fund([creator, sniper], [SOL / 5n, SOL / 20n]);
    // A minute before the launch, the Creator wallet funds its 4 wallets directly; each of them, the Creator wallet and
    // the sniper wrap SOL for their creation-slot buys.
    await fundDirectly(creator, funded.map((f) => f.address), FUNDED);
    for (const w of [...bundleWallets, sniper]) await wrapSol(w, BUY * BigInt(COPIES + 2));

    // The bundle must land in the creation slot: a launch whose buys all missed it is launched again, at most twice more.
    let attempt: Attempt | null = null;
    let creationSlot = 0n;
    let inSlot: { buyer: Address; signature: Signature }[] = [];
    for (let tries = 0; tries < 3; tries++) {
      if (tries) {
        // A fresh page: the test wallet is installed once a page.
        await page.close();
        page = await first.context().newPage();
        errors = pageErrors(page);
      }
      attempt = await launchWithBundle(page, creator, funded, sniper);
      mint = attempt.mint;
      mints.push(mint);
      const radar = await waitFor(() => api(`/coins/${mint}/radar`, BundleRadar), (r) => r.creation.blockIndex !== null, 60_000);
      creationSlot = BigInt(radar.creation.slot);
      const landed = await landings([...attempt.copies, ...attempt.sniperCopies].map((c) => c.signature));
      inSlot = [...attempt.copies, ...attempt.sniperCopies].flatMap((c) => {
        const l = landed.get(c.signature);
        return l && !l.err && l.slot === creationSlot ? c.buyers.map((buyer) => ({ buyer, signature: c.signature })) : [];
      });
      const wallets = new Set(inSlot.map((x) => x.buyer));
      const landedLater = [...landed.values()].filter((l) => !l.err && l.slot !== creationSlot).length;
      console.log(
        `try ${tries + 1}: ${mint}, created in slot ${creationSlot}; ${inSlot.length} buys landed in it, from ${wallets.size} wallets; ${landedLater} later; ` +
          `submitted ${new Date(attempt.submittedAt).toISOString()}`,
      );
      if (bundleWallets.every((w) => wallets.has(w.address))) break;
      // The coin of a try that missed is sold back before the next.
      for (const w of [...bundleWallets, sniper]) await sellAndClose(w, mint, INSTANT).catch(() => undefined);
      for (const w of [...bundleWallets, sniper]) await wrapSol(w, BUY * BigInt(COPIES + 2));
      attempt = null;
    }
    expect(attempt, "the Creator wallet and its 4 wallets each bought in the creation slot").not.toBeNull();
    const coin = mint!;

    // Within seconds of the open, the coin's labels: the 4 funded wallets red, the same-slot buys yellow.
    await page.getByRole("link", { name: "Watch it trade" }).click();
    const radar = await waitFor(() => api(`/coins/${coin}/radar`, BundleRadar), (r) => r.linked.wallets === 4, 60_000);
    const labelledAfter = (Date.now() - Date.parse(radar.openedAt)) / 1000;
    console.log(`Bundle Radar linked the 4 wallets ${labelledAfter.toFixed(1)} s after the open (block time)`);
    expect(labelledAfter).toBeLessThan(30);
    expect(radar.wallets.filter((w) => w.linked).map((w) => w.wallet).sort()).toEqual(funded.map((f) => f.address).sort());
    for (const w of radar.wallets.filter((x) => x.linked)) expect(w.labels).toEqual(expect.arrayContaining(["same_slot", "creator_funded"]));
    expect(radar.wallets.find((w) => w.wallet === creator.address)).toMatchObject({ creator: true, linked: false, labels: expect.arrayContaining(["same_slot"]) });
    const sniperRow = radar.wallets.find((w) => w.wallet === sniper.address);
    console.log(`the sniper: ${JSON.stringify(sniperRow?.labels ?? "no buy in the creation slot")}`);

    await expect(page.getByTestId("radar-linked")).toContainText("4 wallets linked to the creator", { timeout: 30_000 });
    await expect(page.getByTestId("radar-same-slot")).toBeVisible();
    await snap(page, "radar-1-flags");
    await page.getByTestId("radar-linked").click();
    await expect(page.getByTestId("radar-linked-detail").getByTestId("radar-wallet")).toHaveCount(4);
    await snap(page, "radar-2-linked");
    await page.getByTestId("radar-same-slot").click();
    await expect(page.getByTestId("radar-same-slot-detail")).toBeVisible();
    await snap(page, "radar-3-same-slot");
    await page.getByTestId("radar-same-slot").click();

    // Past the sniper tax, the 4 funded wallets buy on: over 1% of supply between them in the first hour. The sniper
    // buys more than any of them, and is still nothing to the case.
    const opened = Date.parse(radar.openedAt);
    await sleep(Math.max(0, opened + 65_000 - Date.now()));
    for (const f of funded) await swap(f, coin, "buy", PAST_TAX);
    await swap(sniper, coin, "buy", PAST_TAX * 2n);
    const counted = await waitFor(() => api(`/coins/${coin}/radar`, BundleRadar), (r) => BigInt(r.linked.coins) >= BigInt(r.floor), 60_000);
    console.log(`the linked wallets bought ${counted.linked.coins} of ${counted.supply} (floor ${counted.floor})`);
    await expect(page.getByTestId("radar-linked")).toContainText(/· \d+\.\d\d% of supply/);
    await snap(page, "radar-4-past-the-floor");

    // Two minutes after the open, everyone sells, and what is left goes back to the bank before the hour's wait.
    await sleep(Math.max(0, opened + 120_000 - Date.now()));
    for (const w of [...bundleWallets, sniper]) await sellAndClose(w, coin, INSTANT);
    await sweep(...funded, sniper, creator);

    // An hour after the open, the case job opens the case: the deployed cron runs every 5 minutes; locally, it is run here.
    const deadline = opened + 75 * 60_000;
    let found: typeof bundleCases.$inferSelect | undefined;
    while (!found && Date.now() < deadline) {
      if (TARGET.name === "local" && Date.now() > opened + 60 * 60_000) await fetch(`${TARGET.api}/cdn-cgi/local/scheduled`).catch(() => undefined);
      [found] = await db.select().from(bundleCases).where(eq(bundleCases.mint, coin));
      if (!found) await sleep(30_000);
    }
    expect(found, "a case opened within 75 minutes of the open").toBeDefined();
    const openedAfter = (found!.openedAt.getTime() - opened) / 60_000;
    console.log(`case ${found!.id} opened ${openedAfter.toFixed(1)} min after the open, its pack at ${found!.evidenceKey}`);
    expect(openedAfter).toBeGreaterThanOrEqual(60);
    expect(found).toMatchObject({ creatorWallet: creator.address, status: "open", linkedWallets: 4 });
    const pack = found!.evidence as { wallets: { wallet: string }[]; creator: { xHandle: string | null }; floor: { share: string } };
    expect(pack.wallets.map((w) => w.wallet).sort()).toEqual(funded.map((f) => f.address).sort());
    expect(pack.creator.xHandle).toMatch(/^e2e_creator_/);
    expect(JSON.stringify(pack)).not.toContain(sniper.address);
    console.log(`the case's floor: ${JSON.stringify(pack.floor)}`);

    await page.reload();
    await expect(page.getByTestId("radar-linked")).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  } finally {
    await sweepRun(run, mints);
    await close();
  }
});

/** Asks `read` every half second until `ok` holds of its answer, for at most `ms`. */
async function waitFor<T>(read: () => Promise<T>, ok: (t: T) => boolean, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && ok(value)) return value;
    if (Date.now() > until) throw new Error(`not so within ${ms} ms: ${JSON.stringify(value)?.slice(0, 500)}`);
    await sleep(500);
  }
}
