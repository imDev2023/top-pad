// The keeper's Workflow for an Instant launch (spec 10.2), keyed by its coin: it reads when the coin's Tax window ends,
// sleeps until then, and sends the window claim. It is the keeper's first Workflow; a Fair Open's adds its own steps
// (the upload, the open, the lock, the pushes, the Tax Share). Every step is safe to repeat.
import { address } from "@solana/kit";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { config, type Bindings } from "./env";
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
    await step.sleepUntil("wait for the Tax window to end", endsAt);
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
