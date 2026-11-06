// Graduation (spec 2.3, 10.2): once a Heat coin's curve holds its Graduation Target, Heat's keeper migrates it into DAMM
// v2, since Meteora's own keepers migrate only at 10 SOL on mainnet and anyone may; then it has the fee program split the
// partner's surplus and burn any leftover. Every step reads the chain first and does only what is undone, so each runs
// again safely. Heat's LP fees are claimed to the treasury by the cron, whenever its position has accrued enough to be
// worth a transaction.
import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { and, eq, sql } from "drizzle-orm";
import {
  burnLeftoverInstructions,
  fetchLookupTable,
  graduating,
  lpFeeClaimInstructions,
  migrationInstructions,
  MIGRATION_PROGRESS,
  positionAddresses,
  surplusClaimInstructions,
  surplusOf,
  type GraduatedPosition,
  type Graduating,
} from "@top-pad/chain";
import { fetchPool, fetchPosition } from "@top-pad/clients/damm-v2";
import { fetchPoolConfig, fetchVirtualPool, type PoolState } from "@top-pad/clients/dbc";
import { fetchMaybeCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import { coins, graduations, pools, type Db } from "@top-pad/db";
import { unclaimedPositionFees } from "@top-pad/meteora/damm";
import { config, type Bindings, type Config, type SecretBinding } from "./env";
import { loadKeeper, type Keeper } from "./keeper";
import { sendAndConfirm } from "./send";

type Rpc = ReturnType<typeof createSolanaRpc>;
const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });

/** What one Workflow needs to graduate a coin: the coin. */
export type GraduationParams = { mint: string };

/** A Heat coin's curve as the chain holds it now, and what its Graduation still needs. */
export type CurveState = {
  pool: Graduating;
  state: PoolState;
  graduationTarget: bigint;
  complete: boolean;
  migrated: boolean;
  surplusSplit: boolean;
  leftoverBurnt: boolean;
};

/** A Heat coin's curve, by its record: null for a mint no record lists, which Heat's keeper never graduates. */
export async function readCurve(cfg: Config, mint: Address): Promise<CurveState | null> {
  const heat = cfg.heat;
  if (!heat) throw new Error(`Heat has no configs on ${cfg.cluster}`);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const record = await fetchMaybeCoinRecord(rpc, (await findCoinRecordPda({ mint }))[0], limited());
  if (!record.exists) return null;
  const { poolState: state } = (await fetchVirtualPool(rpc, record.data.pool, limited())).data;
  // The coin's quote is its config's, SOL or another (ADR 0007).
  const { migrationQuoteThreshold, quoteMint } = (await fetchPoolConfig(rpc, state.config, limited())).data;
  return {
    pool: graduating(record.data.pool, state, quoteMint),
    state,
    graduationTarget: migrationQuoteThreshold,
    complete: state.quoteReserve >= migrationQuoteThreshold,
    migrated: state.migrationProgress === MIGRATION_PROGRESS.createdPool,
    surplusSplit: state.isPartnerWithdrawSurplus !== 0,
    leftoverBurnt: state.isWithdrawLeftover !== 0,
  };
}

let tableAsked: ReturnType<typeof fetchLookupTable> | null = null;

/** A transaction of `instructions` from our keeper, through Heat's shared lookup table, sent and confirmed. */
async function keeperSends(cfg: Config, rpc: Rpc, keeper: Keeper, instructions: Instruction[]): Promise<string> {
  if (!cfg.heat?.lookupTable) throw new Error(`Heat has no shared lookup table on ${cfg.cluster}`);
  tableAsked ??= fetchLookupTable(rpc, cfg.heat.lookupTable);
  tableAsked.catch(() => (tableAsked = null));
  const table = await tableAsked;
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const transaction = await signTransactionMessageWithSigners(
    compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keeper.signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
      { [table.address]: table.addresses },
    ),
  );
  const signature = getSignatureFromTransaction(transaction);
  await sendAndConfirm(createSolanaRpc(cfg.rpcUrl), getBase64EncodedWireTransaction(transaction), signature);
  return signature;
}

