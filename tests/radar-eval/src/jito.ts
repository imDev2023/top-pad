// Jito's public bundle API, no key (spec 6.4, 11.5): production's `jitoApi` for which bundle a transaction landed in,
// and the bundle's own record for which transactions it held, the evaluation's ground truth.
import { jitoApi, type JitoSource } from "@top-pad/indexer";

export const JITO = "https://bundles.jito.wtf";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch that spaces its calls `spacingMs` apart and retries a 429, a 5xx or a dropped connection. */
export function pacedFetch(spacingMs: number, fetchImpl: typeof fetch = fetch): typeof fetch {
  let next = 0;
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const at = Math.max(Date.now(), next);
      next = at + spacingMs;
      if (at > Date.now()) await sleep(at - Date.now());
      try {
        const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(60_000) });
        if (res.status !== 429 && res.status < 500) return res;
        await res.body?.cancel();
        if (attempt >= 20) return res;
        next = Math.max(next, Date.now() + Number(res.headers.get("retry-after") ?? 5) * 1000);
      } catch (e) {
        if (attempt >= 20) throw e;
        await sleep(Math.min(30_000, 1_000 * attempt));
      }
    }
  };
}

export type JitoRecords = JitoSource & {
  /** The transactions a bundle held, in its order. */
  bundleTransactions(bundleId: string): Promise<string[]>;
};

export function jitoRecords(base = JITO, fetchImpl: typeof fetch = pacedFetch(150)): JitoRecords {
  return {
    ...jitoApi(base, fetchImpl),
    async bundleTransactions(bundleId) {
      const res = await fetchImpl(`${base}/api/v1/bundles/bundle/${bundleId}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Jito's bundle API answered ${res.status} for bundle ${bundleId}`);
      const body = (await res.json()) as { txSignatures?: string[] }[];
      const txs = body[0]?.txSignatures;
      if (!txs) throw new Error(`Jito's bundle API holds no transactions for bundle ${bundleId}`);
      return txs;
    },
  };
}
