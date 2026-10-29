import { describe, expect, it } from "vitest";
import { CLUSTERS } from "./index";
import { COIN_SUPPLY, marketCapOfSqrtPrice, priceOfSqrtPrice, sniperTaxNumerator } from "./coin";

const Q64 = 1n << 64n;

describe("prices from a square-root price", () => {
  it("price one raw lamport per raw coin unit at a square-root price of 2^64: a thousandth of a SOL per coin", () => {
    expect(priceOfSqrtPrice(Q64, 9)).toBe("0.001000000000000000");
    expect(marketCapOfSqrtPrice(Q64, 9)).toBe("1000000.000000000000000000");
  });

  it("open curve A on devnet at a tenth of mainnet's 37.09 SOL market cap (spec 3.3)", () => {
    const devnet = Number(marketCapOfSqrtPrice(CLUSTERS.devnet!.sqrtStartPrice, 9));
    const mainnet = Number(marketCapOfSqrtPrice(CLUSTERS.mainnet!.sqrtStartPrice, 9));
    expect(mainnet).toBeCloseTo(37.09, 2);
    expect(devnet).toBeCloseTo(mainnet / 10, 6);
    // The market cap is the supply's worth at the price, to the price's last place.
    const price = priceOfSqrtPrice(CLUSTERS.devnet!.sqrtStartPrice, 9);
    expect(price).toBe("0.000000003708764872");
    expect(Number(price) * Number(COIN_SUPPLY / 1_000_000n)).toBeCloseTo(devnet, 6);
  });

  it("round down, keeping 18 places even for prices far below a lamport", () => {
    expect(priceOfSqrtPrice(1n << 32n, 9)).toBe("0.000000000000000000");
    expect(priceOfSqrtPrice(Q64 * 1000n, 9)).toBe("1000.000000000000000000");
  });
});

describe("the sniper tax", () => {
  it("counts whole seconds from the open, never before it and never past its 60th", () => {
    expect(sniperTaxNumerator(-3)).toBe(989_999_960n);
    expect(sniperTaxNumerator(0.99)).toBe(989_999_960n);
    expect(sniperTaxNumerator(1)).toBe(989_999_960n - 16_291_666n);
    expect(sniperTaxNumerator(60)).toBe(12_500_000n);
    expect(sniperTaxNumerator(86_400)).toBe(12_500_000n);
  });
});