async function keeperOf(cfg: Config, keeperKey: SecretBinding): Promise<Keeper> {
  if (!cfg.heat?.keys) throw new Error(`Heat has no keeper on ${cfg.cluster}`);
  return loadKeeper(keeperKey, cfg.heat.keys.keeper);
}

/** What a Graduation step did: the transaction it sent, or none when the chain showed it done. */
export type GraduationSent = { signature: string | null };

/**
 * The migration, unless the coin has migrated: DBC's `migration_damm_v2`, signed by the keeper and two new position NFT
 * keys. Refused for a curve that is not complete; one landed by anyone else is found done.
 */
export async function sendMigration(cfg: Config, keeperKey: SecretBinding, mint: Address): Promise<GraduationSent> {
  const curve = await readCurve(cfg, mint);
  if (!curve) throw new Error(`${mint} has no CoinRecord: Heat graduates only its own coins`);
  if (curve.migrated) return { signature: null };
  if (!curve.complete) throw new Error(`${mint}'s curve holds ${curve.state.quoteReserve} of its ${curve.graduationTarget} target`);
  const keeper = await keeperOf(cfg, keeperKey);
  const [firstPositionNft, secondPositionNft] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const instructions = await migrationInstructions({ pool: curve.pool, payer: keeper.signer, firstPositionNft, secondPositionNft, computeUnitPrice: cfg.computeUnitPrice });
  return { signature: await keeperSends(cfg, createSolanaRpc(cfg.rpcUrl), keeper, instructions) };
}

/** The surplus's split, unless it has run: the fee program's `claim_surplus`, half to the creator role holder. */
export async function sendSurplusClaim(cfg: Config, keeperKey: SecretBinding, mint: Address): Promise<GraduationSent> {
  const curve = await readCurve(cfg, mint);
  if (!curve) throw new Error(`${mint} has no CoinRecord`);
  if (curve.surplusSplit) return { signature: null };
  if (!curve.complete) throw new Error(`${mint}'s curve is not complete`);
  const keeper = await keeperOf(cfg, keeperKey);
  const instructions = await surplusClaimInstructions({
    pool: curve.pool,
    creator: curve.state.creator,
    treasury: cfg.heat!.keys!.treasury,
    surplus: surplusOf(curve.state.quoteReserve, curve.graduationTarget),
    payer: keeper.signer,
    computeUnitPrice: cfg.computeUnitPrice,
  });
  return { signature: await keeperSends(cfg, createSolanaRpc(cfg.rpcUrl), keeper, instructions) };
}

/** The leftover's burn, unless it has run: the fee program's `burn_leftover`, once the coin has migrated. */
export async function sendLeftoverBurn(cfg: Config, keeperKey: SecretBinding, mint: Address): Promise<GraduationSent> {
  const curve = await readCurve(cfg, mint);
  if (!curve) throw new Error(`${mint} has no CoinRecord`);
  if (curve.leftoverBurnt) return { signature: null };
  if (!curve.migrated) throw new Error(`${mint} has not migrated`);
  const keeper = await keeperOf(cfg, keeperKey);
  const instructions = await burnLeftoverInstructions({ pool: curve.pool, payer: keeper.signer, computeUnitPrice: cfg.computeUnitPrice });
  return { signature: await keeperSends(cfg, createSolanaRpc(cfg.rpcUrl), keeper, instructions) };
}

/** The keeper's Workflows for Graduation, or null where they are not bound (the API's tests). */
const graduations$ = (env: Bindings) => env.GRADUATIONS ?? null;

/**
 * Starts the Graduation Workflow for a coin, keyed by its mint, unless one has started already: the indexer seeing its
 * curve complete, the browser's fast path reporting the trade that completed it and the cron's sweep may each ask. One
 * that failed is started again, since every step is safe to repeat.
 */
export async function startGraduation(env: Bindings, mint: string): Promise<void> {
  const workflows = graduations$(env);
  if (!workflows) return;
  try {
    await workflows.create({ id: mint, params: { mint } });
  } catch (e) {
    const instance = await workflows.get(mint).catch(() => null);
    if (!instance) throw e;
    const { status } = await instance.status();
    if (status === "errored" || status === "terminated") await instance.restart();
  }
}

