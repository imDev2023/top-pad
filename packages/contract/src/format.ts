/** A Solana address as people read it: its first and last four characters. */
export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** Lamports as SOL, to as many places as the amount needs, at most `max`. */
export function sol(lamports: bigint | string, max = 4) {
  const value = Number(BigInt(lamports)) / 1e9;
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: max });
}

/** A size the way the launch flow talks about images: bytes under a kilobyte, whole KB above. */
export const kb = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`);

/** A digit as a subscript (U+2080 to U+2089), for the zeros a tiny price leads with. */
const subscript = (n: number) => String(n).replace(/\d/g, (d) => String.fromCodePoint(0x2080 + Number(d)));

/**
 * A positive number the way trading screens write it: a tiny one with its leading zeros counted in a subscript once
 * there are five or more (0.000000003709 is 0.0, a subscript 8, then 3709), keeping `significant` digits; a larger one
 * with up to `significant` decimals.
 */
export function compactNumber(value: number, significant = 4): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 0 : significant - 1 });
  // The power of ten of the first significant digit; rounding up a run of nines carries it one place left.
  let exponent = Math.floor(Math.log10(value));
  let digits = Math.round(value * 10 ** (significant - 1 - exponent));
  if (digits >= 10 ** significant) {
    exponent += 1;
    digits = Math.round(value * 10 ** (significant - 1 - exponent));
  }
  if (exponent >= 0) return String(digits / 10 ** (significant - 1));
  const zeros = -exponent - 1;
  const body = String(digits).replace(/0+$/, "") || "0";
  return zeros >= 5 ? `0.0${subscript(zeros)}${body}` : `0.${"0".repeat(zeros)}${body}`;
}

/** Coins in raw units (6 decimals) as people read them: 26,962.76, or 1.2M. */
export function coinAmount(raw: bigint | string, decimals = 6) {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return value >= 1_000_000
    ? value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A span of time as a sentence says it: 3 s, 4 min, 17 h, 2 days. */
export function span(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s}\u{a0}s`;
  if (s < 7_200) return `${Math.round(s / 60)}\u{a0}min`;
  if (s < 172_800) return `${Math.round(s / 3_600)}\u{a0}h`;
  return `${Math.round(s / 86_400)}\u{a0}days`;
}

/** How long ago, shortly: now, 12s, 4m, 3h, 2d. */
export function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Lamports as SOL for a figure that can be tiny, such as a fee: 0.000025 rather than 0. */
export const solAmount = (lamports: bigint | string, significant = 4) => compactNumber(Number(BigInt(lamports)) / 1e9, significant);

/**
 * Price-axis labels that tell neighbouring ticks apart: as many decimals as the gap between them needs, at most 12, so
 * a chart of nearly equal values never prints the same label twice.
 */
export function tickLabels(values: number[]): string[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i]! - sorted[i - 1]!);
  const decimals = Number.isFinite(step) && step > 0 ? Math.min(Math.max(Math.ceil(-Math.log10(step) - 1e-6), 0), 12) : 4;
  return values.map((v) => v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
}

/**
 * An amount as typed, in a unit of `decimals` places (9 for SOL, 6 for a coin): its raw units, or null when it is not
 * a positive amount the unit can hold. Commas group thousands and are ignored.
 */
export function rawAmountOf(text: string, decimals: number): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim().replaceAll(",", ""));
  if (!match || (match[1] === "" && !match[2]) || (match[2] ?? "").length > decimals) return null;
  const raw = BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  return raw > 0n ? raw : null;
}

/** Raw units as an amount to type back into a field: every place it needs, no grouping. */
export function typedAmount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / unit}${fraction ? `.${fraction}` : ""}`;
}

/** A part of a whole in raw units as a percentage to two places, rounded down: 1.21%, or "under 0.01%" for a sliver. */
export function shareOf(part: bigint | string, whole: bigint | string) {
  const hundredths = (BigInt(part) * 10_000n) / BigInt(whole);
  if (hundredths === 0n && BigInt(part) > 0n) return "under 0.01%";
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
}

/** A place in English: 1st, 2nd, 3rd, 4th, 11th, 22nd. */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * A coin's quote as its amounts read (ADR 0007): its symbol, decimals and the Scaled UI Amount multiplier in force now,
 * 1 for SOL and any mint without one. The API answers raw units and unscaled prices; pages show both through it.
 */
export type QuoteUnit = { symbol: string; decimals: number; multiplier: number };

/** SOL as a quote unit, for the amounts every launch and trade pays in SOL whatever its quote: rent and fees. */
export const SOL_UNIT: QuoteUnit = { symbol: "SOL", decimals: 9, multiplier: 1 };

/** Raw units of a quote as a number of whole units shown, through its multiplier. */
export const quoteValue = (raw: bigint | string, quote: QuoteUnit) => (Number(BigInt(raw)) / 10 ** quote.decimals) * quote.multiplier;

/** Raw units of a quote as people read them, through its multiplier, to as many places as it needs, at most `max`. */
export function quoteAmount(raw: bigint | string, quote: QuoteUnit, max = 4) {
  return quoteValue(raw, quote).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: Math.min(max, quote.decimals) });
}

/** The same with its symbol: "0.0999 USDC". */
export const quoteText = (raw: bigint | string, quote: QuoteUnit, max = 4) => `${quoteAmount(raw, quote, max)}\u{a0}${quote.symbol}`;

/** Raw units of a quote for a figure that can be tiny, such as a fee: 0.000025 rather than 0. */
export const quoteSmall = (raw: bigint | string, quote: QuoteUnit, significant = 4) => compactNumber(quoteValue(raw, quote), significant);

/** An unscaled price or market cap, as the API answers it, through the quote's multiplier. */
export const scaledFigure = (decimal: string, quote: QuoteUnit) => Number(decimal) * quote.multiplier;

/**
 * An amount of a quote as typed, which is what a wallet shows (through the multiplier), as raw units, rounded down to a
 * whole raw unit; null when it is not a positive amount the quote can hold.
 */
export function rawQuoteOf(text: string, quote: QuoteUnit): bigint | null {
  const shown = rawAmountOf(text, quote.decimals);
  if (shown === null) return null;
  if (quote.multiplier === 1) return shown;
  const raw = BigInt(Math.floor(Number(shown) / quote.multiplier));
  return raw > 0n ? raw : null;
}

/** Raw units of a quote as an amount to type back into a field, through its multiplier. */
export function typedQuote(raw: bigint, quote: QuoteUnit): string {
  if (quote.multiplier === 1) return typedAmount(raw, quote.decimals);
  return String(Number(quoteValue(raw, quote).toFixed(quote.decimals)));
}

/**
 * A coin's candles as its chart plots them, in market cap: each unscaled price times the fixed supply, through the
 * quote's multiplier in force now, the same factor for every candle. So a split or a dividend, which changes only the
 * multiplier, rescales the whole chart and leaves its shape, every candle's move against the one before, as it was.
 */
export function marketCapBars<T extends { time: number; open: string; high: string; low: string; close: string }>(candles: T[], supply: number, quote: QuoteUnit) {
  const scale = supply * quote.multiplier;
  return candles.map((c) => ({ time: c.time, open: Number(c.open) * scale, high: Number(c.high) * scale, low: Number(c.low) * scale, close: Number(c.close) * scale }));
}

/** A day as the pages write it, in UTC so the server and the browser agree: 13 Nov 2026. */
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A moment as the pages write it, in UTC: 13 Nov 2026, 09:41 UTC. */
export const momentOf = (iso: string) =>
  `${dayOf(iso)}, ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
