// A coin's image and metadata on Arweave through Turbo (spec 2.1 step 5, 2.2, 10.2). Both are signed as ANS-104 data items
// when a launch is prepared, so the creation transaction carries the address of a document nobody can change (the
// metadata names the image by its own data item id), and uploaded only once the launch goes ahead: an abandoned launch is
// never uploaded. The signed bytes wait in R2, which then keeps them as the Arweave cache (spec 10.4).
import { PaymentRequired, signDataItem, uploadDataItem, type SignedDataItem, type TurboUrls, type UploadReceipt } from "@top-pad/arweave";
import type { BlobStore } from "./env";

const APP_NAME = "Heat";

/** The image types a coin may use, sniffed from the bytes rather than trusted from the upload. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: apps/api/src/images.ts.
/** Detects the image type from its first bytes, so a mislabelled upload can't be served as something else. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** A coin as its metadata names it; `xHandle` is the creator's linked X account, null when they linked none (ADR 0008). */
export type Coin = { name: string; ticker: string; mint: string; xHandle: string | null };

/**
 * The Metaplex off-chain document, the very bytes Arweave holds. A creator who linked X has their X profile in
 * `twitter`, where terminals look for a coin's X link, so traders see who made it wherever the coin shows (spec 2.1 step
 * 1); a creator who linked none has no `twitter` at all, never an empty one.
 */
export function metadataDocument(coin: Coin, image: { url: string; type: ImageType }, site: string) {
  const x = coin.xHandle ? `https://x.com/${coin.xHandle}` : null;
  return {
    name: coin.name,
    symbol: coin.ticker,
    image: image.url,
    ...(x ? { twitter: x } : {}),
    createdOn: site,
    ...(x ? { extensions: { twitter: x } } : {}),
    properties: { category: "image", files: [{ uri: image.url, type: image.type }] },
  };
}

export const arweaveUrl = (gateway: string, id: string) => `${gateway}/${id}`;
const storageKey = (launchId: string, item: "image" | "metadata") => `launches/${launchId}/${item}`;

/** A 32-byte anchor fixed by the coin and the item, so the keeper key signs the same items for the same coin. */
async function anchor(mint: string, item: "image" | "metadata") {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${APP_NAME} ${item} ${mint}`)));
}

export type SignedItems = {
  image: SignedDataItem & { contentType: ImageType; storageKey: string };
  metadata: SignedDataItem & { contentType: "application/json"; storageKey: string };
  imageUri: string;
  metadataUri: string;
};

/**
 * Who signs a launch's items. An Instant launch's go up as the coin is created, signed by the keeper key and tagged with
 * Heat's name and the coin's mint. A Fair Open's are `sealed`: they go up 15 s before the open, and Arweave gateways
 * list a fresh item by its owner and its tags at once (turbo-gateway.com's GraphQL, 2026-11-02, #50), so each Fair Open's
 * pair is signed by a key made for it alone, dropped once it has signed, as the mint key is (spec 10.3), and carries its
 * content type only: nothing in either points at Heat, the keeper or the coin before the open.
 */
export type ItemSigner = { keeper: Uint8Array } | "sealed";

/** Signs a launch's two items; `storeItems` keeps them once the launch is prepared. */
export async function signItems(
  signer: ItemSigner,
  launchId: string,
  coin: Coin,
  image: { bytes: Uint8Array; type: ImageType },
  urls: { gateway: string; site: string },
): Promise<SignedItems> {
  const sealed = signer === "sealed";
  // An ed25519 seed, which is all `signDataItem` reads of a key; the sealed one lives only in this call.
  const secret = sealed ? crypto.getRandomValues(new Uint8Array(32)) : signer.keeper;
  const tags = (contentType: string) => [
    { name: "Content-Type", value: contentType },
    ...(sealed
      ? []
      : [
          { name: "App-Name", value: APP_NAME },
          { name: "Coin-Mint", value: coin.mint },
        ]),
  ];
  const imageItem = await signDataItem(secret, { data: image.bytes, tags: tags(image.type), anchor: await anchor(coin.mint, "image") });
  const imageUri = arweaveUrl(urls.gateway, imageItem.id);
  const document = new TextEncoder().encode(JSON.stringify(metadataDocument(coin, { url: imageUri, type: image.type }, urls.site)));
  const metadataItem = await signDataItem(secret, { data: document, tags: tags("application/json"), anchor: await anchor(coin.mint, "metadata") });
  if (sealed) secret.fill(0);
  return {
    image: { ...imageItem, contentType: image.type, storageKey: storageKey(launchId, "image") },
    metadata: { ...metadataItem, contentType: "application/json" as const, storageKey: storageKey(launchId, "metadata") },
    imageUri,
    metadataUri: arweaveUrl(urls.gateway, metadataItem.id),
  };
}

/** Keeps a prepared launch's signed items in R2 until it is submitted: nothing is stored for a launch refused first. */
export async function storeItems(blobs: BlobStore, items: SignedItems) {
  for (const item of [items.image, items.metadata]) {
    await blobs.put(item.storageKey, item.bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  }
}

export class MetadataUploadFailed extends Error {}

/**
 * Turbo's own words with the item's id taken out. A sealed coin's metadata id is its URI (spec 2.1 step 5), so no error,
 * and no log made of one, may name it before the open.
 */
const withoutId = (message: string, id: string) => message.split(id).join("<the item>");

/**
 * Uploads a signed item from R2 through Turbo. Turbo holds every item by its id, so uploading one twice charges nothing
 * twice; a receipt for any other id means the bytes are not what was signed. Its errors name the item by its kind only.
 */
export async function uploadItem(
  blobs: BlobStore,
  turbo: TurboUrls,
  item: { item: "image" | "metadata"; arweaveId: string; storageKey: string },
): Promise<UploadReceipt> {
  const object = await blobs.get(item.storageKey);
  if (!object) throw new MetadataUploadFailed(`the signed ${item.item} is missing from storage`);
  let receipt: UploadReceipt;
  try {
    receipt = await uploadDataItem(turbo, new Uint8Array(await object.arrayBuffer()));
  } catch (e) {
    // Turbo uploads up to 100 KiB free; a launch's items are kept under that, so a payment demand is a fault here.
    if (e instanceof PaymentRequired) throw new MetadataUploadFailed(`Turbo wants paying for the ${item.item}'s ${e.bytes} bytes`);
    throw new MetadataUploadFailed(`the ${item.item}: ${withoutId((e as Error).message, item.arweaveId)}`);
  }
  if (receipt.id !== item.arweaveId) throw new MetadataUploadFailed(`Turbo took the ${item.item} under an id other than the one signed`);
  return receipt;
}

/**
 * Waits until a URI is served, up to `timeoutMs`, and says when it first was, or null if it was not: the creation
 * transaction goes out once the metadata answers, so terminals reading the new coin find it (spec 2.1 step 10 holds an
 * open up to 10 s the same way).
 */
export async function servedAt(url: string, timeoutMs: number, pollMs = 250): Promise<Date | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    // Each ask ends by the deadline, so a gateway that hangs holds nobody past it.
    const signal = AbortSignal.timeout(Math.max(until - Date.now(), 1));
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal }).catch(() => null);
    if (res?.ok) return new Date();
    if (Date.now() + pollMs > until) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Whether a URI is served within `timeoutMs`. */
export const waitServed = async (url: string, timeoutMs: number, pollMs = 500) => (await servedAt(url, timeoutMs, pollMs)) !== null;