/**
 * The cron's sweep: every Heat coin whose curve the indexer saw complete, or whose quote reserve reached the target, and
 * which has no Graduation recorded, or whose leftover is not yet burnt, has its Workflow started, or started again if
 * it failed. A coin the other paths missed graduates within minutes.
 */
export async function sweepGraduations(db: Db, env: Bindings): Promise<{ due: number }> {
  const heat = config(env).heat;
  if (!heat) return { due: 0 };
  const due = await db
    .select({ mint: coins.mint })
    .from(coins)
    .innerJoin(pools, eq(pools.pool, coins.pool))
    .leftJoin(graduations, eq(graduations.mint, coins.mint))
    .where(
      and(
        sql`(${pools.curveCompletedAt} is not null or ${pools.quoteReserve} >= ${pools.graduationTarget})`,
        sql`(${graduations.mint} is null or ${graduations.leftoverSignature} is null or ${pools.surplusSignature} is null)`,
      ),
    );
  for (const { mint } of due) await startGraduation(env, mint).catch((e) => console.error(`starting the Graduation of ${mint} failed`, e));
  return { due: due.length };
}

/**
 * The least Heat's LP fees must come to before the keeper claims them: a claim costs a 5,000-lamport fee, so this keeps
 * every claim worth well over its cost.
 */
export const LP_FEE_CLAIM_MINIMUM = 1_000_000n;

/** A graduated coin's two positions, as recorded. */
export function positionsOf(g: typeof graduations.$inferSelect, quoteMint: Address): Promise<{ heat: GraduatedPosition; creator: GraduatedPosition }> {
  const position = async (nftMint: string): Promise<GraduatedPosition> => ({
    pool: g.pool as Address,
    mint: g.mint as Address,
    quoteMint,
    ...(await positionAddresses(nftMint as Address)),
  });
  return Promise.all([position(g.heatPositionNftMint), position(g.creatorPositionNftMint)]).then(([heat, creator]) => ({ heat, creator }));
}

/** What a position has accrued and not yet claimed, in the quote's raw units, read from the chain. */
export async function unclaimedLpFees(rpc: Rpc, position: GraduatedPosition): Promise<bigint> {
  const [pool, state] = await Promise.all([fetchPool(rpc, position.pool, limited()), fetchPosition(rpc, position.position, limited())]);
  return unclaimedPositionFees(pool.data, state.data).quote;
}

/**
 * The cron's claim of Heat's LP fees (spec 4): the fee program's `claim_lp_fees` for every graduated coin whose Heat
 * position has accrued at least `LP_FEE_CLAIM_MINIMUM`, paid to the treasury; anyone may send it.
 */
export async function claimHeatLpFees(db: Db, env: Bindings): Promise<{ graduated: number; claimed: number }> {
  const cfg = config(env);
  const heat = cfg.heat;
  if (!heat?.keys || !env.KEEPER_KEY) return { graduated: 0, claimed: 0 };
  const keeperKey = typeof env.KEEPER_KEY === "string" ? { get: async () => env.KEEPER_KEY as string } : env.KEEPER_KEY;
  const rows = await db.select({ graduation: graduations, quoteMint: pools.quoteMint }).from(graduations).innerJoin(pools, eq(pools.mint, graduations.mint));
  const rpc = createSolanaRpc(cfg.rpcUrl);
  let claimed = 0;
  let keeper: Keeper | null = null;
  for (const { graduation: row, quoteMint } of rows) {
    const { heat: position } = await positionsOf(row, quoteMint as Address);
    if ((await unclaimedLpFees(rpc, position)) < LP_FEE_CLAIM_MINIMUM) continue;
    keeper ??= await keeperOf(cfg, keeperKey);
    await keeperSends(cfg, rpc, keeper, await lpFeeClaimInstructions({ heat: position, treasury: heat.keys.treasury, payer: keeper.signer, computeUnitPrice: cfg.computeUnitPrice }));
    claimed++;
  }
  return { graduated: rows.length, claimed };
}
