import { describe, expect, it } from "vitest";
import { parseDataItem, signDataItem } from "./dataItem";

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const anchor = new Uint8Array(32).fill(7);
const item = { data: new TextEncoder().encode('{"name":"Test"}'), tags: [{ name: "Content-Type", value: "application/json" }], anchor };

describe("ANS-104 data items", () => {
  it("signs an item that a bundler reads back with a valid signature, the same tags and data, and the same id", async () => {
    const signed = await signDataItem(seed, item);
    const parsed = await parseDataItem(signed.bytes);
    expect(parsed.valid).toBe(true);
    expect(parsed.id).toBe(signed.id);
    expect(parsed.tags).toEqual(item.tags);
    expect(new TextDecoder().decode(parsed.data)).toBe('{"name":"Test"}');
    expect(parsed.anchor).toEqual(anchor);
  });

  it("signs the same input to the same bytes and id, so the id is known before any upload", async () => {
    const a = await signDataItem(seed, item);
    const b = await signDataItem(seed, item);
    expect(b.id).toBe(a.id);
    expect(b.bytes).toEqual(a.bytes);
  });

  it("takes a Solana keypair's 64-byte secret key as well as its seed", async () => {
    const secretKey = new Uint8Array(64);
    secretKey.set(seed);
    expect((await signDataItem(secretKey, item)).id).toBe((await signDataItem(seed, item)).id);
  });

  it("reads a tampered item as invalid", async () => {
    const signed = await signDataItem(seed, item);
    const bytes = signed.bytes.slice();
    bytes[bytes.length - 1]! ^= 1;
    expect((await parseDataItem(bytes)).valid).toBe(false);
  });
});
