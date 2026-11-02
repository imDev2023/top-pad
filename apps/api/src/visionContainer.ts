// The vision service's Durable Object (spec 10.2): one Python Container (apps/vision) computing PDQ and SSCD on CPU,
// asleep when idle. It wakes on a call and sleeps again VISION_SLEEP_AFTER after its last one, so a creator checking an
// image or two keeps it warm for the next, and nothing runs, or is paid for, between launches. The protected set's image
// batches put it to sleep as soon as they finish, unless a creator is using it. Loaded by the Worker only (./worker),
// never by the tests.
import { Container } from "@cloudflare/containers";
import type { Bindings } from "./env";
import type { FetchedSignatures, Signatures, VisionAnswer, VisionService } from "./vision";

/** How long the Container stays up after its last call: long enough for a creator's next image. */
export const VISION_SLEEP_AFTER = "3m";

/** How long after a creator's image check the batch leaves the Container up, for the creator's next image. */
const CREATOR_GRACE_MS = 3 * 60_000;

export class Vision extends Container<Bindings> implements VisionService {
  defaultPort = 8080;
  sleepAfter = VISION_SLEEP_AFTER;
  // The protected set's batches send it image URLs to fetch.
  enableInternet = true;
  /** Calls running now, and when a creator's image was last checked: a batch never stops the Container under them. */
  private inFlight = 0;
  private creatorCheckedAt = 0;

  async signatures(bytes: Uint8Array): Promise<VisionAnswer | { error: string; status: number }> {
    this.inFlight++;
    this.creatorCheckedAt = Date.now();
    try {
      return await this.sign(bytes);
    } finally {
      this.inFlight--;
      this.creatorCheckedAt = Date.now();
    }
  }

  private async sign(bytes: Uint8Array): Promise<VisionAnswer | { error: string; status: number }> {
    const { status } = await this.getState();
    const woke = status !== "running" && status !== "healthy";
    const started = Date.now();
    const res = await this.containerFetch("http://vision/signatures", { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } });
    const answerMs = Date.now() - started;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { error: body?.error ?? `the vision service answered ${res.status}`, status: res.status };
    }
    const signatures = (await res.json()) as Signatures;
    return { sha256: signatures.sha256, pdq: signatures.pdq, sscd: signatures.sscd, answerMs, woke };
  }

  async fetchSignatures(images: { id: string; url: string }[]): Promise<FetchedSignatures[]> {
    this.inFlight++;
    try {
      return await this.fetchAndSign(images);
    } finally {
      this.inFlight--;
    }
  }

  private async fetchAndSign(images: { id: string; url: string }[]): Promise<FetchedSignatures[]> {
    const res = await this.containerFetch("http://vision/signatures/fetch", {
      method: "POST",
      body: JSON.stringify({ images }),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(`the vision service answered ${res.status}: ${await res.text().catch(() => "")}`);
    const { results } = (await res.json()) as { results: (FetchedSignatures & Partial<Signatures>)[] };
    return results.map((r) => (r.ok ? { id: r.id, ok: true, sha256: r.sha256!, pdq: r.pdq!, sscd: r.sscd! } : { id: r.id, ok: false, error: r.error }));
  }

  /**
   * Stops the Container at once, unless a call is running or a creator checked an image in the last few minutes, who
   * may pick another: then it sleeps on its own, VISION_SLEEP_AFTER after its last call.
   */
  async sleep(): Promise<void> {
    if (this.inFlight > 0 || Date.now() - this.creatorCheckedAt < CREATOR_GRACE_MS) return;
    await this.stop();
  }
}
