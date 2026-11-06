import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { amountsAt, CLUSTERS, DEVNET_USDC, NVDAX_MINT, WSOL_MINT } from "@top-pad/chain";
import { jupiterUsdPrices, livePrices, withOverrides } from "./prices";

const devnet = CLUSTERS.devnet!;
const [SOL_QUOTE, USDC_QUOTE, STAND_IN] = devnet.quotes as [(typeof devnet.quotes)[0], (typeof devnet.quotes)[0], (typeof devnet.quotes)[0]];

// What Jupiter's Price API v3 answered on 2026-11-06, trimmed: NVDAx carries its Scaled UI Amount config.
const ANSWER = {
  [WSOL_MINT]: { usdPrice: 89.42989687768483, decimals: 9 },
  [NVDAX_MINT]: { usdPrice: 185.10013915790154, decimals: 8, scaledUiConfig: { multiplier: 1.0009180758490996, usdPricePrescaled: 185.4150309225153 } },
};
const answering = (body: unknown, status = 200, asked: string[] = []) =>
  (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
const noRpc = {} as Parameters<typeof livePrices>[0];

describe("Jupiter's prices", () => {
  it("take the price per unscaled token for a Scaled UI Amount mint", async () => {
    const prices = await jupiterUsdPrices([WSOL_MINT, NVDAX_MINT], "key", answering(ANSWER));
    expect(prices.get(NVDAX_MINT)).toEqual({ digits: 1854150309225153n, scale: 13 });
    expect(prices.get(WSOL_MINT)).toEqual({ digits: 8942989687768483n, scale: 14 });
  });

  it("price devnet's stand-in xStock as NVDAx, in its own raw units, in one call", async () => {
    const asked: string[] = [];
    const readings = await livePrices(noRpc, "key", answering(ANSWER, 200, asked))([STAND_IN]);
    const reading = readings.get(STAND_IN.mint)!;
    expect(reading.price && amountsAt(reading.price, devnet.graduationTarget).step).toBe(482_323n);
    expect(reading).toMatchObject({ source: `Jupiter, as ${NVDAX_MINT}` });
    expect(asked).toEqual([`https://api.jup.ag/price/v3?ids=${WSOL_MINT},${NVDAX_MINT}`]);
  });

  it("leave a quote unpriced, with the reason, when Jupiter fails or does not price it", async () => {
    const down = await livePrices(noRpc, "key", answering({}, 503))([STAND_IN]);
    expect(down.get(STAND_IN.mint)).toEqual({ price: null, reason: "Jupiter's Price API answered 503" });
    const unpriced = await livePrices(noRpc, "key", answering({ [WSOL_MINT]: ANSWER[WSOL_MINT] }))([STAND_IN]);
    expect(unpriced.get(STAND_IN.mint)).toEqual({ price: null, reason: `Jupiter has no price for ${NVDAX_MINT}` });
  });
});

describe("the live price source", () => {
  it("prices SOL as itself and asks nothing for it", async () => {
    const readings = await livePrices(noRpc, null, answering(ANSWER))([SOL_QUOTE]);
    expect(readings.get(WSOL_MINT)).toEqual({ price: { num: 1n, den: 1n }, source: "SOL" });
  });

  it("leaves a DAMM v2 quote unpriced when its pool cannot be read", async () => {
    const failing = { getAccountInfo: () => ({ send: async () => Promise.reject(new Error("the RPC is down")) }) } as unknown as Parameters<typeof livePrices>[0];
    const readings = await livePrices(failing, null)([USDC_QUOTE]);
    expect(readings.get(DEVNET_USDC)).toEqual({ price: null, reason: "the RPC is down" });
  });

  it("takes an override for the quotes it names and the live price for the rest", async () => {
    const override = { num: 85n, den: 10_000n };
    const readings = await withOverrides(livePrices(noRpc, null, answering(ANSWER)), new Map([[DEVNET_USDC, override]]))([SOL_QUOTE, USDC_QUOTE]);
    expect(readings.get(DEVNET_USDC)).toEqual({ price: override, source: "override" });
    expect(readings.get(WSOL_MINT)).toMatchObject({ source: "SOL" });
    expect(address(DEVNET_USDC)).toBe(USDC_QUOTE.mint);
  });
});
