// Handing a coin's DBC creator role to another wallet from Heat's site (spec 7): DBC's own `transfer_pool_creator`, built
// here for the wallet holding the role to sign and send. Creator Earnings follow the role (spec 4), and the indexer
// follows every hand-over, made here or not; the coin stays on its launcher's record, marked "handed over to ...".
import { compileTransaction, createNoopSigner, createSolanaRpc, getBase64EncodedWireTransaction, type Address as KitAddress } from "@solana/kit";
import { creatorRoleMessage } from "@top-pad/chain";
import { fetchMaybeVirtualPool } from "@top-pad/clients/dbc";
import { Address, CreatorRoleRequest, CreatorRoleSent, type CreatorRoleOutcome, type PreparedCreatorRole } from "@top-pad/contract";
import { coins, pools } from "@top-pad/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { explorerUrl } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";
import { settleSignatures } from "./send";

const RPC_TIMEOUT_MS = 15_000;
/** How long the report waits for the hand-over to confirm before answering with what it has. */
const SETTLE_WAIT_MS = 30_000;
const short = (a: string) => `${a.slice(0, 4)}\u{2026}${a.slice(-4)}`;

/** `POST /coins/:mint/creator-role`: the hand-over's transaction, for the wallet holding the role now to sign. */
export async function prepareCreatorRole(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const mint = c.req.param("mint")!;
  const body = CreatorRoleRequest.safeParse(await c.req.json().catch(() => null));
  if (!Address.safeParse(mint).success || !body.success) return c.json({ error: "Say which wallet holds the role and which wallet takes it." }, 400);
  const { holder, to } = body.data;
  if (holder === to) return c.json({ error: "Hand the role to another wallet: this one holds it already." }, 400);
  const [row] = await db.select({ pool: pools.pool, config: pools.config }).from(coins).innerJoin(pools, eq(pools.mint, coins.mint)).where(eq(coins.mint, mint));
  if (!row) return c.json({ error: "Heat has no coin at this address." }, 404);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const pool = await fetchMaybeVirtualPool(rpc, row.pool as KitAddress, { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!pool.exists) return c.json({ error: "The coin's pool is not on chain." }, 404);
  if (pool.data.poolState.creator !== holder) return c.json({ error: `${short(holder)} does not hold this coin's creator role: ${short(pool.data.poolState.creator)} does.` }, 409);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const message = await creatorRoleMessage(
    { holder: createNoopSigner(holder as KitAddress), pool: row.pool as KitAddress, config: row.config as KitAddress, to: to as KitAddress, computeUnitPrice: cfg.computeUnitPrice },
    lifetime,
  );
  return c.json({ transaction: getBase64EncodedWireTransaction(compileTransaction(message)) } satisfies PreparedCreatorRole);
}

/**
 * `POST /coins/:mint/creator-role/sent`: the hand-over as the wallet sent it, settled against the chain and indexed at once,
 * so the records show it when asked next.
 */
export async function reportCreatorRole(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const sent = CreatorRoleSent.safeParse(await c.req.json().catch(() => null));
  if (!sent.success) return c.json({ error: "Send the hand-over's transaction signature." }, 400);
  const { signature } = sent.data;
  const outcome = (await settleSignatures(createSolanaRpc(cfg.rpcUrl), [signature], SETTLE_WAIT_MS)).get(signature);
  if (outcome?.status === "landed") await indexNow(c.env, [signature]);
  const body: CreatorRoleOutcome = { status: outcome?.status ?? "pending", error: outcome?.error ?? null, explorer: explorerUrl(cfg, "tx", signature) };
  return c.json(body);
}
