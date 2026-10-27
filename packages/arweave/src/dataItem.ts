// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: packages/arweave/src/dataItem.ts.
// ANS-104 data items signed with an ed25519 key, as Arweave bundlers such as ArDrive Turbo take them. Only what a
// launchpad needs: one data item per file, tagged, signed once and uploaded later, with its id known at signing time.
// The format: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
import { ed25519 } from "@noble/curves/ed25519.js";

/** ANS-104's signature type for a raw ed25519 signature over the deep hash; the owner is the 32-byte public key. */
export const ED25519_SIGNATURE_TYPE = 2;
const SIGNATURE_LENGTH = 64;
const OWNER_LENGTH = 32;
const ANCHOR_LENGTH = 32;

export type Tag = { name: string; value: string };

/**
 * WebCrypto and fetch want a view over a plain ArrayBuffer; nothing here is ever backed by a SharedArrayBuffer, so the
 * view is handed over as it is rather than copied.
 */
export const plainBytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export type DataItemInput = {
  data: Uint8Array;
  tags: Tag[];
  /** 32 bytes that make two otherwise identical items distinct, and the same item reproducible. */
  anchor: Uint8Array;
};

export type SignedDataItem = {
  /** The item's Arweave id: base64url of the SHA-256 of its signature, so it is known before any upload. */
  id: string;
  /** The whole item, header and data, as a bundler takes it. */
  bytes: Uint8Array;
};

const utf8 = (s: string) => new TextEncoder().encode(s);

const sha = async (algorithm: "SHA-256" | "SHA-384", data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(algorithm, plainBytes(data)));

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

type DeepHashChunk = Uint8Array | DeepHashChunk[];

/** Arweave's deep hash: a SHA-384 Merkle-like hash over a tree of byte strings, with the type and length of each node. */
export async function deepHash(chunk: DeepHashChunk): Promise<Uint8Array> {
  if (Array.isArray(chunk)) {
    let acc = await sha("SHA-384", utf8(`list${chunk.length}`));
    for (const item of chunk) acc = await sha("SHA-384", concat(acc, await deepHash(item)));
    return acc;
  }
  const tag = await sha("SHA-384", utf8(`blob${chunk.byteLength}`));
  return sha("SHA-384", concat(tag, await sha("SHA-384", chunk)));
}

/** Avro zig-zag varint, as ANS-104's tag encoding (an Avro array of {name, value} records) uses it. */
function zigzag(n: number) {
  let v = (n << 1) ^ (n >> 31);
  const out: number[] = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

function readZigzag(bytes: Uint8Array, at: number): [number, number] {
  let shift = 0;
  let v = 0;
  for (;;) {
    const b = bytes[at++];
    if (b === undefined) throw new Error("tag bytes end inside a varint");
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [(v >>> 1) ^ -(v & 1), at];
}

export function encodeTags(tags: Tag[]) {
  if (tags.length === 0) return new Uint8Array(0);
  const avroString = (s: string) => {
    const b = utf8(s);
    return concat(zigzag(b.byteLength), b);
  };
  return concat(zigzag(tags.length), ...tags.flatMap((t) => [avroString(t.name), avroString(t.value)]), zigzag(0));
}

export function decodeTags(bytes: Uint8Array): Tag[] {
  if (bytes.byteLength === 0) return [];
  const tags: Tag[] = [];
  let at = 0;
  for (;;) {
    let count: number;
    [count, at] = readZigzag(bytes, at);
    if (count === 0) break;
    if (count < 0) throw new Error("negative Avro block counts are not supported");
    for (let i = 0; i < count; i++) {
      const field = () => {
        let len: number;
        [len, at] = readZigzag(bytes, at);
        const s = new TextDecoder().decode(bytes.subarray(at, at + len));
        at += len;
        return s;
      };
      tags.push({ name: field(), value: field() });
    }
  }
  return tags;
}

function u64le(n: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

/** What the signature covers: the item's type, owner, target, anchor, tags and data, deep-hashed together. */
export function signingPayload(owner: Uint8Array, anchor: Uint8Array, tags: Tag[], data: Uint8Array) {
  return deepHash([utf8("dataitem"), utf8("1"), utf8(String(ED25519_SIGNATURE_TYPE)), owner, new Uint8Array(0), anchor, encodeTags(tags), data]);
}

/** Base64url without padding, as Arweave writes ids. Byte by byte, so it needs neither Buffer nor a large string. */
export function base64url(b: Uint8Array) {
  let binary = "";
  for (const byte of b) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function dataItemId(signature: Uint8Array) {
  return base64url(await sha("SHA-256", signature));
}

/**
 * Signs one data item with an ed25519 secret key (a Solana keypair's 64-byte secret key, or its 32-byte seed). The same
 * key, anchor, tags and data always sign to the same bytes and the same id.
 */
export async function signDataItem(secretKey: Uint8Array, item: DataItemInput): Promise<SignedDataItem> {
  if (item.anchor.byteLength !== ANCHOR_LENGTH) throw new Error(`an anchor is ${ANCHOR_LENGTH} bytes`);
  const seed = secretKey.subarray(0, 32);
  const owner = ed25519.getPublicKey(seed);
  const signature = ed25519.sign(await signingPayload(owner, item.anchor, item.tags, item.data), seed);
  const tags = encodeTags(item.tags);
  const bytes = concat(
    Uint8Array.from([ED25519_SIGNATURE_TYPE, 0]),
    signature,
    owner,
    Uint8Array.from([0]),
    Uint8Array.from([1]),
    item.anchor,
    u64le(item.tags.length),
    u64le(tags.byteLength),
    tags,
    item.data,
  );
  return { id: await dataItemId(signature), bytes };
}

export type ParsedDataItem = {
  id: string;
  owner: Uint8Array;
  anchor: Uint8Array | null;
  tags: Tag[];
  data: Uint8Array;
  /** Whether the signature is the owner's over the item. */
  valid: boolean;
};

/** Reads an ed25519-signed item back, as a bundler does, checking its signature. */
export async function parseDataItem(bytes: Uint8Array): Promise<ParsedDataItem> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== ED25519_SIGNATURE_TYPE) throw new Error(`unsupported signature type ${view.getUint16(0, true)}`);
  let at = 2;
  const signature = bytes.subarray(at, (at += SIGNATURE_LENGTH));
  const owner = bytes.subarray(at, (at += OWNER_LENGTH));
  const hasTarget = bytes[at++];
  if (hasTarget) throw new Error("targets are not supported");
  const hasAnchor = bytes[at++];
  const anchor = hasAnchor ? bytes.subarray(at, (at += ANCHOR_LENGTH)) : null;
  const tagCount = Number(view.getBigUint64(at, true));
  at += 8;
  const tagUint8Array = Number(view.getBigUint64(at, true));
  at += 8;
  const tags = decodeTags(bytes.subarray(at, (at += tagUint8Array)));
  if (tags.length !== tagCount) throw new Error(`the header says ${tagCount} tags, the tag bytes hold ${tags.length}`);
  const data = bytes.subarray(at);
  const payload = await signingPayload(owner, anchor ?? new Uint8Array(0), tags, data);
  return { id: await dataItemId(signature), owner, anchor, tags, data, valid: ed25519.verify(signature, payload, owner) };
}
