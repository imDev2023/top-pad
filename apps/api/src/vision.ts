// The vision service's client (spec 10.2): PDQ in all 8 orientations and SSCD, computed by the Python Container in
// apps/vision behind the `Vision` Durable Object (./visionContainer, loaded by the Worker only, so the API's tests in
// Node never import `cloudflare:workers`). The Container sleeps when idle; a call wakes it.
import type { Bindings } from "./env";

/** An image's signatures: its bytes' SHA-256, PDQ with its quality and its 8 orientations (the unrotated one first), SSCD. */
export type Signatures = {
  sha256: string;
  pdq: { bits: string; quality: number; dihedral: string[] };
  sscd: number[];
};

/** What the vision service answers for an image the API sends it, with how long it took and whether it woke for it. */
export type VisionAnswer = Signatures & { answerMs: number; woke: boolean };

/** One image the vision service fetched itself, by the id the caller gave it. */
export type FetchedSignatures = ({ id: string; ok: true } & Signatures) | { id: string; ok: false; error: string };

/** The `Vision` Durable Object's RPC methods, which the Worker calls through its binding. */
export interface VisionService {
  signatures(bytes: Uint8Array): Promise<VisionAnswer | { error: string; status: number }>;
  fetchSignatures(images: { id: string; url: string }[]): Promise<FetchedSignatures[]>;
  /** Puts the Container to sleep at once, after a batch, rather than when it has been idle for its sleepAfter. */
  sleep(): Promise<void>;
}

/** The one vision Container: every call goes to the same instance, so a warm one serves them all. */
export function visionOf(env: Bindings): VisionService | null {
  const namespace = env.VISION;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName("vision")) as unknown as VisionService;
}

/**
 * The PDQ orientations in the order the vision service returns them (pdqhash's, measured in apps/vision): the original,
 * turned 90 degrees anticlockwise, 180, 90 clockwise, flipped top to bottom, mirrored, then the transpose and the
 * transverse. A candidate's orientation that matches a Protected image's original undoes the copier's turn or flip, so
 * each is named as the copy was made.
 */
export const ORIENTATIONS = [
  "as it is",
  "rotated a quarter turn",
  "rotated half a turn",
  "rotated a quarter turn",
  "flipped upside down",
  "mirrored",
  "mirrored and rotated a quarter turn",
  "mirrored and rotated a quarter turn",
] as const;
