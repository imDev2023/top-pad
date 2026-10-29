// A coin's image and metadata on Arweave through Turbo (spec 2.2, 10.2). Both are signed as ANS-104 data items with the
// keeper key when a launch is prepared, so the creation transaction carries the address of a document nobody can change
// (the metadata names the image by its own data item id), and uploaded only when the Creator wallet has signed: an
// abandoned launch is never uploaded. The signed bytes wait in R2, which then keeps them as the Arweave cache (spec 10.4).
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

export type Coin = { name: string; ticker: string; mint: string; xHandle: string };

/**
 * The Metaplex off-chain document, the very bytes Arweave holds. The creator's X profile goes in `twitter`, where
 * terminals look for a coin's X link, so traders see who made it wherever the coin shows (spec 2.1 step 1).
 */
export function metadataDocument(coin: Coin, image: { url: string; type: ImageType }, site: string) {
  const x = `https://x.com/${coin.xHandle}`;
  return {
    name: coin.name,
    symbol: coin.ticker,
    image: image.url,
    twitter: x,
    createdOn: site,
    extensions: { twitter: x },
    properties: { category: "image", files: [{ uri: image.url, type: image.type }] },
  };
}

export const arweaveUrl = (gateway: string, id: string) => `${gateway}/${id}`;
const storageKey = (launchId: string, item: "image" | "metadata") => `launches/${launchId}/${item}`;

/** A 32-byte anchor fixed by the coin and the item, so preparing the same coin twice signs the same items. */
async function anchor(mint: string, item: "image" | "metadata") {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${APP_NAME} ${item} ${mint}`)));
}

export type SignedItems = {
  image: SignedDataItem & { contentType: ImageType; storageKey: string };
  metadata: SignedDataItem & { contentType: "application/json"; storageKey: string };
  imageUri: string;
  metadataUri: string;
};

/** Signs a launch's two items with the keeper key; `storeItems` keeps them once the launch is prepared. */
export async function signItems(
  keeperSecret: Uint8Array,
  launchId: string,
  coin: Coin,
  image: { bytes: Uint8Array; type: ImageType },
  urls: { gateway: string; site: string },
): Promise<SignedItems> {
  const tags = (contentType: string) => [
    { name: "Content-Type", value: contentType },
    { name: "App-Name", value: APP_NAME },
    { name: "Coin-Mint", value: coin.mint },
  ];
  const imageItem = await signDataItem(keeperSecret, { data: image.bytes, tags: tags(image.type), anchor: await anchor(coin.mint, "image") });
  const imageUri = arweaveUrl(urls.gateway, imageItem.id);
  const document = new TextEncoder().encode(JSON.stringify(metadataDocument(coin, { url: imageUri, type: image.type }, urls.site)));
  const metadataItem = await signDataItem(keeperSecret, { data: document, tags: tags("application/json"), anchor: await anchor(coin.mint, "metadata") });
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
 * Uploads a signed item from R2 through Turbo. Turbo holds every item by its id, so uploading one twice charges nothing
 * twice; a receipt for any other id means the bytes are not what was signed.
 */
export async function uploadItem(blobs: BlobStore, turbo: TurboUrls, item: { arweaveId: string; storageKey: string }): Promise<UploadReceipt> {
  const object = await blobs.get(item.storageKey);
  if (!object) throw new MetadataUploadFailed(`the signed item ${item.arweaveId} is missing from storage`);
  let receipt: UploadReceipt;
  try {
    receipt = await uploadDataItem(turbo, new Uint8Array(await object.arrayBuffer()));
  } catch (e) {
    // Turbo uploads up to 100 KiB free; a launch's items are kept under that, so a payment demand is a fault here.
    if (e instanceof PaymentRequired) throw new MetadataUploadFailed(`Turbo wants paying for ${e.bytes} bytes`);
    throw new MetadataUploadFailed((e as Error).message);
  }
  if (receipt.id !== item.arweaveId) throw new MetadataUploadFailed(`Turbo took the item as ${receipt.id}, not ${item.arweaveId}`);
  return receipt;
}

/**
 * Waits until a URI is served, up to `timeoutMs`: the creation transaction goes out once the metadata answers, so
 * terminals reading the new coin find it (spec 2.1 step 10 holds an open up to 10 s the same way). Says whether it was.
 */
export async function waitServed(url: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
    if (res?.ok) return true;
    if (Date.now() + pollMs > until) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
