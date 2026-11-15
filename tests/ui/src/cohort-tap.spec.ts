// The cohort tap and the cohort's measures (#63's devnet demo), on the deployed site:
// - The tap's float is set to 4.5 SOL from the bank first, its floor being the deployed default, 3 SOL.
// - A fresh wallet with no SOL signs in on /cohort. Without X the tap gives it nothing (the API refuses, the chain shows
//   no SOL arriving) and it joins the cohort anyway. It links X through the stand-in, taps, and gets exactly 1 SOL from
//   the tap key, the tap paying the fee; a second tap is refused and nothing more arrives.
// - A second member with X taps: the tap is left holding 2.5 SOL, below its floor, so its low-balance alert is open in
//   the devnet database, naming the 2 members it can still pay, before it runs dry.
// - The first member launches an Instant coin from the site with its tapped SOL, so the cohort counts one creator, who did
//   not keep Fair Open: the operator app's Cohort page (an operator app on this Mac against the devnet database, started
//   first with `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui operators`; OPERATOR_URL overrides
//   http://localhost:8803) shows the measures, the default-mode rule turning to Instant launch on fewer than a third, the
//   two taps and the alert.
// - Afterwards both members leave the cohort (their taps stay, so neither can tap again), the measures counting real
//   members only, and their SOL goes back to the bank; the tap is refilled to 4.5 SOL, which the next cron run reads and
//   resolves the alert.
// About 0.03 devnet SOL a run, 3 minutes. Run with
// `direnv exec "<main checkout>" pnpm --filter @top-pad/tests-ui e2e:devnet cohort-tap.spec.ts`.
import { expect, test, type Page } from "@playwright/test";
import { getTransferSolInstruction } from "@solana-program/system";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { CLUSTERS, TAP_LAMPORTS } from "@top-pad/chain";
import { CohortRefusal } from "@top-pad/contract";
import { cohortMembers, cohortTaps, operatorAlerts } from "@top-pad/db";
import { bank, landed, rpc, send, sweep } from "@top-pad/tests-devnet/devnet";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { database } from "./bundler";
import { launchCoin, newHandle, newTicker, pageErrors, snap } from "./steps";
import { TARGET } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const SOL = 1_000_000_000n;
const FLOAT = 4n * SOL + SOL / 2n;
const FLOOR = 3n * SOL;
const OPERATOR = process.env.OPERATOR_URL ?? "http://localhost:8803";
const TAP = CLUSTERS.devnet!.keys!.tap!;
const tapKey = () => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/top-pad/devnet/tap.json"), "utf8"))));
const balance = async (address: string) => (await rpc.getBalance(address as never, { commitment: "confirmed" }).send()).value;

/** Sets the tap's float to `lamports` exactly: the bank tops it up, or the tap sends the excess back. */
async function setFloat(lamports: bigint) {
  const now = await balance(TAP);
  if (now < lamports) {
    const from = await bank();
    await send(from, [getTransferSolInstruction({ source: from, destination: TAP, amount: lamports - now })]);
  } else if (now > lamports + 5_000n) {
    const tap = await tapKey();
    // The tap pays this transfer's fee too, so it sends that much less.
    await send(tap, [getTransferSolInstruction({ source: tap, destination: (await bank()).address, amount: now - lamports - 5_000n })]);
  }
}

/**
 * A tap asked of the API with the page's session cookie and the site's origin, as the cohort page would ask it, but from
 * the test's own request context, so the refusals it expects are not the page's console errors.
 */
const tapFromPage = async (page: Page) => {
  const res = await page.request.post(`${TARGET.api}/cohort/tap`, { headers: { origin: TARGET.web } });
  return { status: res.status(), body: (await res.json()) as unknown };
};

/** Signs `wallet` in on /cohort with the test wallet. */
async function signIn(page: Page, wallet: KeyPairSigner) {
  await installTestWallet(page, wallet);
  await page.goto("/cohort");
  await expect(page.getByRole("heading", { name: "Join the cohort", level: 1 })).toBeVisible();
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await expect(page.getByTestId("cohort-signed-in")).toBeVisible();
}

/** Links X on /cohort as a new handle on the stand-in, and comes back to the page. */
async function linkX(page: Page) {
  const handle = newHandle();
  await page.getByRole("link", { name: "Link X" }).click();
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Authorize app" }).click();
  await expect(page.getByText("Your X account is linked.")).toBeVisible();
  await expect(page.getByTestId("cohort-x-linked")).toContainText(`@${handle}`);
  return handle;
}

/** Taps from the page's button and returns the transfer's signature, read from the page's explorer link. */
async function tap(page: Page) {
  await page.getByRole("button", { name: "Get 1 devnet SOL" }).click();
  await expect(page.getByTestId("cohort-tapped")).toContainText("1 devnet SOL sent to", { timeout: 60_000 });
  const href = await page.getByRole("link", { name: "See the transfer" }).getAttribute("href");
  return new URL(href!).pathname.split("/").pop()!;
}

