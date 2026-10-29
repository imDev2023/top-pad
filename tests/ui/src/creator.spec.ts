// Fee claims end to end (#44's devnet demo): a creator launches an Instant launch from the site, a trader buys through
// its first minute, and Heat's keeper sends the window claim when the minute ends, paying the tax to the treasury, which
// the coin's page then says. Later fees wait as Creator Earnings: the creator's page shows half of them and claims
// exactly that in one transaction, however much more accrues meanwhile; after the creator role is handed to another
// wallet, the next claim pays the new holder. Real devnet SOL: about 0.1 a run. No page may report an error.
import { expect, test, type Page } from "@playwright/test";
import { address, type Address } from "@solana/kit";
import { CLUSTERS, creatorShare, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, eventAuthorityAddress, quoteAccount } from "@top-pad/chain";
import { fetchVirtualPool, getTransferPoolCreatorInstruction } from "@top-pad/clients/dbc";
import { Coin, CreatorEarnings } from "@top-pad/contract";
import { fundedWallets, rpc, send, swap, sweep } from "@top-pad/tests-devnet/devnet";
import { launchCoin, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const devnet = CLUSTERS.devnet!;
const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
async function tokens(account: Address) {
  const { value } = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }));
  return BigInt(value.amount);
}
const partnerFees = async (pool: Address) => (await fetchVirtualPool(rpc, pool)).data.poolState.partnerQuoteFee;
/** The SOL a page writes for a raw amount: every lamport, as the creator's page shows it. */
const shown = (raw: bigint) => `${(Number(raw) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
/** A transaction's network fee: one signature, no priority fee. */
const NETWORK_FEE = 5_000n;

/** Opens the creator's page with the page's test wallet connected, and waits for its earnings to load. */
async function openCreatorPage(page: Page) {
  await page.goto("/creator");
  const waiting = page.getByTestId("earnings-waiting");
  const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" });
  // A wallet connected on an earlier page of this browser reconnects by itself.
  await expect(waiting.or(connect)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await connectTestWallet(page, connect);
  await expect(waiting).toBeVisible({ timeout: 30_000 });
}

test("the window's tax reaches the treasury at 60 s, and the creator claims exactly the half the page shows", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const errors = pageErrors(page);
  await fetch(`${TARGET.api}/indexer`);
  const [creator, trader, heir] = await fundedWallets(40_000_000n, 250_000_000n, 10_000_000n);
  const treasuryAccount = await quoteAccount(devnet.keys!.treasury, devnet.quote.mint);
  const treasuryBefore = await tokens(treasuryAccount);

  const { mint } = await launchCoin(page, creator, { name: "Heat Earnings", ticker: newTicker() });
  const coin = await api(`/coins/${mint}`, Coin).catch(async () => {
    await expect.poll(async () => (await fetch(`${TARGET.api}/coins/${mint}`)).status, { timeout: 30_000 }).toBe(200);
    return api(`/coins/${mint}`, Coin);
  });
  const pool = address(coin.pool);

  // Inside the minute: two buys pay the sniper tax, none of which waits for the creator.
  await swap(trader, address(mint), "buy", 10_000_000n);
  await swap(trader, address(mint), "buy", 10_000_000n);
  const tax = await partnerFees(pool);
  // Far above the 200,000 lamports two buys would leave at the normal 1.25%: the deployed launch confirms later than a
  // local one, so how much above depends on the second each buy lands in.
  expect(tax).toBeGreaterThan(2_000_000n);
  await openCreatorPage(page);
  await expect(page.getByTestId("earnings-coin")).toContainText("First minute's claim pending");
  await expect(page.getByTestId("earnings-waiting")).toHaveText("0 SOL");
  await expect(page.getByRole("button", { name: "Nothing to claim yet" })).toBeDisabled();
  await snap(page, "earnings-1-window-pending");

  // The keeper's Workflow sends the window claim when the minute ends; the coin's page says where the tax went.
  await page.goto(`/coin/${mint}`);
  const claimed = await expect
    .poll(async () => (await api(`/coins/${mint}`, Coin)).windowClaim, { timeout: 120_000, intervals: [2_000] })
    .not.toBeNull()
    .then(() => api(`/coins/${mint}`, Coin));
  const windowClaim = claimed.windowClaim!;
  const late = (Date.parse(windowClaim.claimedAt) - Date.parse(windowClaim.windowEndedAt)) / 1000;
  console.log(`the keeper's window claim ran ${late} s after the minute ended and paid the treasury ${windowClaim.amount} lamports`);
  expect(BigInt(windowClaim.amount)).toBe(tax);
  expect(late).toBeLessThan(10);
  expect(await tokens(treasuryAccount)).toBe(treasuryBefore + tax);
  const outcome = page.getByTestId("tax-outcome");
  await expect(outcome).toContainText(`Heat's treasury was paid ${(Number(tax) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL for that minute`, {
    timeout: 30_000,
  });
  await snap(page, "earnings-2-coin-window-claimed");

  // After it, every fee is half the creator's: the creator's page shows exactly that half.
  await swap(trader, address(mint), "buy", 80_000_000n);
  await openCreatorPage(page);
  const listed = await api(`/earnings/${creator.address}`, CreatorEarnings);
  const fees = await partnerFees(pool);
  expect(listed.coins).toEqual([expect.objectContaining({ mint, partnerFees: fees.toString(), waiting: creatorShare(fees).toString(), windowClaimed: true })]);
  await expect(page.getByTestId("earnings-waiting")).toHaveText(shown(creatorShare(fees)));
  await expect(page.getByTestId("earnings-coin")).toContainText("Heat Earnings");
  await snap(page, "earnings-3-waiting");

  // More fees land after the page showed its figure; the claim pays exactly the figure.
  await swap(trader, address(mint), "buy", 40_000_000n);
  const before = await lamports(creator.address);
  await page.getByRole("button", { name: `Claim ${shown(creatorShare(fees))}` }).click();
  await expect(page.getByRole("status")).toContainText(`Claimed ${shown(creatorShare(fees))}`, { timeout: 60_000 });
  expect(await lamports(creator.address)).toBe(before + creatorShare(fees) - NETWORK_FEE);
  await snap(page, "earnings-4-claimed");
  // What accrued meanwhile waits for the next claim.
  const rest = await partnerFees(pool);
  await expect(page.getByTestId("earnings-waiting")).toHaveText(shown(creatorShare(rest)));

  // The creator role is handed to another wallet: its earnings now wait for that wallet, and its claim pays it.
  await send(creator, [
    getTransferPoolCreatorInstruction({
      virtualPool: pool,
      config: devnet.configs!.instant,
      creator,
      newCreator: heir.address,
      eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
      program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    }),
  ]);
  const heirPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const heirErrors = pageErrors(heirPage);
  await installTestWallet(heirPage, heir);
  await heirPage.goto("/creator");
  await expect(heirPage.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  await snap(heirPage, "earnings-0-connect");
  await openCreatorPage(heirPage);
  const inherited = await partnerFees(pool);
  await expect(heirPage.getByTestId("earnings-waiting")).toHaveText(shown(creatorShare(inherited)));
  const heirBefore = await lamports(heir.address);
  await heirPage.getByRole("button", { name: `Claim ${shown(creatorShare(inherited))}` }).click();
  await expect(heirPage.getByRole("status")).toContainText(`Claimed ${shown(creatorShare(inherited))}`, { timeout: 60_000 });
  expect(await lamports(heir.address)).toBe(heirBefore + creatorShare(inherited) - NETWORK_FEE);
  await snap(heirPage, "earnings-5-heir-claimed");
  // The coin left the launcher's page with its role.
  await page.reload();
  await expect(page.getByTestId("earnings-waiting")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("earnings-coin")).toHaveCount(0);
  await expect(page.getByText(/No Heat coin's creator role is held by/)).toBeVisible();
  await snap(page, "earnings-6-handed-over");

  expect([...errors, ...heirErrors]).toEqual([]);
  await sweep(trader, creator, heir);
});
