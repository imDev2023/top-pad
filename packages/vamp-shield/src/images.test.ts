import { describe, expect, it } from "vitest";
import { judgeImage, type ImageNeighbour } from "./images";
import { candidateKeys, type ProtectedCoin } from "./match";

const coin = (ticker: string): ProtectedCoin => ({ mint: `${ticker}-mint`, ticker, name: ticker, source: "test", keys: candidateKeys(ticker, ticker) });
const n = (ticker: string, pdqDistance: number | null, sscd: number | null, orientation: number | null = 0): ImageNeighbour => ({
  coin: coin(ticker),
  pdqDistance,
  orientation,
  sscd,
});

describe("judging an image against the Protected coins' images", () => {
  it("refuses a PDQ distance of 31 or less in any orientation, and reports the closest", () => {
    const judged = judgeImage([n("FAR", 90, 0.2), n("BONK", 31, 0.4, 4), n("PEPE", 12, 0.3, 1)]);
    expect(judged).toMatchObject({ verdict: "refused", by: "pdq", neighbour: { coin: { ticker: "PEPE" }, orientation: 1 } });
    expect(judgeImage([n("BONK", 31, null, 4)])).toMatchObject({ verdict: "refused", by: "pdq" });
    expect(judgeImage([n("BONK", 32, 0.1)])).toEqual({ verdict: "clear" });
  });

  it("refuses an SSCD similarity of 0.75 or more when no PDQ hash matches", () => {
    expect(judgeImage([n("BONK", 80, 0.75), n("PEPE", 70, 0.9)])).toMatchObject({ verdict: "refused", by: "sscd", neighbour: { coin: { ticker: "PEPE" } } });
    expect(judgeImage([n("BONK", null, 0.81)])).toMatchObject({ verdict: "refused", by: "sscd" });
  });

  it("prefers a PDQ match to a stronger SSCD one", () => {
    expect(judgeImage([n("SSCD", 70, 0.99), n("PDQ", 20, 0.5)])).toMatchObject({ verdict: "refused", by: "pdq", neighbour: { coin: { ticker: "PDQ" } } });
  });

  it("labels SSCD 0.60 to 0.75 by the most similar image, and clears below", () => {
    expect(judgeImage([n("BONK", 70, 0.6), n("PEPE", 60, 0.7499)])).toMatchObject({ verdict: "looks_like", neighbour: { coin: { ticker: "PEPE" } } });
    expect(judgeImage([n("BONK", 70, 0.5999)])).toEqual({ verdict: "clear" });
    expect(judgeImage([])).toEqual({ verdict: "clear" });
  });
});
