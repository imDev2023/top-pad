import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import {
  checkCurve,
  COIN_SUPPLY,
  curveA,
  FEE_DENOMINATOR,
  graduatedPoolFeeNumerator,
  heatConfigParameters,
  sniperTaxNumerator,
  type Curve,
} from "./configs";

// Meteora's SDK mirrors DBC's create_config arithmetic with its own BN code: a second implementation to agree with.
const require = createRequire(import.meta.url);
const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk");
const BN = require("bn.js");

const SOL = 1_000_000_000n;
const MAINNET_TARGET = 85n * SOL;
const DEVNET_TARGET = (85n * SOL) / 10n;

// Spec 3.3's exact values, as `create_config2` accepted them on devnet (2026-10-29).
const EXPECTED: Record<string, Curve> = {
  mainnet: {
    sqrtStartPrice: 112339987482345485n,
    points: [
      { sqrtPrice: 140424984352931857n, liquidity: 205974751014283308772739093917811n },
      { sqrtPrice: 380289371323205464n, liquidity: 96467846865034852561432211657574n },
    ],
  },
  devnet: {
    sqrtStartPrice: 35525023424642174n,
    points: [
      { sqrtPrice: 44406279280802718n, liquidity: 65134935096406298698081261517461n },
      { sqrtPrice: 120258058333485015n, liquidity: 30505811781359344453335435709689n },
    ],
  },
};

const percent = (numerator: bigint) => (Number(numerator) / Number(FEE_DENOMINATOR)) * 100;
// Market cap in SOL at a Q64.64 square-root price: price per raw unit times the raw supply.
const marketCap = (sqrtPrice: bigint) => Number((sqrtPrice * sqrtPrice * COIN_SUPPLY) >> 128n) / Number(SOL);

describe("curve A", () => {
  for (const [name, target] of [["mainnet", MAINNET_TARGET], ["devnet", DEVNET_TARGET]] as const) {
    describe(`at ${Number(target) / Number(SOL)} SOL (${name})`, () => {
      const curve = curveA(target);

      it("equals spec 3.3's integers exactly", () => {
        expect(curve).toEqual(EXPECTED[name]);
      });

      it("starts where @top-pad/chain prices a coin before its first trade, at the same target", () => {
        expect(CLUSTERS[name]).toMatchObject({ graduationTarget: target, sqrtStartPrice: curve.sqrtStartPrice });
      });

      it("graduates exactly at its last point, using the whole supply with nothing left over", () => {
        const check = checkCurve(curve, target);
        expect(check.migrationSqrtPrice).toBe(curve.points[1].sqrtPrice);
        expect(check.minimumSupply).toBe(COIN_SUPPLY);
        // DAMM v2's position spans DBC's whole price range, so the graduated pool takes a few coins over 20%.
        expect(check.migrationBaseAmount).toBeGreaterThan(COIN_SUPPLY / 5n);
        expect(check.swapBaseAmount + check.migrationBaseAmount).toBe(COIN_SUPPLY);
      });

      it("agrees with the SDK's own mirror of create_config", () => {
        const points = curve.points.map((p) => ({ sqrtPrice: new BN(p.sqrtPrice.toString()), liquidity: new BN(p.liquidity.toString()) }));
        const start = new BN(curve.sqrtStartPrice.toString());
        const threshold = new BN(target.toString());
        const migration = sdk.getMigrationThresholdPrice(threshold, start, points);
        const swapBase = sdk.getBaseTokenForSwap(start, migration, points);
        const migrationBase = sdk.getMigrationBaseToken(threshold, migration, sdk.MigrationOption.MET_DAMM_V2, 0);
        const minimum = sdk.getSwapAmountWithBuffer(swapBase, start, points).add(migrationBase);
        const check = checkCurve(curve, target);
        expect([migration, swapBase, migrationBase, minimum].map(String)).toEqual(
          [check.migrationSqrtPrice, check.swapBaseAmount, check.migrationBaseAmount, check.minimumSupply].map(String),
        );
      });

      it("keeps the decided shape", () => {
        const scale = Number(target) / Number(MAINNET_TARGET);
        // Spec 3.3: 37.09 SOL at the start and 425 SOL at Graduation, at 85 SOL; a tenth of each at 8.5.
        expect(marketCap(curve.sqrtStartPrice) / scale).toBeCloseTo(37.09, 2);
        expect(marketCap(curve.points[1].sqrtPrice) / scale).toBeCloseTo(425, 6);
        // A full pot (a fifth of the target) moves the price 1.5625x, so the public opens 1.25x above its average.
        const rise = Number(curve.points[0].sqrtPrice) / Number(curve.sqrtStartPrice);
        expect(rise * rise).toBeCloseTo(1.5625, 12);
        // The pot's segment holds exactly the pot cap, its quote rounded up as DBC rounds it.
        const potQuote = (curve.points[0].liquidity * (curve.points[0].sqrtPrice - curve.sqrtStartPrice) + (1n << 128n) - 1n) >> 128n;
        expect(potQuote).toBe(target / 5n);
        // ...and buys 36.67% of the supply.
        const potCoins = (curve.points[0].liquidity * (curve.points[0].sqrtPrice - curve.sqrtStartPrice)) / (curve.sqrtStartPrice * curve.points[0].sqrtPrice);
        expect(Number(potCoins) / Number(COIN_SUPPLY)).toBeCloseTo(0.3667, 4);
      });
    });
  }

  it("refuses a target that is not positive", () => {
    expect(() => curveA(0n)).toThrow();
  });
});

