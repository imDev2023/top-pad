import { describe, expect, it } from "vitest";
import { ago, coinAmount, compactNumber, solAmount, tickLabels } from "./format";

const sub = (n: number) => String.fromCodePoint(0x2080 + n);

describe("compact numbers", () => {
  it("count a tiny price's leading zeros in a subscript, keeping four significant digits", () => {
    expect(compactNumber(0.000000003710919541)).toBe(`0.0${sub(8)}3711`);
    expect(compactNumber(0.00000004636)).toBe(`0.0${sub(7)}4636`);
  });

  it("write a number with few leading zeros out in full", () => {
    expect(compactNumber(0.0012)).toBe("0.0012");
    expect(compactNumber(0.000025)).toBe("0.000025");
    expect(compactNumber(0.0000025)).toBe(`0.0${sub(5)}25`);
    expect(compactNumber(0.5)).toBe("0.5");
  });

  it("round a run of nines up to one zero fewer", () => {
    expect(compactNumber(0.00099999)).toBe("0.001");
    expect(compactNumber(0.001)).toBe("0.001");
    expect(compactNumber(0.99999)).toBe("1");
  });

  it("give larger numbers their decimals, and none from a thousand up", () => {
    expect(compactNumber(3.710919541)).toBe("3.711");
    expect(compactNumber(425.4)).toBe("425.4");
    expect(compactNumber(12_345.6)).toBe("12,346");
    expect(compactNumber(0)).toBe("0");
  });
});

describe("amounts", () => {
  it("show a fee in SOL however small", () => {
    expect(solAmount(25_000n)).toBe("0.000025");
    expect(solAmount("9900000")).toBe("0.0099");
    expect(solAmount(1_500_000_000n)).toBe("1.5");
  });

  it("show coins in whole units, compact from a million", () => {
    expect(coinAmount(26_962_757_915n)).toBe("26,962.76");
    expect(coinAmount("366698903000000")).toBe("366.7M");
  });

  it("say how long ago shortly", () => {
    expect(ago(500)).toBe("now");
    expect(ago(12_400)).toBe("12s");
    expect(ago(4 * 60_000)).toBe("4m");
    expect(ago(3 * 3_600_000)).toBe("3h");
    expect(ago(2 * 86_400_000)).toBe("2d");
  });
});

describe("price-axis labels", () => {
  it("tell neighbouring ticks apart", () => {
    expect(tickLabels([3.7108, 3.7109, 3.711])).toEqual(["3.7108", "3.7109", "3.7110"]);
    expect(new Set(tickLabels([3.7109195, 3.7109196, 3.7109197])).size).toBe(3);
  });

  it("keep whole numbers whole", () => {
    expect(tickLabels([10, 20, 30])).toEqual(["10", "20", "30"]);
  });
});
