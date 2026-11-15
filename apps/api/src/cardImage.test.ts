import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import type { FairnessCard } from "@top-pad/contract";
import { renderCardImage, type CardAssets } from "./cardImage";
import { CARD_HEIGHT, CARD_WIDTH } from "./cardSize";
import { config } from "./env";
import { countsOf, fairnessRows } from "./fairness";
import { testBindings } from "./test/fakes";

// The Fairness card image (spec 9, #58) drawn in Node from the same WebAssembly and fonts the Worker bundles
// (cardAssets.ts). `CARD_OUT=<folder>` keeps each image there to look at.
const require = createRequire(import.meta.url);
const bytes = (specifier: string) => {
  const b = readFileSync(require.resolve(specifier));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const assets = async (): Promise<CardAssets> => ({
  layout: bytes("satori/yoga.wasm"),
  resvg: bytes("@resvg/resvg-wasm/index_bg.wasm"),
  fonts: [
    { name: "IBM Plex Sans", data: bytes("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"), weight: 400 },
    { name: "IBM Plex Sans", data: bytes("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff"), weight: 600 },
    { name: "IBM Plex Mono", data: bytes("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff"), weight: 400 },
    { name: "Saira Condensed", data: bytes("@fontsource/saira-condensed/files/saira-condensed-latin-700-normal.woff"), weight: 700 },
  ],
});

const cfg = config(testBindings("postgres://unused"));
const SOL = CLUSTERS.devnet!.quotes[0]!;
const quote = { mint: SOL.mint, symbol: "SOL", decimals: 9, multiplier: 1, labels: [], explorer: "https://explorer.solana.com/address/x?cluster=devnet" };
const MINT = "8cWz1WmjBp2nN7JyKuJ8rMjQQYmex3f6aEaYZ6PwLJQh";
const WALLET = "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8";
const SIG = "5".repeat(87);
const record = {
  id: "0b8e7c3e-6c55-4d0f-9b0c-0d6a3c1e2f40",
  wallet: WALLET,
  x: { handle: "pixelpigeon", name: "Pixel Pigeon", avatarUrl: null },
  coins: 5,
  graduations: 1,
  graduationRate: 0.2,
  lastGraduatedAt: null,
  handedOver: 0,
  quiet: 1,
  marks: { verifiedCreator: true, verifiedHuman: false },
  barred: null,
  since: "2026-10-30T10:00:00.000Z",
};

/** A whole card from facts, as the API words it. */
function cardOf(coin: { name: string; ticker: string; launchMode: "fair_open" | "instant" }, facts: FairnessCard["facts"]): FairnessCard {
  const c = { mint: MINT, imageUri: null, quote, ...coin };
  const rows = fairnessRows(cfg, c, facts, new Date("2026-11-14T12:00:00Z"));
  return { ...c, counts: countsOf(rows), rows, facts, version: "0123456789abcdef", image: "https://api.example/x.png", servedAt: new Date().toISOString() };
}

const fairOpen = cardOf(
  { name: "Pigeon on Green", ticker: "PIGEON", launchMode: "fair_open" },
  {
    launch: { mode: "fair_open", launch: WALLET, people: 81, spent: "17000000000", coins: "277777777000000", price: "0.000000061200000220", identityHash: "ab".repeat(32), opened: SIG },
    creatorLock: { status: "locked", deposit: "500000000", coins: "3120000000000", escrow: WALLET, cliffAt: "2026-11-20T07:00:00.000Z", endsAt: "2026-12-13T07:00:00.000Z" },
    holdings: { wallet: WALLET, coins: "4100000000000", bought: "4100000000000" },
    liquidity: { curve: WALLET, graduated: null },
    radar: { linkedWallets: 0, linkedCoins: "0", earlyBuys: 2 },
    finding: null,
    record,
    keeper: { address: CLUSTERS.devnet!.keys!.keeper, signature: SIG },
    tax: { to: "depositors", collected: { total: "6840000000", paidSeats: 80, toTreasury: false, at: "2026-11-13T07:01:10.000Z", signature: SIG } },
  },
);

const bundled = cardOf(
  { name: "Baby Wif Hat With A Name Long Enough To Run Out Of Room", ticker: "BABYWIF", launchMode: "instant" },
  {
    launch: { mode: "instant", creation: SIG, creationBuy: "0" },
    creatorLock: null,
    holdings: { wallet: WALLET, coins: "0", bought: "0" },
    liquidity: { curve: WALLET, graduated: { at: "2026-11-02T05:53:30.000Z", pool: WALLET, creatorPosition: WALLET, heatPosition: WALLET } },
    radar: { linkedWallets: 6, linkedCoins: "310000000000000", earlyBuys: 0 },
    finding: { kind: "confirmed_creator_bundle", confirmedAt: "2026-11-13T19:00:00.000Z", publishedAt: "2026-11-16T19:00:00.000Z", appeal: "none" },
    record: { ...record, x: { handle: "hatdrop", name: "Hat", avatarUrl: null }, marks: { verifiedCreator: false, verifiedHuman: false }, barred: { ticker: "BABYWIF", mint: MINT, publishedAt: "2026-11-16T19:00:00.000Z" } },
    keeper: null,
    tax: { to: "heat", claimed: { amount: "8900000000", at: "2026-11-13T19:01:00.000Z", signature: SIG } },
  },
);

/** A PNG's width and height, from its IHDR chunk. */
const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

afterEach(() => vi.unstubAllGlobals());

describe("the Fairness card image", () => {
  it.each([
    ["fair-open", fairOpen],
    ["bundled", bundled],
  ])("draws the %s card as a 2:1 PNG under 5 MB", async (name, card) => {
    const png = await renderCardImage(card, { cluster: "devnet", web: "https://top-pad-web-devnet.rc-labs.workers.dev", assets });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sizeOf(png)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    expect(CARD_WIDTH / CARD_HEIGHT).toBe(2);
    expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);
    if (process.env.CARD_OUT) writeFileSync(join(process.env.CARD_OUT, `${name}.png`), png);
  });

  it("draws the coin's own picture, and its initials when the picture is of a kind it cannot embed", async () => {
    // A 1x1 PNG the gateway serves, then a WebP.
    const pixel = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      seen.push(input);
      return input.endsWith(".webp") ? new Response(new Uint8Array(8), { headers: { "content-type": "image/webp" } }) : new Response(pixel, { headers: { "content-type": "image/png" } });
    });
    const withPicture = await renderCardImage({ ...fairOpen, imageUri: "https://turbo-gateway.com/coin.png" }, { cluster: "devnet", web: "https://heat.example", assets });
    const initials = await renderCardImage({ ...fairOpen, imageUri: "https://turbo-gateway.com/coin.webp" }, { cluster: "devnet", web: "https://heat.example", assets });
    expect(seen).toEqual(["https://turbo-gateway.com/coin.png", "https://turbo-gateway.com/coin.webp"]);
    expect(sizeOf(withPicture)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    expect(Buffer.from(withPicture).equals(Buffer.from(initials))).toBe(false);
  });
});
