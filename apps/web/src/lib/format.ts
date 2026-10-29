/** A Solana address as people read it: its first and last four characters. */
export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** Lamports as SOL, to as many places as the amount needs, at most `max`. */
export function sol(lamports: bigint | string, max = 4) {
  const value = Number(BigInt(lamports)) / 1e9;
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: max });
}

/** A size the way the launch flow talks about images: bytes under a kilobyte, whole KB above. */
export const kb = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`);
