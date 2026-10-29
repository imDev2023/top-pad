// Our own decoding of Meteora's and our programs' events (spec 10.2). DBC and the fee program emit their events through
// Anchor's event CPI, as an inner instruction carrying the event, so a transaction's logs say nothing and the indexer
// decodes the transaction itself: each event belongs to the instruction that emitted it, the nearest DBC (or fee
// program) instruction before it that is not itself an event.
import { getBase58Encoder, type ReadonlyUint8Array } from "@solana/kit";
import { FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  DynamicBondingCurveInstruction,
  EVT_INITIALIZE_POOL_EVENT_DISCRIMINATOR,
  EVT_SWAP3_EVENT_DISCRIMINATOR,
  getInitializeVirtualPoolWithSplTokenInstructionDataDecoder,
  identifyDynamicBondingCurveInstruction,
  parseEvtInitializePoolEvent,
  parseEvtSwap3Event,
} from "@top-pad/clients/dbc";
import { COIN_REGISTERED_EVENT_DISCRIMINATOR, LaunchMode, parseCoinRegisteredEvent } from "@top-pad/clients/fee";

/** An instruction as `getTransaction` answers with `encoding: "json"`: accounts are indexes into the transaction's keys. */
export type RawInstruction = { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number | null };

/** A confirmed transaction in the JSON shape `getTransaction` answers with `encoding: "json"`, whatever its source. */
export type RawTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RawInstruction[] } };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
};

/** A pool created on one of Heat's configs, with the coin's name, ticker and URI from the instruction that made it. */
export type PoolCreated = {
  pool: string;
  mint: string;
  config: string;
  creator: string;
  name: string;
  ticker: string;
  uri: string;
  /** When trading opens, in Unix seconds: DBC's activation point in timestamp mode. */
  activationPoint: bigint;
};

/** A coin registered with the fee program (spec 5.2): our launch key co-signed it, so it is a Heat coin. */
export type CoinRegistered = { mint: string; pool: string; config: string; creator: string; launchMode: "instant" | "fair_open" };

/** One swap on a pool of Heat's configs. Amounts are raw units; the quote side is before the fee. */
export type Swap = {
  /** The swap's place among its transaction's swaps, in execution order. */
  eventIndex: number;
  pool: string;
  mint: string;
  config: string;
  trader: string;
  side: "buy" | "sell";
  quoteAmount: bigint;
  baseAmount: bigint;
  fee: bigint;
  sqrtPrice: bigint;
  quoteReserve: bigint;
  /** The chain's clock when the swap ran, in Unix seconds. */
  timestamp: bigint;
};

export type Decoded = { pools: PoolCreated[]; coins: CoinRegistered[]; swaps: Swap[] };

/** Anchor's tag on an event CPI's data, before the event's own discriminator (`EVENT_IX_TAG_LE`). */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
// DBC's `TradeDirection::QuoteToBase`: the quote in, the coin out.
const QUOTE_TO_BASE = 1;
// `swap` and `swap2` name the trader (`payer`) and the coin (`base_mint`) at these places.
const SWAP_PAYER = 9;
const SWAP_BASE_MINT = 7;
const SWAPS = new Set([DynamicBondingCurveInstruction.Swap, DynamicBondingCurveInstruction.Swap2]);

const base58 = getBase58Encoder();
const startsWith = (data: ReadonlyUint8Array, prefix: ReadonlyUint8Array, at = 0) =>
  data.length >= at + prefix.length && prefix.every((b, i) => data[at + i] === b);

function identify(data: ReadonlyUint8Array): DynamicBondingCurveInstruction | null {
  try {
    return identifyDynamicBondingCurveInstruction(data);
  } catch {
    return null;
  }
}

/** The transaction's instructions in the order they ran: each top-level one, then the inner ones it invoked. */
function executionOrder(tx: RawTransaction) {
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((group) => [group.index, group.instructions]));
  return tx.transaction.message.instructions.flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
}

/**
 * The pools, coin registrations and swaps a transaction holds, on Heat's `configs` only. A failed transaction changed
 * nothing and holds none. Throws on anything it cannot account for, such as a swap without its event, so a transaction
 * is never indexed half right.
 */
