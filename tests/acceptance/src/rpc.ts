// Reads for the acceptance run's own checks: through the shared Helius devnet key when the environment has it (the
// compute scan reads every transaction of both programs during the run, too many for the public endpoint's limits), else
// the public endpoint; each call retried on a 429 or a dropped connection, as `tests/devnet/src/devnet.ts` does.
import { createDefaultRpcTransport, createSolanaRpcFromTransport, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type RpcTransport } from "@solana/kit";

export const readRpcUrl = () =>
  process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";

export function readRpc() {
  const transport = createDefaultRpcTransport({ url: readRpcUrl() });
  const patient: RpcTransport = async (request) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(request);
      } catch (e) {
        const status = isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ? e.context.statusCode : null;
        const passing = status === 429 || (status !== null && status >= 500) || (status === null && /fetch failed|ECONNRESET|socket/i.test(String(e)));
        if (attempt >= 8 || !passing) throw e;
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 10_000)));
      }
    }
  };
  return createSolanaRpcFromTransport(patient);
}
