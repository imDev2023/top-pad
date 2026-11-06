import { describe, expect, it } from "vitest";
import { ago, coinAmount, compactNumber, marketCapBars, ordinal, quoteAmount, quoteText, rawAmountOf, rawQuoteOf, scaledFigure, shareOf, SOL_UNIT, solAmount, span, tickLabels, typedAmount, typedQuote, type QuoteUnit } from "./format";

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

describe("a span of time", () => {
  it("reads in seconds, minutes, hours or days, whichever a sentence would use", () => {
    expect([1, 3, 119, 120, 3_599, 61_104, 172_800].map(span)).toEqual(
      ["1\u{a0}s", "3\u{a0}s", "119\u{a0}s", "2\u{a0}min", "60\u{a0}min", "17\u{a0}h", "2\u{a0}days"],
    );
  });
});

describe("an amount as typed", () => {
  it("is its raw units in the unit's places, or null when it is not a positive amount the unit holds", () => {
    expect(rawAmountOf("0.1", 9)).toBe(100_000_000n);
    expect(rawAmountOf(" 1,250.5 ", 6)).toBe(1_250_500_000n);
    expect(rawAmountOf(".5", 9)).toBe(500_000_000n);
    expect(rawAmountOf("2.", 9)).toBe(2_000_000_000n);
    expect(rawAmountOf("0.000000001", 9)).toBe(1n);
    expect(["", ".", "0", "0.0", "-1", "1e3", "0.0000001", "abc"].map((t) => rawAmountOf(t, 6))).toEqual(new Array(8).fill(null));
  });

  it("types back every place it needs", () => {
    expect(typedAmount(100_000_000n, 9)).toBe("0.1");
    expect(typedAmount(1_250_500_000n, 6)).toBe("1250.5");
    expect(typedAmount(3_000_000n, 6)).toBe("3");
    expect(rawAmountOf(typedAmount(123_456_789n, 6), 6)).toBe(123_456_789n);
  });
});

describe("shares and places", () => {
  it("write a share of supply to two places, rounded down, and a sliver as under 0.01%", () => {
    const supply = 1_000_000_000_000_000n;
    expect(shareOf(12_120_000_000_000n, supply)).toBe("1.21%");
    expect(shareOf(10_000_000_000_000n, supply)).toBe("1.00%");
    expect(shareOf("99999999999", supply.toString())).toBe("under 0.01%");
    expect(shareOf(0n, supply)).toBe("0.00%");
  });

  it("name places as English does", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 104].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "104th"]);
  });
});

describe("amounts in a coin's quote", () => {
  const USDC: QuoteUnit = { symbol: "USDC", decimals: 6, multiplier: 1 };
  const SPLIT: QuoteUnit = { symbol: "NVDAx", decimals: 8, multiplier: 2.5 };

  it("read raw units in the quote's own decimals, with its symbol", () => {
    expect(quoteText(99_980n, USDC, 6)).toBe("0.09998\u{a0}USDC");
    expect(quoteText(8_500_000_000n, SOL_UNIT, 2)).toBe("8.5\u{a0}SOL");
    expect(quoteAmount(84_983_000n, USDC, 2)).toBe("84.98");
  });

  it("show a stock's raw units through its multiplier, as a wallet shows them", () => {
    expect(quoteAmount(100_000_000n, SPLIT)).toBe("2.5");
    expect(scaledFigure("0.000000004", SPLIT)).toBeCloseTo(0.00000001, 15);
  });

  it("take a typed amount back to raw units, rounded down, through the multiplier", () => {
    expect(rawQuoteOf("0.5", USDC)).toBe(500_000n);
    expect(rawQuoteOf("2.5", SPLIT)).toBe(100_000_000n);
    expect(rawQuoteOf("0.0000001", USDC)).toBeNull();
    expect(typedQuote(100_000_000n, SPLIT)).toBe("2.5");
    expect(typedQuote(99_980n, USDC)).toBe("0.09998");
  });
});

describe("a chart through the quote's multiplier", () => {
  const candles = [
    { time: 60, open: "0.000000004", high: "0.000000006", low: "0.000000004", close: "0.000000005" },
    { time: 120, open: "0.000000005", high: "0.000000009", low: "0.000000005", close: "0.000000008" },
  ];
  const before: QuoteUnit = { symbol: "NVDAx", decimals: 8, multiplier: 1 };
  const split: QuoteUnit = { ...before, multiplier: 10.02 };

  it("rescales every candle alike when the multiplier changes, so no candle steps against another", () => {
    const a = marketCapBars(candles, 1_000_000_000, before);
    const b = marketCapBars(candles, 1_000_000_000, split);
    expect(a[0]!.close).toBeCloseTo(5, 9);
    for (const [i, bar] of b.entries()) {
      for (const k of ["open", "high", "low", "close"] as const) expect(bar[k] / a[i]![k]).toBeCloseTo(10.02, 9);
    }
    expect(b[1]!.close / b[0]!.close).toBeCloseTo(a[1]!.close / a[0]!.close, 12);
  });
});
