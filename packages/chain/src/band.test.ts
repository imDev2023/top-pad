import { describe, expect, it } from "vitest";
import {
  amountsAt,
  driftBps,
  MIN_STEP,
  outOfBand,
  parseDecimal,
  priceFromSqrtPrice,
  priceFromUsd,
  SOL_PRICE,
  worthIn,
  type QuotePrice,
} from "./band";
import { CLUSTERS, DEVNET_USDC, WSOL_MINT } from "./index";

const DEVNET_TARGET = CLUSTERS.devnet!.graduationTarget;
const MAINNET_TARGET = CLUSTERS.mainnet!.graduationTarget;
// devnet USDC at 10.2323 a SOL, the price #88's hand-made pair was made at: 10,232,300 raw units a SOL.
const USDC_AT_10_2323: QuotePrice = { num: 10_232_300n, den: 1_000_000_000n };

describe("a pair's amounts at a price", () => {
  it("are SOL's own in SOL", () => {
    expect(amountsAt(SOL_PRICE, DEVNET_TARGET)).toEqual({ step: 10_000_000n, graduationTarget: 8_500_000_000n });
    expect(amountsAt(SOL_PRICE, MAINNET_TARGET)).toEqual({ step: 10_000_000n, graduationTarget: 85_000_000_000n });
  });

  it("match the USDC pair #88 made by hand: a step of 0.01 SOL's worth and a target of 850 of them", () => {
    expect(amountsAt(USDC_AT_10_2323, DEVNET_TARGET)).toEqual({ step: 102_323n, graduationTarget: 86_974_550n });
  });

  it("round the step to the nearest raw unit, halves up", () => {
    expect(worthIn(10n, { num: 1n, den: 4n })).toBe(3n); // 2.5
    expect(worthIn(10n, { num: 1n, den: 3n })).toBe(3n); // 3.33
    expect(worthIn(10n, { num: 2n, den: 3n })).toBe(7n); // 6.67
  });

  it("price an xStock in raw units from Jupiter's unscaled USD prices", () => {
    // NVDAx at $185.415 per unscaled token and SOL at $89.4299, on 2026-11-06: 0.01 SOL is 0.00482323 NVDAx.
    const nvdax = priceFromUsd(parseDecimal("185.4150309225153")!, parseDecimal(89.42989687768483)!, 8);
    const { step, graduationTarget } = amountsAt(nvdax, MAINNET_TARGET);
    expect(step).toBe(482_323n);
    expect(graduationTarget).toBe(482_323n * 8_500n);
    expect(Number(graduationTarget) / 1e8).toBeCloseTo((85 * 89.42989687768483) / 185.4150309225153, 3);
  });

  it("refuse a quote too dear to step in", () => {
    // A token of 0 decimals at 1,000 SOL: 0.01 SOL is a hundred-thousandth of one raw unit.
    expect(() => amountsAt({ num: 1n, den: 1_000_000_000_000n }, DEVNET_TARGET)).toThrow(/fewer than/);
    expect(amountsAt({ num: MIN_STEP, den: 10_000_000n }, DEVNET_TARGET).step).toBe(MIN_STEP);
  });
});

