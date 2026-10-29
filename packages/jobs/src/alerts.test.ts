import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, operatorAlerts, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { notifyPending, raiseAlert, resolveAlert } from "./alerts";

let db: Db;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());

const posted: unknown[] = [];
let webhookAnswers = 200;
beforeEach(async () => {
  await db.delete(operatorAlerts);
  posted.length = 0;
  webhookAnswers = 200;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(init.body as string));
    return new Response(null, { status: webhookAnswers });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const alerts = () => db.select().from(operatorAlerts);
const KEEPER = "GpDvDUpEC9ynHTJBt3XaZcTvBUw1HaMnU9Wwox18xfNi";

describe("operator alerts", () => {
  it("keeps one open alert per condition, current with its latest message", async () => {
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.200 SOL");
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.100 SOL");
    const [alert, ...rest] = await alerts();
    expect(rest).toHaveLength(0);
    expect(alert).toMatchObject({ message: "holds 0.100 SOL", resolvedAt: null });
  });

  it("posts an open alert to the webhook once, and again only after it was resolved and raised anew", async () => {
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.100 SOL");
    await notifyPending(db, "https://hooks.example/alerts");
    await notifyPending(db, "https://hooks.example/alerts");
    expect(posted).toEqual([{ text: "holds 0.100 SOL", content: "holds 0.100 SOL", alert: expect.objectContaining({ kind: "keeper_low_balance", subject: KEEPER }) }]);

    await resolveAlert(db, "keeper_low_balance", KEEPER);
    expect((await alerts())[0]!.resolvedAt).not.toBeNull();
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.050 SOL");
    await notifyPending(db, "https://hooks.example/alerts");
    expect(posted).toHaveLength(2);
  });

  it("tries a failed post again on the next run", async () => {
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.100 SOL");
    webhookAnswers = 500;
    await notifyPending(db, "https://hooks.example/alerts");
    expect((await alerts())[0]!.notifiedAt).toBeNull();
    webhookAnswers = 200;
    await notifyPending(db, "https://hooks.example/alerts");
    expect((await alerts())[0]!.notifiedAt).not.toBeNull();
    expect(posted).toHaveLength(2);
  });

  it("only logs an alert when there is no webhook", async () => {
    await raiseAlert(db, "keeper_low_balance", KEEPER, "holds 0.100 SOL");
    await notifyPending(db, null);
    expect(posted).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith("operator alert: holds 0.100 SOL");
    expect((await alerts())[0]!.notifiedAt).not.toBeNull();
  });
});