describe("the sniper tax", () => {
  it("falls from 99% in the creation slot to exactly 1.25% at 60 s (spec 3.2's table)", () => {
    expect(percent(sniperTaxNumerator(0)).toFixed(2)).toBe("99.00");
    expect(percent(sniperTaxNumerator(5)).toFixed(2)).toBe("90.85");
    expect(percent(sniperTaxNumerator(30)).toFixed(2)).toBe("50.12");
    expect(sniperTaxNumerator(60)).toBe(12_500_000n);
    expect(sniperTaxNumerator(3_600)).toBe(12_500_000n);
  });

  it("steps once a second", () => {
    expect(sniperTaxNumerator(5.9)).toBe(sniperTaxNumerator(5));
    expect(sniperTaxNumerator(5) - sniperTaxNumerator(6)).toBe(16_291_666n);
  });
});

describe("the graduated pool's fee", () => {
  const graduation = EXPECTED.mainnet!.points[1].sqrtPrice;
  // The square-root price at a multiple of the graduation market cap.
  const at = (multiple: number) => BigInt(Math.floor(Number(graduation) * Math.sqrt(multiple)));

  it("falls from 1.25% to 0.25% by 100x, following the price (spec 3.4)", () => {
    expect(graduatedPoolFeeNumerator(graduation, graduation)).toBe(12_500_000n);
    expect(percent(graduatedPoolFeeNumerator(graduation, at(2))).toFixed(2)).toBe("1.21");
    expect(percent(graduatedPoolFeeNumerator(graduation, at(10))).toFixed(2)).toBe("1.01");
    expect(percent(graduatedPoolFeeNumerator(graduation, at(50))).toFixed(2)).toBe("0.58");
    expect(graduatedPoolFeeNumerator(graduation, graduation * 10n)).toBe(2_500_000n);
    expect(graduatedPoolFeeNumerator(graduation, graduation * 30n)).toBe(2_500_000n);
  });

  it("climbs back when the price falls toward Graduation", () => {
    expect(graduatedPoolFeeNumerator(graduation, graduation / 2n)).toBe(12_500_000n);
  });
});

describe("the two configs", () => {
  it("differ only in the first swap's discount: on for Fair Open, off for Instant launch", () => {
    const fairOpen = heatConfigParameters("fairOpen", DEVNET_TARGET);
    const instant = heatConfigParameters("instant", DEVNET_TARGET);
    expect(fairOpen.enableFirstSwapWithMinFee).toBe(true);
    expect(instant.enableFirstSwapWithMinFee).toBe(false);
    expect({ ...fairOpen, enableFirstSwapWithMinFee: null }).toEqual({ ...instant, enableFirstSwapWithMinFee: null });
  });

  it("carry curve A and the target", () => {
    const params = heatConfigParameters("fairOpen", DEVNET_TARGET);
    expect(params.migrationQuoteThreshold).toBe(DEVNET_TARGET);
    expect(params.sqrtStartPrice).toBe(EXPECTED.devnet!.sqrtStartPrice);
    expect(params.curve).toEqual(EXPECTED.devnet!.points);
  });
});