test("the cohort tap gives a member who linked X 1 devnet SOL once, alerts before it runs dry, and the measures count it", async ({ page, browser }) => {
  test.setTimeout(10 * 60_000);
  const { db, close } = database();
  const errors = pageErrors(page);
  const [first, second] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const members: string[] = [];
  try {
    await setFloat(FLOAT);
    await db.delete(operatorAlerts).where(and(eq(operatorAlerts.kind, "tap_low_balance"), eq(operatorAlerts.subject, TAP)));

    // Without X: nothing from the tap, but the wallet may join.
    await signIn(page, first);
    await snap(page, "cohort-signed-in");
    const refused = await tapFromPage(page);
    expect(refused.status).toBe(403);
    expect(CohortRefusal.parse(refused.body).code).toBe("x_required");
    expect(await balance(first.address)).toBe(0n);
    await page.getByRole("button", { name: "Join without X" }).click();
    await expect(page.getByTestId("cohort-joined")).toBeVisible();
    await snap(page, "cohort-joined-without-x");

    // With X: exactly 1 SOL, once.
    const handle = await linkX(page);
    await snap(page, "cohort-x-linked");
    const signature = await tap(page);
    await snap(page, "cohort-tapped");
    expect(await balance(first.address)).toBe(TAP_LAMPORTS);
    const tx = await landed(signature);
    const keys = tx.transaction.message.accountKeys.map(String);
    expect(keys[0]).toBe(TAP);
    expect(keys).toContain(first.address);
    const again = await tapFromPage(page);
    expect(again.status).toBe(409);
    expect(CohortRefusal.parse(again.body)).toMatchObject({ code: "claimed", tap: { signature } });
    await page.reload();
    await expect(page.getByTestId("cohort-tapped")).toContainText("1 devnet SOL sent to");
    expect(await balance(first.address)).toBe(TAP_LAMPORTS);
    const [row] = await db.select().from(cohortTaps).where(eq(cohortTaps.signature, signature));
    expect(row).toMatchObject({ status: "sent", wallet: first.address, xHandle: handle, lamports: TAP_LAMPORTS });
    members.push(row!.creatorId);

    // A second member leaves the tap below its floor: the alert is open while it can still pay two.
    const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    await signIn(other, second);
    await linkX(other);
    const secondSignature = await tap(other);
    expect(await balance(second.address)).toBe(TAP_LAMPORTS);
    const left = await balance(TAP);
    expect(left).toBe(FLOAT - 2n * TAP_LAMPORTS - 10_000n);
    expect(left).toBeLessThan(FLOOR);
    const [alert] = await db
      .select()
      .from(operatorAlerts)
      .where(and(eq(operatorAlerts.kind, "tap_low_balance"), eq(operatorAlerts.subject, TAP), isNull(operatorAlerts.resolvedAt)));
    expect(alert?.message).toContain("below its 3.000 SOL floor: 2 more members can be paid");
    const [secondRow] = await db.select().from(cohortTaps).where(eq(cohortTaps.signature, secondSignature));
    members.push(secondRow!.creatorId);
    await other.context().close();

    // The first member launches an Instant coin with its tapped SOL, signed in already: a new page of the same browser,
    // since the launch installs the test wallet in its page afresh.
    const launchPage = await page.context().newPage();
    const launchErrors = pageErrors(launchPage);
    await launchCoin(launchPage, first, { name: "Cohort Tap", ticker: newTicker() }, { linked: true, looksLike: true });
    expect(launchErrors).toEqual([]);
    await launchPage.close();

    // The operator's Cohort page.
    const operator = await fetch(`${OPERATOR}/cohort`).catch(() => null);
    expect(operator?.ok, `the operator app at ${OPERATOR}: start it with \`pnpm --filter @top-pad/tests-ui operators\``).toBe(true);
    const ops = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", baseURL: OPERATOR });
    await ops.goto("/cohort");
    await expect(ops.getByTestId("default-mode")).toContainText("Instant launch would become the default");
    await expect(ops.getByTestId("default-mode")).toContainText("Creators who kept Fair Open: 0 of 1, fewer than a third.");
    await expect(ops.getByTestId("tap-alert")).toContainText("2 more members can be paid");
    await expect(ops.getByTestId("tap-float")).toContainText(`${Number(left) / 1e9} SOL, floor 3 SOL: 2 more members can be paid`);
    await expect(ops.getByText(`@${handle}`)).toBeVisible();
    await snap(ops, "cohort-operator");
    await ops.close();
    expect(errors).toEqual([]);
  } finally {
    // The demo's members leave the cohort, so its measures count real members only; their taps stay, once each.
    if (members.length) await db.delete(cohortMembers).where(inArray(cohortMembers.creatorId, members));
    await sweep(first, second).catch((e) => console.error("sweeping the members back to the bank failed", e));
    await setFloat(FLOAT).catch((e) => console.error("refilling the tap failed", e));
    await close();
  }
});
