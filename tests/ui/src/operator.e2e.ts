// The operator app's demo (#54), locally: the queue shows a refused launch with its appeal, a merged and a refused
// admission and two bundling cases, each with its age against the 48-hour aim; the operator clears the launch, clears the
// merged wallet for future Fair Opens, keeps the refusal, opens a case's evidence pack, confirms the case, which bars its
// creator and cancels their Fair Open not yet in its window (#56), is kept from hearing that Bar's appeal as the operator
// who confirmed it, upholds another operator's Bar on appeal, names and removes a hub, and the audit log holds every one
// of those actions; the export writes the finished days to R2. Run by `playwright.operator.config.ts`, which seeds the
// data (src/operator-demo.ts).
import { expect, test, type Page } from "@playwright/test";
import { barAppeals, bars, createDb, launches } from "@top-pad/db";
import { eq } from "drizzle-orm";
import { FIRST_OPERATOR, operatorDemoUrl } from "./operator-demo-shared";
import { snap } from "./steps";

const decide = async (page: Page, choice: RegExp, note: string, extra?: (page: Page) => Promise<void>) => {
  await page.getByRole("radio", { name: choice }).check();
  await extra?.(page);
  await page.getByLabel("Why (kept in the audit log)").fill(note);
  await page.getByRole("button", { name: "Record the decision" }).click();
  await expect(page.getByRole("status")).toContainText("written to the audit log as row");
};

