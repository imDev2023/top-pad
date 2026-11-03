// Solana's free public mainnet endpoint, read only, paced to its limits: about 10 calls of a method each 10 seconds
// (getBlock fewer), each method counted on its own, a 429 answered with `retry-after` (measured 2026-11-03). No key and
// no transaction: the evaluation only reads mainnet (spec 11.5).
export const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

/** How far apart one method's calls go out. */
const SPACING_MS: Record<string, number> = { getBlock: 1_800, default: 1_100 };
const ATTEMPTS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC errors that clear on a retry: a node behind, or a block not yet available on it. */
const TRANSIENT = new Set([-32004, -32005, -32014, -32016, -32603]);

export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (${code})`);
  }
}

/** A JSON-RPC caller over one endpoint, pacing each method and retrying what a free tier refuses for a while. */
export function publicRpc(url = PUBLIC_MAINNET, fetchImpl: typeof fetch = fetch): Rpc {
  const next = new Map<string, number>();
  const turn = async (method: string) => {
    const at = Math.max(Date.now(), next.get(method) ?? 0);
    next.set(method, at + (SPACING_MS[method] ?? SPACING_MS.default!));
    if (at > Date.now()) await sleep(at - Date.now());
  };
  const holdOff = (method: string, ms: number) => next.set(method, Math.max(next.get(method) ?? 0, Date.now() + ms));
  return async function call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await turn(method);
      let status = 0;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(120_000),
        });
        status = res.status;
        if (res.status === 429 || res.status >= 500) {
          await res.body?.cancel();
          holdOff(method, Number(res.headers.get("retry-after") ?? 10) * 1000);
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) {
          if (!TRANSIENT.has(body.error.code)) throw new RpcError(method, body.error.code, body.error.message);
          throw new Error(`${body.error.message} (${body.error.code})`);
        }
        return body.result as T;
      } catch (e) {
        if (e instanceof RpcError || attempt >= ATTEMPTS) throw e;
        if (status !== 429) await sleep(Math.min(30_000, 1_000 * attempt));
      }
    }
  };
}
