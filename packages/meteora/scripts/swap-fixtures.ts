// `pnpm --filter @top-pad/meteora swap-fixtures <pool>...`: records every swap a devnet pool has had, from its first,
// with its config, into `src/fixtures/swaps.json`, where `quote.test.ts` replays each one through `quoteSwap` and
// expects DBC's own figures from its `EvtSwap3` to the raw unit. Each swap's starting state is the one before it left
// (or the curve's start), so a pool's whole history is one chain of parity checks. Read-only; run through `direnv exec`
// so `HELIUS_API_KEY` reaches it, or set `RPC_URL`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc, getBase58Encoder, type Address, type ReadonlyUint8Array, type Signature } from "@solana/kit";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  DynamicBondingCurveInstruction,
  EVT_SWAP3_EVENT_DISCRIMINATOR,
  fetchPoolConfig,
  fetchVirtualPool,
  getSwap2InstructionDataDecoder,
  getSwapInstructionDataDecoder,
  identifyDynamicBondingCurveInstruction,
  parseEvtSwap3Event,
} from "@top-pad/clients/dbc";
import type { SwapFixtures } from "../src/fixtures/types";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "fixtures", "swaps.json");
const rpcUrl = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.devnet.solana.com");
const rpc = createSolanaRpc(rpcUrl);
const base58 = getBase58Encoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Anchor's tag on an event CPI's data, before the event's own discriminator. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const startsWith = (data: ReadonlyUint8Array, prefix: ArrayLike<number>, at = 0) =>
  data.length >= at + prefix.length && Array.from(prefix).every((b, i) => data[at + i] === b);
/** Where `swap` and `swap2` name the pool. */
const SWAP_POOL = 2;

type Ix = { programIdIndex: number; accounts: readonly number[]; data: string };

function identify(data: ReadonlyUint8Array) {
  try {
    return identifyDynamicBondingCurveInstruction(data);
  } catch {
    return null;
  }
}

/** Every signature of an account, oldest first. */
async function history(account: Address): Promise<Signature[]> {
  const all: Signature[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(account, { before, limit: 1000, commitment: "confirmed" }).send();
    all.push(...page.filter((s) => !s.err).map((s) => s.signature));
    if (page.length < 1000) break;
    before = page.at(-1)!.signature;
  }
  return all.reverse();
}

async function transaction(signature: Signature) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send();
      if (tx) return tx;
    } catch (e) {
      if (attempt > 6) throw e;
    }
    await sleep(500 * 2 ** Math.min(attempt, 4));
  }
}

const fixtures: SwapFixtures = { recordedAt: new Date().toISOString().slice(0, 10), pools: [] };
for (const pool of process.argv.slice(2) as Address[]) {
  const { data: state } = await fetchVirtualPool(rpc, pool);
  const { data: config } = await fetchPoolConfig(rpc, state.poolState.config);
  if (config.poolFees.dynamicFee.initialized !== 0) throw new Error(`${pool}'s config has a dynamic fee, which the replay does not track`);
  const swaps: SwapFixtures["pools"][number]["swaps"] = [];
  for (const signature of await history(pool)) {
    const tx = await transaction(signature);
    const { accountKeys, instructions } = tx.transaction.message;
    const keys = [...accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const inner = new Map((tx.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions as readonly Ix[]]));
    const ordered = (instructions as readonly Ix[]).flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
    const created = ordered.some((ix) => {
      if (keys[ix.programIdIndex] !== DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS) return false;
      const kind = identify(base58.encode(ix.data));
      return kind === DynamicBondingCurveInstruction.InitializeVirtualPoolWithSplToken && keys[ix.accounts[5]!] === pool;
    });
    // Each swap on this pool, then the event it emitted.
    let pending: { amountIn: bigint; minimumOut: bigint; swapMode: number } | null = null;
    for (const ix of ordered) {
      if (keys[ix.programIdIndex] !== DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS) continue;
      const data = base58.encode(ix.data);
      if (startsWith(data, EVENT_IX_TAG)) {
        if (!startsWith(data, EVT_SWAP3_EVENT_DISCRIMINATOR, 8)) continue;
        const e = parseEvtSwap3Event(data.subarray(8));
        if (e.pool !== pool) continue;
        if (!pending) throw new Error(`${signature}: a swap event with no swap before it`);
        swaps.push({
          signature,
          inCreation: created,
          side: e.tradeDirection === 1 ? "buy" : "sell",
          swapMode: pending.swapMode,
          amountIn: `${pending.amountIn}`,
          minimumOut: `${pending.minimumOut}`,
          hasReferral: e.hasReferral,
          timestamp: `${e.currentTimestamp}`,
          taken: `${e.includedTransferFeeAmountIn}`,
          amountOut: `${e.excludedTransferFeeAmountOut}`,
          tradingFee: `${e.tradingFee}`,
          protocolFee: `${e.protocolFee}`,
          referralFee: `${e.referralFee}`,
          nextSqrtPrice: `${e.nextSqrtPrice}`,
          quoteReserve: `${e.quoteReserve}`,
        });
        pending = null;
        continue;
      }
      const kind = identify(data);
      if (keys[ix.accounts[SWAP_POOL]!] !== pool) continue;
      if (kind === DynamicBondingCurveInstruction.Swap2) {
        const { params } = getSwap2InstructionDataDecoder().decode(data);
        pending = { amountIn: params.amount0, minimumOut: params.amount1, swapMode: params.swapMode };
      } else if (kind === DynamicBondingCurveInstruction.Swap) {
        const { params } = getSwapInstructionDataDecoder().decode(data);
        pending = { amountIn: params.amountIn, minimumOut: params.minimumAmountOut, swapMode: 0 };
      }
    }
  }
  const { baseFee, dynamicFee } = config.poolFees;
  fixtures.pools.push({
    pool,
    config: {
      address: state.poolState.config,
      collectFeeMode: config.collectFeeMode,
      sqrtStartPrice: `${config.sqrtStartPrice}`,
      migrationQuoteThreshold: `${config.migrationQuoteThreshold}`,
      migrationSqrtPrice: `${config.migrationSqrtPrice}`,
      curve: config.curve.filter((p) => p.sqrtPrice > 0n).map((p) => ({ sqrtPrice: `${p.sqrtPrice}`, liquidity: `${p.liquidity}` })),
      enableFirstSwapWithMinFee: config.enableFirstSwapWithMinFee,
      quoteTokenFlag: config.quoteTokenFlag,
      transferFeeFlag: config.transferFeeFlag,
      transferFeeBasisPoints: config.transferFeeBasisPoints,
      baseFee: {
        cliffFeeNumerator: `${baseFee.cliffFeeNumerator}`,
        firstFactor: baseFee.firstFactor,
        secondFactor: `${baseFee.secondFactor}`,
        thirdFactor: `${baseFee.thirdFactor}`,
        baseFeeMode: baseFee.baseFeeMode,
      },
      dynamicFee: { initialized: dynamicFee.initialized, binStep: dynamicFee.binStep, variableFeeControl: dynamicFee.variableFeeControl },
    },
    activationPoint: `${state.poolState.activationPoint}`,
    swaps,
  });
  console.log(`${pool}: ${swaps.length} swaps, ${swaps.filter((s) => s.hasReferral).length} with a referral, ${swaps.filter((s) => s.inCreation).length} in its creation`);
}
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${out}`);