test("the operator works the queue, and every action is in the audit log", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  await expect(page.getByTestId("tally-launch")).toHaveText("3");
  await expect(page.getByTestId("tally-admission")).toHaveText("2");
  await expect(page.getByTestId("tally-case")).toHaveText("2");
  await expect(page.getByTestId("tally-appeal")).toHaveText("1");
  // The refused PEPE launch waited 52 hours and the merged admission 40: oldest first, the first past the aim.
  const kinds = await page.locator("a.item").evaluateAll((items) => items.map((i) => (i as HTMLElement).dataset.kind));
  expect(kinds).toEqual(["launch", "admission", "launch", "admission", "appeal", "launch", "case", "case"]);
  await expect(page.getByTestId("tally-over")).toHaveText("1");
  // A Fair Open before its open shows its teaser, never its coin.
  await expect(page.getByText('in the Fair Open "lantern"')).toBeVisible();
  await expect(page.getByText("SECRET")).toHaveCount(0);
  await snap(page, "operator-01-queue");

  // The appeal against the B0NK refusal: cleared, the appeal upheld.
  await page.getByRole("link", { name: /\$B0NK · Bonk Relaunch/ }).click();
  await expect(page.getByRole("heading", { name: "$B0NK · Bonk Relaunch" })).toBeVisible();
  await expect(page.getByText("Image refused as $Bonk", { exact: true })).toBeVisible();
  await expect(page.getByText("We are Bonk's original team relaunching")).toBeVisible();
  await snap(page, "operator-02-launch");
  await decide(page, /Clear this launch/, "The original team relaunching, shown by the original's mint authority.");
  await expect(page.getByTestId("tally-launch")).toHaveText("2");
  await snap(page, "operator-03-launch-cleared");

  // The merged admission: the wallet cleared for future Fair Opens.
  await page.getByRole("link", { name: /DKAs…hCVc in the Fair Open "lantern"/ }).click();
  await expect(page.getByText("through 1 pass-through wallet in between")).toBeVisible();
  await expect(page.getByText("pass-through", { exact: true })).toBeVisible();
  await snap(page, "operator-04-admission-merged");
  await decide(page, /Clear this wallet for future Fair Opens/, "A friend who funded them once, not one person.");

  // The refused admission: kept.
  await page.getByRole("link", { name: /4KVC…BUPn in \$GLOW's Fair Open/ }).click();
  await expect(page.getByText("The Creator wallet funded this wallet, directly.")).toBeVisible();
  // Its SOL came from the Creator wallet itself: that is the tie, never a hub to name.
  await expect(page.getByRole("radio", { name: /a hub/ })).toHaveCount(0);
  await snap(page, "operator-05-admission-refused");
  await decide(page, /Keep the refusal/, "The creator's own wallet funded it minutes before the window.");
  await expect(page.getByTestId("tally-admission")).toHaveText("0");

  // The bundling case: its evidence pack, opened through the audit log, read from R2.
  await page.getByRole("link", { name: /\$FROG · Frog Bundle/ }).click();
  await snap(page, "operator-06-case");
  await page.getByRole("button", { name: "Open the evidence pack" }).click();
  await expect(page.getByText("Read from R2")).toBeVisible();
  await expect(page.getByText("the same as the case's own copy in Postgres")).toBeVisible();
  await expect(page.getByText("Bought right after the creation")).toBeVisible();
  await snap(page, "operator-07-evidence");
  // A case whose pack R2 lacks says so, and shows Postgres's copy.
  await page.goto("/");
  await page.locator('a.item[data-kind="case"]').filter({ hasText: "Coin 7ZzY" }).click();
  await page.getByRole("button", { name: "Open the evidence pack" }).click();
  await expect(page.getByText("R2 holds no pack")).toBeVisible();

  // The FROG case confirmed: its creator barred, their Fair Open of tomorrow cancelled, an X message owed.
  await page.goto("/");
  await page.getByRole("link", { name: /\$FROG · Frog Bundle/ }).click();
  await expect(page.getByText('Their Fair Open not yet in its window is cancelled ("tadpoles")')).toBeVisible();
  await snap(page, "operator-11-case-decide");
  await decide(page, /Confirm the case: bar the creator/, "Two wallets the Creator wallet funded bought 15.8% of supply, one right after the creation.");
  await expect(page.getByRole("heading", { name: "$FROG · Frog Bundle" })).toBeVisible();
  await expect(page.getByText("Private window", { exact: true })).toBeVisible();
  await expect(page.getByText('"tadpoles", was to open')).toBeVisible();
  await expect(page.getByText("Owed: the API's five-minute cron sends it")).toBeVisible();
  await snap(page, "operator-12-bar-confirmed");
  const { db, close } = createDb(operatorDemoUrl());
  try {
    const [frogBar] = await db.select().from(bars).where(eq(bars.confirmedBy, "operator@heat.local"));
    const [tadpole] = await db.select().from(launches).where(eq(launches.teaser, "tadpoles"));
    expect(tadpole!.cancelBar).toBe(frogBar!.id);
    // The creator appeals from their record, as the API writes it; the operator who confirmed the case may not hear it.
    await db.insert(barAppeals).values({ barId: frogBar!.id, creatorId: frogBar!.creatorId!, grounds: "launch_service", statement: "A launch service bundled for me; I did not know." });
    await page.reload();
    await expect(page.getByTestId("appeal-not-yours")).toContainText("You confirmed this case, so you may not decide its appeal");
    await expect(page.getByRole("button", { name: "Record the decision" })).toHaveCount(0);
    await snap(page, "operator-13-appeal-not-yours");
  } finally {
    await close();
  }

  // The Bars: the one just confirmed, in its private window, and the MOON Bar another operator confirmed, public now.
  await page.getByRole("link", { name: "Bars", exact: true }).click();
  await expect(page.locator('a.item[data-kind="bar"]')).toHaveCount(2);
  await snap(page, "operator-14-bars");
  await page.getByRole("link", { name: /\$MOON · Moon Bundle/ }).click();
  await expect(page.getByText(`by ${FIRST_OPERATOR}`).first()).toBeVisible();
  await expect(page.locator(".chip", { hasText: "Published" })).toBeVisible();
  await expect(page.getByText("Those two wallets are my brother's")).toBeVisible();
  await expect(page.getByText("Coinbase's statement of the two withdrawals")).toBeVisible();
  await snap(page, "operator-15-appeal");
  await decide(page, /Uphold it: lift the Bar/, "Both wallets' SOL came from a shared exchange account; no transfer from the Creator wallet.");
  await expect(page.getByText("Lifted on appeal").first()).toBeVisible();
  await expect(page.getByText(", until it was lifted")).toBeVisible();
  await snap(page, "operator-16-appeal-upheld");

  // Hubs: one named and taken off again.
  await page.getByRole("link", { name: "Hubs" }).click();
  await expect(page.getByText("Devnet faucet drip")).toBeVisible();
  await page.getByLabel("Address").fill("BrdgRouter1111111111111111111111111111111111");
  await page.getByLabel("What it is").fill("Bridge router");
  await page.getByRole("button", { name: "Name it a hub" }).click();
  await expect(page.getByRole("status")).toContainText("written to the audit log");
  await snap(page, "operator-08-hubs");
  await page.getByLabel("Why Bridge router is no hub").fill("A test router, not a real hub.");
  await page.getByRole("row", { name: /Bridge router/ }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Bridge router")).toHaveCount(0);

  // The audit log: every action above, newest first, by the signed-in operator; then the export.
  await page.getByRole("link", { name: "Audit log" }).click();
  const actions = await page.getByTestId("audit-rows").locator("tbody tr td:nth-child(3) b").allTextContents();
  expect(actions).toEqual([
    "Removed a hub",
    "Named a hub",
    "Upheld an appeal: Bar lifted",
    "Confirmed a case: Bar",
    "Opened an evidence pack",
    "Opened an evidence pack",
    "Kept an admission",
    "Cleared a wallet",
    "Cleared a launch",
  ]);
  await expect(page.getByTestId("audit-rows").getByText("operator@heat.local").first()).toBeVisible();
  await page.getByRole("button", { name: "Export every finished day now" }).click();
  await expect(page.getByRole("status")).toContainText("written to the audit log");
  await expect(page.getByText("succeeded")).toBeVisible();
  await snap(page, "operator-09-audit");

  // The theme toggle flips the page and remembers it.
  await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.context().clearCookies();

  await page.goto("/nowhere");
  await expect(page.getByRole("heading", { name: "No page here" })).toBeVisible();
  await snap(page, "operator-10-missing");
});