describe("the band", () => {
  const usdc = amountsAt(USDC_AT_10_2323, DEVNET_TARGET);
  const at = (usdcPerSol: number): QuotePrice => ({ num: BigInt(Math.round(usdcPerSol * 1e6)), den: 1_000_000_000n });

  it("holds a pair while its target is worth within 10% of the SOL target", () => {
    expect(outOfBand(usdc, USDC_AT_10_2323, DEVNET_TARGET)).toBe(false);
    // 9.998 USDC a SOL on 2026-11-06: the pair is worth 2.34% more than 8.5 SOL.
    expect(outOfBand(usdc, at(9.998), DEVNET_TARGET)).toBe(false);
    expect(driftBps(usdc.graduationTarget, DEVNET_TARGET, at(9.998))).toBe(234n);
    expect(outOfBand(usdc, at(9.31), DEVNET_TARGET)).toBe(false);
    expect(outOfBand(usdc, at(11.36), DEVNET_TARGET)).toBe(false);
  });

  it("moves once the price has moved it past 10%, either way", () => {
    // The pair stands from 10.2323 / 1.1 = 9.3021 to 10.2323 / 0.9 = 11.3692 USDC a SOL.
    expect(outOfBand(usdc, at(9.302), DEVNET_TARGET)).toBe(true);
    expect(outOfBand(usdc, at(11.37), DEVNET_TARGET)).toBe(true);
    expect(outOfBand(usdc, at(8.6979), DEVNET_TARGET)).toBe(true);
  });

  it("keeps exactly 10% inside", () => {
    const pair = { step: 9_900n, graduationTarget: 8_415_000n };
    // 8,415,000 raw units are worth exactly 1.1 times 8.5 SOL at 7,650,000 a target's worth, and 0.9 times at 9,350,000.
    const price = (num: bigint) => ({ num, den: DEVNET_TARGET });
    expect(outOfBand(pair, price(7_650_000n), DEVNET_TARGET)).toBe(false);
    expect(outOfBand(pair, price(7_649_999n), DEVNET_TARGET)).toBe(true);
    expect(outOfBand(pair, price(9_350_000n), DEVNET_TARGET)).toBe(false);
    expect(outOfBand(pair, price(9_350_001n), DEVNET_TARGET)).toBe(true);
    expect(driftBps(pair.graduationTarget, DEVNET_TARGET, price(7_650_000n))).toBe(1_000n);
  });

  it("judges a step written off the pair by itself", () => {
    expect(outOfBand({ ...usdc, step: (usdc.step * 12n) / 10n }, USDC_AT_10_2323, DEVNET_TARGET)).toBe(true);
  });

  it("never moves SOL", () => {
    expect(outOfBand(amountsAt(SOL_PRICE, DEVNET_TARGET), SOL_PRICE, DEVNET_TARGET)).toBe(false);
  });
});

describe("prices", () => {
  it("read a DAMM v2 pool's square-root price either way round", () => {
    // 10 USDC a SOL: 0.01 raw units of USDC a lamport, so with SOL as token A the square-root price is sqrt(0.01) = 0.1.
    const sqrt = (1n << 64n) / 10n;
    const a = priceFromSqrtPrice(sqrt, true);
    expect(worthIn(1_000_000_000n, a)).toBe(10_000_000n);
    const b = priceFromSqrtPrice((1n << 64n) * 10n, false);
    expect(worthIn(1_000_000_000n, b)).toBe(10_000_000n);
  });

  it("parse what a price API prints, and nothing else", () => {
    expect(parseDecimal("1.5")).toEqual({ digits: 15n, scale: 1 });
    expect(parseDecimal("2.5e-7")).toEqual({ digits: 25n, scale: 8 });
    expect(parseDecimal(3e21)).toEqual({ digits: 3_000_000_000_000_000_000_000n, scale: 0 });
    for (const bad of ["", "-1", "0", "0.000", "abc", Number.NaN, Number.POSITIVE_INFINITY]) expect(parseDecimal(bad)).toBeNull();
  });
});

describe("the quote lists", () => {
  it("offer SOL first on every cluster with Heat, priced as itself", () => {
    for (const heat of [CLUSTERS.devnet!, CLUSTERS.mainnet!]) {
      expect(heat.quotes[0]).toMatchObject({ mint: WSOL_MINT, price: { kind: "sol" } });
      expect(new Set(heat.quotes.map((q) => q.mint)).size).toBe(heat.quotes.length);
    }
  });

  it("hold the 22 cohort xStocks on mainnet, each priced under its own mint", () => {
    const xstocks = CLUSTERS.mainnet!.quotes.slice(1);
    expect(xstocks).toHaveLength(22);
    for (const q of xstocks) expect(q).toMatchObject({ decimals: 8, price: { kind: "jupiter", mint: q.mint } });
  });

  it("hold devnet USDC and the stand-in xStock on devnet, the stand-in priced as NVDAx", () => {
    const [, usdc, standIn] = CLUSTERS.devnet!.quotes;
    expect(usdc).toMatchObject({ mint: DEVNET_USDC, decimals: 6, price: { kind: "dammV2" } });
    const nvdax = CLUSTERS.mainnet!.quotes.find((q) => q.symbol === "NVDAx")!;
    expect(standIn).toMatchObject({ decimals: nvdax.decimals, price: { kind: "jupiter", mint: nvdax.mint } });
  });
});