export function decodeTransaction(tx: RawTransaction, configs: ReadonlySet<string>): Decoded {
  const decoded: Decoded = { pools: [], coins: [], swaps: [] };
  if (!tx.meta || tx.meta.err) return decoded;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const key = (index: number) => {
    const k = keys[index];
    if (k === undefined) throw new Error(`account index ${index} is outside the transaction's ${keys.length} keys`);
    return k;
  };

  // The latest instruction of each program that is not an event: the one an event that follows was emitted by.
  const emitters = new Map<string, { ix: RawInstruction; data: ReadonlyUint8Array; swapEvents: number }>();
  const swapsSeen: { ix: RawInstruction; data: ReadonlyUint8Array; swapEvents: number }[] = [];

  for (const ix of executionOrder(tx)) {
    const program = key(ix.programIdIndex);
    if (program !== DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS && program !== FEE_PROGRAM_ADDRESS) continue;
    const data = base58.encode(ix.data);
    if (!startsWith(data, EVENT_IX_TAG)) {
      const emitter = { ix, data, swapEvents: 0 };
      emitters.set(program, emitter);
      const kind = program === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS ? identify(data) : null;
      // `swap` and `swap2` name the config second.
      if (kind !== null && SWAPS.has(kind) && configs.has(key(ix.accounts[1]!))) swapsSeen.push(emitter);
      continue;
    }
    const event = data.slice(EVENT_IX_TAG.length);
    const emitter = emitters.get(program);
    if (!emitter) throw new Error(`an event of ${program} with no instruction of it before`);

    if (program === FEE_PROGRAM_ADDRESS) {
      if (!startsWith(event, COIN_REGISTERED_EVENT_DISCRIMINATOR)) continue;
      const e = parseCoinRegisteredEvent(event);
      if (!configs.has(e.config)) continue;
      decoded.coins.push({
        mint: e.mint,
        pool: e.pool,
        config: e.config,
        creator: e.creator,
        launchMode: e.launchMode === LaunchMode.Instant ? "instant" : "fair_open",
      });
    } else if (startsWith(event, EVT_INITIALIZE_POOL_EVENT_DISCRIMINATOR)) {
      const e = parseEvtInitializePoolEvent(event);
      if (!configs.has(e.config)) continue;
      if (identify(emitter.data) !== DynamicBondingCurveInstruction.InitializeVirtualPoolWithSplToken) {
        throw new Error(`pool ${e.pool} on a Heat config was not made by initialize_virtual_pool_with_spl_token`);
      }
      const { params } = getInitializeVirtualPoolWithSplTokenInstructionDataDecoder().decode(emitter.data);
      decoded.pools.push({
        pool: e.pool,
        mint: e.baseMint,
        config: e.config,
        creator: e.creator,
        name: params.name,
        ticker: params.symbol,
        uri: params.uri,
        activationPoint: e.activationPoint,
      });
    } else if (startsWith(event, EVT_SWAP3_EVENT_DISCRIMINATOR)) {
      const e = parseEvtSwap3Event(event);
      if (!configs.has(e.config)) continue;
      if (!swapsSeen.includes(emitter)) throw new Error(`a swap event on pool ${e.pool} not emitted by a swap`);
      if (e.feeOnBaseToken) throw new Error(`a swap on pool ${e.pool} paid its fee in the coin, which Heat's configs never do`);
      emitter.swapEvents++;
      const fee = e.tradingFee + e.protocolFee + e.referralFee;
      const buy = e.tradeDirection === QUOTE_TO_BASE;
      decoded.swaps.push({
        eventIndex: decoded.swaps.length,
        pool: e.pool,
        mint: key(emitter.ix.accounts[SWAP_BASE_MINT]!),
        config: e.config,
        trader: key(emitter.ix.accounts[SWAP_PAYER]!),
        side: buy ? "buy" : "sell",
        quoteAmount: buy ? e.includedTransferFeeAmountIn : e.excludedTransferFeeAmountOut + fee,
        baseAmount: buy ? e.excludedTransferFeeAmountOut : e.includedTransferFeeAmountIn,
        fee,
        sqrtPrice: e.nextSqrtPrice,
        quoteReserve: e.quoteReserve,
        timestamp: e.currentTimestamp,
      });
    }
  }
  const unaccounted = swapsSeen.find((s) => s.swapEvents !== 1);
  if (unaccounted) throw new Error(`a swap on a Heat config emitted ${unaccounted.swapEvents} EvtSwap3 events, not one`);
  return decoded;
}
