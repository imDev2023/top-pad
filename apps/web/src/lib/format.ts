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
