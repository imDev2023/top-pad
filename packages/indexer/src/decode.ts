// Our own decoding of Meteora's and our programs' events (spec 10.2). DBC and our two programs emit their events through
// Anchor's event CPI, as an inner instruction carrying the event, so a transaction's logs say nothing and the indexer
// decodes the transaction itself: each event belongs to the instruction that emitted it, the nearest instruction of the
// same program before it that is not itself an event.
import { getBase58Encoder, unwrapOption, type ReadonlyUint8Array } from "@solana/kit";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
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
import {
  COIN_REGISTERED_EVENT_DISCRIMINATOR,
  FEES_CLAIMED_EVENT_DISCRIMINATOR,
  LaunchMode,
  parseCoinRegisteredEvent,
  parseFeesClaimedEvent,
  parseWindowFeesClaimedEvent,
  WINDOW_FEES_CLAIMED_EVENT_DISCRIMINATOR,
} from "@top-pad/clients/fee";
import {
  CREATOR_LOCKED_EVENT_DISCRIMINATOR,
  DEPOSITED_EVENT_DISCRIMINATOR,
  FAILED_DEPOSIT_RETURNED_EVENT_DISCRIMINATOR,
  LAUNCH_CLOSED_EVENT_DISCRIMINATOR,
  LAUNCH_CREATED_EVENT_DISCRIMINATOR,
  LAUNCH_FAILED_EVENT_DISCRIMINATOR,
  LAUNCH_OPENED_EVENT_DISCRIMINATOR,
  parseCreatorLockedEvent,
  parseDepositedEvent,
  parseFailedDepositReturnedEvent,
  parseLaunchClosedEvent,
  parseLaunchCreatedEvent,
  parseLaunchFailedEvent,
  parseLaunchOpenedEvent,
  parseSeatDeliveredEvent,
  parseTaxShareCollectedEvent,
  parseTaxSharePaidEvent,
  parseWithdrawnEvent,
  SEAT_DELIVERED_EVENT_DISCRIMINATOR,
  TAX_SHARE_COLLECTED_EVENT_DISCRIMINATOR,
  TAX_SHARE_PAID_EVENT_DISCRIMINATOR,
  WITHDRAWN_EVENT_DISCRIMINATOR,
} from "@top-pad/clients/fair-open";

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

/** A pool's window claim (spec 4, 5.2): its Tax window's fees, and any normal fees that accrued before the claim ran. */
export type WindowClaimed = {
  pool: string;
  mint: string;
  config: string;
  heat: boolean;
  /** The quote account paid. */
  destination: string;
  amount: bigint;
  /** When the window ended and when the claim ran, Unix seconds. */
  windowEndedAt: bigint;
  claimedAt: bigint;
};

/** A claim of Creator Earnings from one pool, split between the creator role holder and the treasury. */
export type FeesClaimed = {
  /** The claim's place among its transaction's claims, in execution order. */
  eventIndex: number;
  pool: string;
  mint: string;
  config: string;
  creator: string;
  creatorAmount: bigint;
  treasuryAmount: bigint;
};

/** A Fair Open scheduled (spec 2.1 steps 4 to 7): its terms, as its launch account holds them. */
export type FairOpenCreated = {
  launch: string;
  creator: string;
  nonce: string;
  dbcConfig: string;
  quoteMint: string;
  /** Hex. */
  identityHash: string;
  /** Unix seconds. */
  depositsOpenAt: bigint;
  opensAt: bigint;
  minRaise: bigint;
  potCap: bigint;
  lowestRung: bigint;
  step: bigint;
};

const TIERS = ["unverified", "scored", "verified"] as const;
export type DepositorTier = (typeof TIERS)[number];

/** A Fair Open opened (spec 2.1 step 10): its coin and pool created, and what the pot spent and bought. */
export type FairOpenOpened = {
  launch: string;
  creator: string;
  mint: string;
  pool: string;
  /** What the fills added up to, the rung the pot spent, and the coins it bought; raw units. */
  spend: bigint;
  spent: bigint;
  coins: bigint;
  /** The pot's own fee, split 50/50 rather than joining the Tax Share. */
  potFee: bigint;
  /** How many seats the open filled. */
  seats: number;
};

/**
 * A change to a Fair Open seat: a deposit, a withdrawal in the window, its delivery after the open, the creator's seat's
 * coins locked, its Tax Share paid as it closed, or a refund.
 */
export type SeatEvent = {
  /** The event's place among its transaction's seat events, in execution order. */
  eventIndex: number;
  launch: string;
  wallet: string;
  /** The person's pseudonym in the launch, hex. */
  person: string;
  kind: "deposit" | "withdraw" | "delivery" | "lock" | "tax_share" | "refund";
  tier: DepositorTier | null;
  /** What moved: a delivery's refund; a lock's, what the Creator wallet got back; a Tax Share's, the share. */
  amount: bigint;
  /** What the seat held after it: a delivery's or a lock's deposit; a Tax Share's, the seat's fill. */
  deposit: bigint;
  /**
   * A refund's rents returned, the coin account's and the seat's; a delivery's coin account rent, if returned; a lock's
   * or a Tax Share's, the seat's as it closed.
   */
  rent: bigint | null;
  /** A delivery's or a lock's spend of the rung and the coins it bought; a Tax Share's spend; null otherwise. */
  spent: bigint | null;
  coins: bigint | null;
  /** Whether a deposit took the seat, or a withdrawal or refund closed it. */
  seatOpened: boolean;
  seatClosed: boolean;
};

