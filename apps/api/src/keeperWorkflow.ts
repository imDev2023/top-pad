// The keeper's Workflows (spec 10.2). An Instant launch's, keyed by its coin: it reads when the coin's Tax window ends,
// sleeps until then, and sends the window claim. A Fair Open's, keyed by its launch account: the coin's metadata up 15 s
// before the open, the rung the pot covers at the open, then every seat pushed its coins and refund, the creator's coins
// locked, the Tax Share collected at 60 s and pushed to every seat, and the launch closed; or, if the launch cannot open,
// the launch failed and every seat refunded; then the nonce closed and the ticker released. Every step is safe to repeat.
import { address } from "@solana/kit";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb } from "@top-pad/db";
import { config, type Bindings, type SecretBinding } from "./env";
import {
  closeLaunchNonce,
  collectTaxShare,
  failAndRefund,
  lockCreator,
  pushSeats,
  pushTaxShare,
  readSchedule,
  releaseTicker,
  sendOpen,
  taxWindowEnd,
  uploadMetadata,
  type FairOpenKeeperParams,
} from "./fairOpenKeeper";
import { indexNow } from "./indexing";
import { sendWindowClaim, windowEnd, type KeeperParams } from "./windowClaims";

export class InstantLaunchKeeper extends WorkflowEntrypoint<Bindings, KeeperParams> {
  async run(event: Readonly<WorkflowEvent<KeeperParams>>, step: WorkflowStep) {
    const cfg = config(this.env);
    const mint = address(event.payload.mint);
    const keeperKey = this.env.KEEPER_KEY;
    if (!keeperKey) throw new Error("the keeper key is not bound to this deployment");
    const key = typeof keeperKey === "string" ? { get: async () => keeperKey } : keeperKey;

    // The coin's record may reach the RPC a moment after the launch that asked for this Workflow.
    const endsAt = await step.do("read when the Tax window ends", { retries: { limit: 10, delay: "2 seconds", backoff: "constant" } }, () =>
      windowEnd(cfg, mint),
    );
    // A coin found after its window ended (by the indexer catching up, or the cron's sweep) is claimed at once: a
    // Workflow refuses to sleep until a time in the past.
    if (endsAt > Date.now()) await step.sleepUntil("wait for the Tax window to end", endsAt);
    // Tried every second: the chain's clock can trail this one, and its preflight refuses a claim inside the window.
    const sent = await step.do(
      "send the window claim",
      { retries: { limit: 30, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
      () => sendWindowClaim(cfg, key, mint),
    );
    if (sent.signature) {
      const signature = sent.signature;
      await step.do("index the window claim", async () => {
        await indexNow(this.env, [signature]);
        return signature;
      });
    }
    console.log(`window claim for ${mint}: ${sent.signature ?? "already run"}, sent ${sent.sentLateMs ?? "-"} ms after the window ended`);
    return sent;
  }
}

const keeperKeyOf = (env: Bindings): SecretBinding => {
  const keeperKey = env.KEEPER_KEY;
  if (!keeperKey) throw new Error("the keeper key is not bound to this deployment");
  return typeof keeperKey === "string" ? { get: async () => keeperKey } : keeperKey;
};

/** How long before the open the coin's metadata goes up (spec 10.2, keeper step 1). */
const UPLOAD_LEAD_MS = 15_000;
/** How long before the open the open's step starts watching the chain's clock. */
const OPEN_LEAD_MS = 3_000;

export class FairOpenKeeper extends WorkflowEntrypoint<Bindings, FairOpenKeeperParams> {
  async run(event: Readonly<WorkflowEvent<FairOpenKeeperParams>>, step: WorkflowStep) {
    const cfg = config(this.env);
    const launch = address(event.payload.launch);
    const key = keeperKeyOf(this.env);
    const blobs = this.env.BLOBS;
    if (!blobs) throw new Error("the blob store is not bound to this deployment");
    // Each step opens its own connection: a Workflow sleeps for days between them.
    const withDb = async <T>(work: (db: ReturnType<typeof createDb>["db"]) => Promise<T>): Promise<T> => {
      const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        return await work(db);
      } finally {
        await close();
      }
    };
    const quick = { retries: { limit: 10, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

    // The schedule may reach the RPC a moment after the submit that started this Workflow.
    const schedule = await step.do("read the schedule", quick, () => withDb((db) => readSchedule(db, cfg, launch)));
    // Whether the open's step found the launch cannot open, so anyone may mark it failed now.
    let cannotOpen = false;
    if (schedule.status === "scheduled") {
      const uploadAt = schedule.opensAtMs - UPLOAD_LEAD_MS;
      if (uploadAt > Date.now()) await step.sleepUntil("wait until 15 s before the open", uploadAt);
      // Never in the open's way: tried for about the 15 s before the open, after which the open goes out anyway, holding
      // up to 10 s for the coin's URI to be served (spec 2.1 step 10), and the metadata goes up after it.
      const upload = { retries: { limit: 4, delay: "2 seconds", backoff: "constant" }, timeout: "30 seconds" } as const;
      const uploaded = await step
        .do("upload the coin's metadata", upload, () => withDb((db) => uploadMetadata(db, cfg, blobs, launch)))
        .then(() => true)
        .catch((e: Error) => (console.error(`the metadata of ${launch} did not go up before the open`, e.message), false));
      const openAt = schedule.opensAtMs - OPEN_LEAD_MS;
      if (openAt > Date.now()) await step.sleepUntil("wait for the open", openAt);
      // One long try: it watches the chain's clock, sends the rung once it can, and waits for a creator signing at the
      // open until the open is late. Tried again only if the try itself fails, after which it starts by reading the chain.
      const open = await step.do("send the open", { retries: { limit: 20, delay: "1 second", backoff: "constant" }, timeout: "20 minutes" }, () =>
        withDb((db) => sendOpen(db, cfg, key, launch)),
      );
      console.log(`open of ${launch}: ${JSON.stringify(open)}`);
      if (!uploaded) await step.do("upload the coin's metadata after the open", quick, () => withDb((db) => uploadMetadata(db, cfg, blobs, launch)));
      cannotOpen = open.outcome === "cannot_open";
      if (open.outcome === "opened" && open.signature) {
        const signature = open.signature;
        await step.do("index the open", async () => {
          await indexNow(this.env, [signature]);
          return signature;
        });
      }
    }

    const now = await step.do("read where the launch stands", quick, () => withDb((db) => readSchedule(db, cfg, launch)));
    // Each step after the open hands its transactions to the indexer, so the pages show them at once.
    const indexed = (name: string, signatures: string[]) =>
      signatures.length === 0
        ? Promise.resolve()
        : step.do(name, async () => {
            await indexNow(this.env, signatures);
            return signatures;
          });
    if (now.status === "opened") {
      await step.do("push every seat", { retries: { limit: 10, delay: "5 seconds", backoff: "constant" }, timeout: "10 minutes" }, () =>
        withDb((db) => pushSeats(db, cfg, key, launch)),
      );
      // The Creator lock, once every other seat has its coins (spec 2.1 step 13).
      const lock = await step.do("lock the creator's coins", quick, () => lockCreator(cfg, key, launch));
      await indexed("index the Creator lock", lock.signatures);
      // The Tax Share at 60 s (spec 2.1 step 14): tried every second, since the chain's clock can trail this one and the
      // collection's preflight refuses it inside the window.
      const endsAt = await step.do("read when the Tax window ends", quick, () => taxWindowEnd(cfg, launch));
      if (endsAt > Date.now()) await step.sleepUntil("wait for the Tax window to end", endsAt);
      const collected = await step.do(
        "collect the Tax Share",
        { retries: { limit: 30, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
        () => collectTaxShare(cfg, key, launch),
      );
      await indexed("index the Tax Share's collection", collected.signatures);
      console.log(`Tax Share of ${launch}: ${collected.signatures[0] ?? "already collected"}, sent ${collected.sentLateMs ?? "-"} ms after the window ended`);
      const pushed = await step.do("push the Tax Share and close the launch", { retries: { limit: 10, delay: "5 seconds", backoff: "constant" }, timeout: "10 minutes" }, () =>
        pushTaxShare(cfg, key, launch),
      );
      await indexed("index the Tax Share's pushes", pushed.signatures);
    } else if (now.status === "scheduled" || now.status === "failed") {
      // A launch that has not opened by now cannot: its pot fell short, which the open's step found, and it is failed at
      // once; otherwise it is failed once the open is late.
      if (now.status === "scheduled" && !cannotOpen && now.lateAtMs > Date.now()) await step.sleepUntil("wait until the open is late", now.lateAtMs + 2_000);
      await step.do("fail the launch and refund every seat", { retries: { limit: 20, delay: "5 seconds", backoff: "constant" }, timeout: "10 minutes" }, () =>
        failAndRefund(cfg, key, launch),
      );
    }
    await step.do("close the nonce", quick, () => withDb((db) => closeLaunchNonce(db, cfg, key, launch)));
    await step.do("release the ticker", quick, () => withDb((db) => releaseTicker(db, launch)));
  }
}
