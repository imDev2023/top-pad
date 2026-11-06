// The band job in the Worker (ADR 0007, the band; spec 10.2): every five minutes, each quote Heat offers on the cluster
// is priced and its `QuoteSettings` brought back inside the band if it has drifted past it, by `@top-pad/quotes`. The
// quote manager key, which writes the settings and holds no funds, and the keeper key, which pays as the operations
// wallet down to its float's floor, come from Secrets Store; a deployment without either runs nothing. Prices come from
// Jupiter (with its key) and devnet's own DAMM v2 pools.
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import type { Db } from "@top-pad/db";
import { livePrices, rpcBandChain, reviewQuoteBands } from "@top-pad/quotes";
import { config, type Bindings, type SecretBinding } from "./env";
import { loadKeeper } from "./keeper";
import { sendAndConfirm } from "./send";

const RPC_TIMEOUT_MS = 15_000;

async function secretOf(value: SecretBinding | string | undefined): Promise<string | null> {
  if (!value) return null;
  return typeof value === "string" ? value : value.get();
}

/** The quote manager key from its binding, refused unless it is the key `@top-pad/chain` records for the cluster. */
async function loadQuoteManager(binding: SecretBinding | string, expected: Address): Promise<KeyPairSigner> {
  let secret: Uint8Array;
  try {
    secret = Uint8Array.from(JSON.parse((await secretOf(binding))!) as number[]);
  } catch {
    throw new Error("the quote manager key binding does not hold a keypair array");
  }
  const signer = await createKeyPairSignerFromBytes(secret);
  if (signer.address !== expected) throw new Error(`the bound quote manager key is ${signer.address}, not ${expected}`);
  return signer;
}

/** One run of the band job, its summary for `job_runs`; a deployment without the keys or configs it needs says why. */
export async function bandQuotes(db: Db, env: Bindings) {
  const cfg = config(env);
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys) return { skipped: `Heat has no configs or keys on ${cfg.cluster}` };
  if (!env.QUOTE_MANAGER_KEY) return { skipped: "the quote manager key is not bound to this deployment" };
  if (!env.KEEPER_KEY) return { skipped: "the keeper key is not bound to this deployment" };
  const keeperKey = env.KEEPER_KEY;
  const [keeper, quoteManager] = await Promise.all([
    loadKeeper(typeof keeperKey === "string" ? { get: async () => keeperKey } : keeperKey, heat.keys.keeper),
    loadQuoteManager(env.QUOTE_MANAGER_KEY, heat.keys.quoteManager),
  ]);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const send = async (instructions: Instruction[]) => {
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    const transaction = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keeper.signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    const signature = getSignatureFromTransaction(transaction);
    await sendAndConfirm(rpc, getBase64EncodedWireTransaction(transaction), signature);
    return signature;
  };
  return reviewQuoteBands({
    db,
    heat,
    chain: rpcBandChain(rpc, send),
    prices: livePrices(rpc, await secretOf(env.JUPITER_API_KEY)),
    quoteManager,
    payer: keeper.signer,
    floorLamports: cfg.keeperFloatMinLamports,
  });
}