const FAILURES = ["below_lowest_rung", "min_raise_missed", "late"] as const;
export type FairOpenFailure = (typeof FAILURES)[number];

/** A Fair Open that failed, or whose launch account closed once it was done, its creator's rent returned. */
export type FairOpenEnded = { launch: string; kind: "failed"; failure: FairOpenFailure } | { launch: string; kind: "closed" };

/** The Creator lock (spec 2.1 step 13): the creator's coins in a Jupiter Lock escrow. */
export type CreatorLock = {
  launch: string;
  /** None when the creator's seat bought no coins. */
  escrow: string | null;
  coins: bigint;
  /** Unix seconds. */
  cliffTime: bigint;
  endTime: bigint;
};

/** The Tax Share collected (spec 2.1 step 14), in the quote's raw units. */
export type TaxShareCollection = {
  launch: string;
  fees: bigint;
  dust: bigint;
  taxShare: bigint;
  basis: bigint;
  /** Whether, with no seat but the creator's, it went to Heat's treasury. */
  toTreasury: boolean;
};

export type Decoded = {
  pools: PoolCreated[];
  coins: CoinRegistered[];
  swaps: Swap[];
  windowClaims: WindowClaimed[];
  feeClaims: FeesClaimed[];
  fairOpens: FairOpenCreated[];
  fairOpenOpens: FairOpenOpened[];
  seatEvents: SeatEvent[];
  fairOpenEnds: FairOpenEnded[];
  creatorLocks: CreatorLock[];
  taxShares: TaxShareCollection[];
};

const hex = (bytes: ReadonlyUint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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
 * The pools, coin registrations, swaps and fee claims a transaction holds, on Heat's `configs` only. A failed
 * transaction changed nothing and holds none. Throws on anything it cannot account for, such as a swap without its
 * event, so a transaction is never indexed half right.
 */
export function decodeTransaction(tx: RawTransaction, configs: ReadonlySet<string>): Decoded {
  const decoded: Decoded = {
    pools: [],
    coins: [],
    swaps: [],
    windowClaims: [],
    feeClaims: [],
    fairOpens: [],
    fairOpenOpens: [],
    seatEvents: [],
    creatorLocks: [],
    taxShares: [],
    fairOpenEnds: [],
  };
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
    if (program !== DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS && program !== FEE_PROGRAM_ADDRESS && program !== FAIR_OPEN_PROGRAM_ADDRESS) continue;
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

    if (program === FAIR_OPEN_PROGRAM_ADDRESS) {
      decodeFairOpenEvent(event, decoded);
    } else if (program === FEE_PROGRAM_ADDRESS) {
      if (startsWith(event, COIN_REGISTERED_EVENT_DISCRIMINATOR)) {
        const e = parseCoinRegisteredEvent(event);
        if (!configs.has(e.config)) continue;
        decoded.coins.push({
          mint: e.mint,
          pool: e.pool,
          config: e.config,
          creator: e.creator,
          launchMode: e.launchMode === LaunchMode.Instant ? "instant" : "fair_open",
        });
      } else if (startsWith(event, WINDOW_FEES_CLAIMED_EVENT_DISCRIMINATOR)) {
        const e = parseWindowFeesClaimedEvent(event);
        if (!configs.has(e.config)) continue;
        decoded.windowClaims.push({
          pool: e.pool,
          mint: e.mint,
          config: e.config,
          heat: e.heat,
          destination: e.destination,
          amount: e.amount,
          windowEndedAt: e.windowEndedAt,
          claimedAt: e.claimedAt,
        });
      } else if (startsWith(event, FEES_CLAIMED_EVENT_DISCRIMINATOR)) {
        const e = parseFeesClaimedEvent(event);
        if (!configs.has(e.config)) continue;
        decoded.feeClaims.push({
          eventIndex: decoded.feeClaims.length,
          pool: e.pool,
          mint: e.mint,
          config: e.config,
          creator: e.creator,
          creatorAmount: e.creatorAmount,
          treasuryAmount: e.treasuryAmount,
        });
      }
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

/** One of the Fair Open program's events. Every launch it holds is on Heat's Fair Open config, which it alone allows. */
function decodeFairOpenEvent(event: ReadonlyUint8Array, decoded: Decoded) {
  const seat = (e: Omit<SeatEvent, "eventIndex">) => decoded.seatEvents.push({ eventIndex: decoded.seatEvents.length, ...e });
  if (startsWith(event, LAUNCH_CREATED_EVENT_DISCRIMINATOR)) {
    const e = parseLaunchCreatedEvent(event);
    decoded.fairOpens.push({
      launch: e.launch,
      creator: e.creator,
      nonce: e.nonce,
      dbcConfig: e.dbcConfig,
      quoteMint: e.quoteMint,
      identityHash: hex(e.identityHash),
      depositsOpenAt: e.depositsOpenAt,
      opensAt: e.opensAt,
      minRaise: e.minRaise,
      potCap: e.potCap,
      lowestRung: e.lowestRung,
      step: e.step,
    });
  } else if (startsWith(event, DEPOSITED_EVENT_DISCRIMINATOR)) {
    const e = parseDepositedEvent(event);
    seat({
      launch: e.launch,
      wallet: e.wallet,
      person: hex(e.person),
      kind: "deposit",
      tier: TIERS[e.tier]!,
      amount: e.amount,
      deposit: e.deposit,
      rent: null,
      spent: null,
      coins: null,
      seatOpened: e.newSeat,
      seatClosed: false,
    });
  } else if (startsWith(event, WITHDRAWN_EVENT_DISCRIMINATOR)) {
    const e = parseWithdrawnEvent(event);
    seat({
      launch: e.launch,
      wallet: e.wallet,
      person: hex(e.person),
      kind: "withdraw",
      tier: null,
      amount: e.amount,
      deposit: e.deposit,
      rent: null,
      spent: null,
      coins: null,
      seatOpened: false,
      seatClosed: e.closed,
    });
  } else if (startsWith(event, FAILED_DEPOSIT_RETURNED_EVENT_DISCRIMINATOR)) {
    const e = parseFailedDepositReturnedEvent(event);
    seat({
      launch: e.launch,
      wallet: e.wallet,
      person: hex(e.person),
      kind: "refund",
      tier: null,
      amount: e.deposit,
      deposit: 0n,
      rent: e.coinRent + e.seatRent,
      spent: null,
      coins: null,
      seatOpened: false,
      seatClosed: true,
    });
  } else if (startsWith(event, LAUNCH_OPENED_EVENT_DISCRIMINATOR)) {
    const e = parseLaunchOpenedEvent(event);
    decoded.fairOpenOpens.push({
      launch: e.launch,
      creator: e.creator,
      mint: e.mint,
      pool: e.pool,
      spend: e.spend,
      spent: e.spent,
      coins: e.coins,
      potFee: e.potFee,
      seats: e.seats,
    });
  } else if (startsWith(event, SEAT_DELIVERED_EVENT_DISCRIMINATOR)) {
    const e = parseSeatDeliveredEvent(event);
    seat({
      launch: e.launch,
      wallet: e.wallet,
      person: hex(e.person),
      kind: "delivery",
      tier: null,
      amount: e.refund,
      deposit: e.deposit,
      rent: e.coinRent,
      spent: e.spent,
      coins: e.coins,
      seatOpened: false,
      seatClosed: false,
    });
  } else if (startsWith(event, CREATOR_LOCKED_EVENT_DISCRIMINATOR)) {
    const e = parseCreatorLockedEvent(event);
    decoded.creatorLocks.push({ launch: e.launch, escrow: unwrapOption(e.escrow), coins: e.coins, cliffTime: e.cliffTime, endTime: e.endTime });
    seat({
      launch: e.launch,
      wallet: e.creator,
      person: hex(e.person),
      kind: "lock",
      tier: null,
      amount: e.paid,
      deposit: e.deposit,
      rent: e.seatRent,
      spent: e.spent,
      coins: e.coins,
      seatOpened: false,
      seatClosed: true,
    });
  } else if (startsWith(event, TAX_SHARE_COLLECTED_EVENT_DISCRIMINATOR)) {
    const e = parseTaxShareCollectedEvent(event);
    decoded.taxShares.push({ launch: e.launch, fees: e.fees, dust: e.dust, taxShare: e.taxShare, basis: e.basis, toTreasury: unwrapOption(e.treasury) !== null });
  } else if (startsWith(event, TAX_SHARE_PAID_EVENT_DISCRIMINATOR)) {
    const e = parseTaxSharePaidEvent(event);
    seat({
      launch: e.launch,
      wallet: e.wallet,
      person: hex(e.person),
      kind: "tax_share",
      tier: null,
      amount: e.amount,
      deposit: e.fill,
      rent: e.seatRent,
      spent: e.spent,
      coins: null,
      seatOpened: false,
      seatClosed: true,
    });
  } else if (startsWith(event, LAUNCH_FAILED_EVENT_DISCRIMINATOR)) {
    const e = parseLaunchFailedEvent(event);
    decoded.fairOpenEnds.push({ launch: e.launch, kind: "failed", failure: FAILURES[e.failure]! });
  } else if (startsWith(event, LAUNCH_CLOSED_EVENT_DISCRIMINATOR)) {
    decoded.fairOpenEnds.push({ launch: parseLaunchClosedEvent(event).launch, kind: "closed" });
  }
}
