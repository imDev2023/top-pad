// Quick buy and sell (spec 9, screen 3; spec 10.1, "Trading"): a quote read from the pool as it stands, by DBC's own
// maths (`@top-pad/meteora/quote`), with the fee for each second the sniper tax still runs, or once the coin has
// graduated by DAMM v2's (`@top-pad/meteora/damm`) on its graduated pool (spec 2.3); the swap itself, built here
// for the wallet to sign and send, naming Heat's referral account so Heat earns Meteora's referral share (spec 4); what
// a wallet holds to trade with; and the browser's fast path, which reads a sent trade back from the chain the moment it
// confirms so the page shows it at once, and hands it to the indexer (spec 10.2).
import {
  address,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Address as KitAddress,
} from "@solana/kit";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { priceOfSqrtPrice, referralAccountOf, swapMessage, tokenAccountOf, WSOL_MINT, type HeatCluster, type HeatQuote } from "@top-pad/chain";
import { getPoolDecoder, type Pool as DammPoolState } from "@top-pad/clients/damm-v2";
import { getPoolConfigDecoder, getVirtualPoolDecoder, type PoolConfig, type PoolState } from "@top-pad/clients/dbc";
import { TAX_WINDOW_SECONDS } from "@top-pad/clients/fee";
import { Address, Holdings, SwapPrepareRequest, SwapRequest, SwapSent, type PreparedSwap, type QuoteStep, type SwapOutcome, type SwapQuote, type Trade } from "@top-pad/contract";
import { coins, graduations, pools } from "@top-pad/db";
import { decodeTransaction, fetchRawTransaction, provisionalOrderKey, type GraduatedPoolRef } from "@top-pad/indexer";
import { quoteDammSwap } from "@top-pad/meteora/damm";
import { minimumOut, quoteSwap, type Quote } from "@top-pad/meteora/quote";
import { explorerUrl } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";
import { amountText, quoteInfoOf, quoteOf as listedQuoteOf } from "./quotes";
import { customError, settleSignatures } from "./send";

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base64 = getBase64Encoder();
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
/** How long a trade's report waits for it to confirm and be served, before answering with what it has. */
const SETTLE_WAIT_MS = 30_000;
/** How often it asks: the fast path is only worth having if it answers the moment the trade confirms (spec 10.2). */
const SETTLE_POLL_MS = 300;
/** An SPL token account's size, whose rent a swap pays when it opens one. */
const TOKEN_ACCOUNT_BYTES = 165n;
/** That rent, asked of the cluster once per isolate: rent has changed before (2,039,280 lamports until late 2026). */
let tokenAccountRent: Promise<bigint> | null = null;
const rentOfTokenAccount = (rpc: Rpc) => {
  tokenAccountRent ??= rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES).send(limited());
  tokenAccountRent.catch(() => (tokenAccountRent = null));
  return tokenAccountRent;
};
/** A swap's network fee, one signature, with room for a priority fee on a busy cluster. */
const NETWORK_FEE = 10_000n;
/**
 * How far behind the quote's clock a wallet's own node may simulate the trade: during the sniper tax each second earlier
 * charges more, so the trade's minimum is set by the fee of this many seconds before, or a lagging node's preflight
 * refuses it (seen on devnet, 2026-11-02).
 */
const SIMULATION_LAG_SECONDS = 2n;
/** DBC's custom errors a quick trade can land with, in the trader's words. */
const DBC_ERRORS: Record<number, string> = {
  6002: "The price moved more than your slippage allows before the trade ran, so nothing was traded. Try again, or allow more slippage.",
  6013: "The coin's curve completed before the trade ran: it trades on Meteora once it graduates.",
};
/** DAMM v2's custom errors a quick trade on a graduated pool can land with. */
const DAMM_ERRORS: Record<number, string> = {
  6004: "The price moved more than your slippage allows before the trade ran, so nothing was traded. Try again, or allow more slippage.",
};

type Rpc = ReturnType<typeof createSolanaRpc>;
type PoolRow = typeof pools.$inferSelect;
type GraduationRow = typeof graduations.$inferSelect;
/** What a wallet holds to trade with: its SOL, the coin's quote it can spend (its SOL again in a SOL coin) and the coin. */
type Wallet = { lamports: bigint; quote: bigint; coins: bigint; coinAccountOpen: boolean; quoteAccountOpen: boolean };

/**
 * What a quote reads, in one call: the curve and its config, or after Graduation the coin's DAMM v2 pool; the chain's
 * clock; and the wallet's balances if asked.
 */
type Market = (
  | { venue: "curve"; pool: PoolState; config: PoolConfig; chainTime: bigint; wallet: Wallet | null }
  | { venue: "graduated"; damm: DammPoolState; chainTime: bigint; wallet: Wallet | null }
) & {
  /**
   * Whether Heat's referral account, the treasury's account of the quote, exists: a swap names it only then, since DBC
   * refuses one that does not; the window claim opens it a minute into a coin's life (spec 4).
   */
  referralOpen: boolean;
};

/** An SPL token account's balance: its amount sits after its mint and owner. */
const tokenAmount = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);

async function readMarket(rpc: Rpc, heat: HeatCluster, row: PoolRow, graduation: GraduationRow | null, wallet: KitAddress | null): Promise<Market> {
  const quoteMint = address(row.quoteMint);
  const walletAccounts = wallet ? [wallet, await tokenAccountOf(wallet, address(row.mint)), await tokenAccountOf(wallet, quoteMint)] : [];
  const market = graduation ? [address(graduation.pool)] : [address(row.pool), address(row.config)];
  const referral = await referralAccountOf(heat.keys!.treasury, quoteMint);
  const { value } = await rpc
    // At `processed`, the freshest the node has: the price and the second a trade sent now would meet.
    .getMultipleAccounts([...market, CLOCK_SYSVAR, ...walletAccounts, referral], { encoding: "base64", commitment: "processed" })
    .send(limited());
  const bytes = (i: number) => {
    const account = value[i];
    return account ? (base64.encode(account.data[0]) as Uint8Array) : null;
  };
  const clock = market.length;
  const clockBytes = bytes(clock);
  if (!clockBytes || market.some((_, i) => !bytes(i))) throw new Error(`the market of ${row.mint} is missing on chain`);
  const chainTime = new DataView(clockBytes.buffer, clockBytes.byteOffset).getBigInt64(32, true);
  const coinBytes = bytes(clock + 2);
  const quoteBytes = bytes(clock + 3);
  const lamports = value[clock + 1]?.lamports ?? 0n;
  const held: Wallet | null = wallet
    ? {
        lamports,
        quote: quoteMint === WSOL_MINT ? lamports : quoteBytes ? tokenAmount(quoteBytes) : 0n,
        coins: coinBytes ? tokenAmount(coinBytes) : 0n,
        coinAccountOpen: coinBytes !== null,
        quoteAccountOpen: quoteBytes !== null,
      }
    : null;
  const referralOpen = value[clock + 1 + walletAccounts.length] !== null;
  if (graduation) return { venue: "graduated", damm: getPoolDecoder().decode(bytes(0)!), chainTime, wallet: held, referralOpen };
  return {
    venue: "curve",
    pool: getVirtualPoolDecoder().decode(bytes(0)!).poolState,
    config: getPoolConfigDecoder().decode(bytes(1)!),
    chainTime,
    wallet: held,
    referralOpen,
  };
}

/** A refusal with the sentence to show, and its status. */
class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The pool of a Heat coin, and its Graduation if it has graduated: quick trades are built only for coins our launch key
 * co-signed (spec 2.4).
 */
async function heatPool(c: Context<AppEnv>): Promise<{ row: PoolRow; graduation: GraduationRow | null; heat: HeatCluster; quote: HeatQuote }> {
  const { cfg, db } = c.var;
  const mint = c.req.param("mint")!;
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys || !Address.safeParse(mint).success) throw new Refusal(404, "Heat has no coin at this address.");
  const [found] = await db
    .select({ pool: pools, coin: coins.mint, graduation: graduations })
    .from(pools)
    .leftJoin(coins, eq(coins.mint, pools.mint))
    .leftJoin(graduations, eq(graduations.mint, pools.mint))
    .where(eq(pools.mint, mint));
  if (!found) throw new Refusal(404, "Heat has no coin at this address.");
  if (!found.coin) throw new Refusal(409, "Heat builds trades only for coins launched through Heat.");
  const quote = listedQuoteOf(heat, found.pool.quoteMint);
  if (!quote) throw new Refusal(404, "Heat has no coin at this address.");
  return { row: found.pool, graduation: found.graduation, heat, quote };
}

/** Why a market cannot trade now, if it cannot. */
function closedReason(market: Market): string | null {
  if (market.venue === "graduated") return market.damm.poolStatus !== 0 ? "Meteora has paused trading on this coin's pool." : null;
  if (market.pool.isMigrated || market.pool.quoteReserve >= market.config.migrationQuoteThreshold) {
    return "This coin's curve is complete and it is graduating to Meteora's DAMM v2, where it trades in a moment.";
  }
  if (market.chainTime < market.pool.activationPoint) return "Trading on this coin has not opened yet.";
  return null;
}

/**
 * The quote: what the trade does in each second from now until the sniper tax ends, the fee falling every second, and
 * from then on at the trading fee. Every step is DBC's own figure for the pool as it stands now.
 */
export function quoteOf(market: Market, request: SwapRequest, hasReferral: boolean): { quote: SwapQuote; first: Quote } {
  const amountIn = BigInt(request.amount);
  if (market.venue === "graduated") {
    // A graduated pool's fee follows its price, not the clock (spec 3.4): one step holds from now on.
    const first = quoteDammSwap({ pool: market.damm, side: request.side, amountIn, currentPoint: market.chainTime, hasReferral });
    const step: QuoteStep = { from: Number(market.chainTime), fee: `${first.fee}`, quoteAmount: `${first.quoteAmount}`, amountOut: `${first.amountOut}` };
    return {
      first,
      quote: {
        side: request.side,
        amountIn: `${first.amountIn}`,
        amountLeft: "0",
        chainTime: Number(market.chainTime),
        taxEndsAt: Number(market.chainTime),
        steps: [step],
        slippageBps: request.slippageBps,
        minimumOut: `${minimumOut(first.amountOut, request.slippageBps)}`,
      },
    };
  }
  const taxEndsAt = market.pool.activationPoint + TAX_WINDOW_SECONDS;
  const at = (second: bigint) => quoteSwap({ pool: market.pool, config: market.config, side: request.side, amountIn, currentPoint: second, hasReferral });
  const first = at(market.chainTime);
  const earliest = market.chainTime - SIMULATION_LAG_SECONDS;
  const floor = at(earliest > market.pool.activationPoint ? earliest : market.pool.activationPoint);
  const steps: QuoteStep[] = [];
  for (let second = market.chainTime; ; second++) {
    const q = second === market.chainTime ? first : at(second);
    steps.push({ from: Number(second), fee: `${q.fee}`, quoteAmount: `${q.quoteAmount}`, amountOut: `${q.amountOut}` });
    if (second >= taxEndsAt) break;
  }
  return {
    first,
    quote: {
      side: request.side,
      amountIn: `${first.amountIn}`,
      amountLeft: `${first.amountLeft}`,
      chainTime: Number(market.chainTime),
      taxEndsAt: Number(taxEndsAt),
      steps,
      slippageBps: request.slippageBps,
      minimumOut: `${minimumOut(floor.amountOut < first.amountOut ? floor.amountOut : first.amountOut, request.slippageBps)}`,
    },
  };
}

/** The quote, or a refusal when the trade could not run: DBC's maths throw on a sell larger than the curve has bought. */
function quoteOrRefuse(market: Market, request: SwapRequest) {
  const closed = closedReason(market);
  if (closed) throw new Refusal(409, closed);
  try {
    return quoteOf(market, request, true);
  } catch (e) {
    throw new Refusal(400, `This trade cannot run: ${(e as Error).message}.`);
  }
}

async function respond<T>(c: Context<AppEnv>, work: () => Promise<T>) {
  try {
    c.header("cache-control", "no-store");
    return c.json(await work());
  } catch (e) {
    if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

async function body<T>(c: Context<AppEnv>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, problem: string): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new Refusal(400, problem);
  return parsed.data;
}

const BAD_REQUEST = "Say buy or sell, an amount in raw units, and the slippage to allow in basis points (1 to 5,000).";

/** `POST /coins/:mint/quote`. */
export const quote = (c: Context<AppEnv>) =>
  respond(c, async () => {
    const request = await body(c, SwapRequest, BAD_REQUEST);
    const { row, graduation, heat } = await heatPool(c);
    return quoteOrRefuse(await readMarket(createSolanaRpc(c.var.cfg.rpcUrl), heat, row, graduation, null), request).quote;
  });

const sol = (lamports: bigint) => amountText(lamports, { symbol: "SOL", decimals: 9, multiplier: 1 });

/**
 * `POST /coins/:mint/swap`: the quote and its transaction, for the wallet to sign and send. Refused when the wallet
 * cannot pay for it: a buy needs its SOL, the rent of any account it opens and the network fee; a sell needs the coins.
 */
export const prepareSwap = (c: Context<AppEnv>) =>
  respond(c, async () => {
    const { cfg } = c.var;
    const request = await body(c, SwapPrepareRequest, `${BAD_REQUEST} Name the wallet that signs.`);
    const { row, graduation, heat, quote: quoteListed } = await heatPool(c);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const wallet = address(request.wallet);
    const market = await readMarket(rpc, heat, row, graduation, wallet);
    const { quote, first } = quoteOrRefuse(market, request);
    const held = market.wallet!;
    // The wrapped SOL account a swap opens is closed in the same transaction, its rent back with the proceeds.
    const rent = await rentOfTokenAccount(rpc);
    const opening = (held.coinAccountOpen ? 0n : rent) + (held.quoteAccountOpen ? 0n : rent);
    if (request.side === "buy" && quoteListed.mint === WSOL_MINT) {
      const needs = first.amountIn + opening + NETWORK_FEE;
      if (held.lamports < needs) throw new Refusal(400, `This wallet holds ${sol(held.lamports)}; the buy needs ${sol(needs)}, with its accounts' rent and the network fee.`);
    } else if (request.side === "buy") {
      // A buy in another quote spends that quote, and SOL only for the rent and the fee.
      const info = await quoteInfoOf(cfg, heat, quoteListed.mint);
      if (held.quote < first.amountIn) throw new Refusal(400, `This wallet holds ${amountText(held.quote, info)}; the buy spends ${amountText(first.amountIn, info)}.`);
      if (held.lamports < opening + NETWORK_FEE) throw new Refusal(400, `This wallet needs ${sol(opening + NETWORK_FEE)} for the network fee and its accounts' rent.`);
    } else {
      if (held.coins < BigInt(request.amount)) throw new Refusal(400, "This wallet does not hold that many of the coin.");
      if (held.lamports < opening + NETWORK_FEE) throw new Refusal(400, `This wallet needs ${sol(opening + NETWORK_FEE)} for the network fee and its accounts' rent.`);
    }
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
    const message = await swapMessage(
      {
        config: address(row.config),
        pool: address(row.pool),
        mint: address(row.mint),
        quoteMint: quoteListed.mint,
        trader: createNoopSigner(wallet),
        side: request.side,
        amountIn: BigInt(request.amount),
        minimumOut: BigInt(quote.minimumOut),
        mode: request.side === "buy" ? "partial_fill" : "exact_in",
        referralAccount: market.referralOpen ? await referralAccountOf(heat.keys!.treasury, quoteListed.mint) : null,
        graduatedPool: graduation ? address(graduation.pool) : null,
      },
      { computeUnitPrice: cfg.computeUnitPrice, lifetime },
    );
    const prepared: PreparedSwap = { quote, transaction: getBase64EncodedWireTransaction(compileTransaction(message)) };
    return prepared;
  });

/** `GET /coins/:mint/holdings/:wallet`. */
export const getHoldings = (c: Context<AppEnv>) =>
  respond(c, async () => {
    const { cfg, db } = c.var;
    const mint = c.req.param("mint")!;
    const wallet = c.req.param("wallet")!;
    if (!Address.safeParse(wallet).success) throw new Refusal(400, "That is not a Solana wallet address.");
    const [pool] = cfg.heat && Address.safeParse(mint).success ? await db.select({ quoteMint: pools.quoteMint }).from(pools).where(eq(pools.mint, mint)) : [];
    if (!pool) throw new Refusal(404, "Heat has no coin at this address.");
    const coinAccount = await tokenAccountOf(address(wallet), address(mint));
    const quoteAccount = await tokenAccountOf(address(wallet), address(pool.quoteMint));
    const { value } = await createSolanaRpc(cfg.rpcUrl)
      .getMultipleAccounts([address(wallet), coinAccount, quoteAccount], { encoding: "base64", commitment: "confirmed" })
      .send(limited());
    const amountAt = (i: number) => (value[i] ? tokenAmount(base64.encode(value[i].data[0]) as Uint8Array) : 0n);
    const lamports = value[0]?.lamports ?? 0n;
    const holdings: Holdings = { wallet, sol: `${lamports}`, quote: `${pool.quoteMint === WSOL_MINT ? lamports : amountAt(2)}`, coins: `${amountAt(1)}` };
    return holdings;
  });

/** A swap decoded from a landed transaction, as the page shows a trade, its order key provisional. */
function provisionalTrade(swap: ReturnType<typeof decodeTransaction>["swaps"][number], signature: string, slot: number, quoteDecimals: number): Trade {
  return {
    signature,
    eventIndex: swap.eventIndex,
    orderKey: provisionalOrderKey(slot, swap.eventIndex),
    slot,
    at: new Date(Number(swap.timestamp) * 1000).toISOString(),
    trader: swap.trader,
    side: swap.side,
    quoteAmount: `${swap.quoteAmount}`,
    baseAmount: `${swap.baseAmount}`,
    fee: `${swap.fee}`,
    price: priceOfSqrtPrice(swap.sqrtPrice, quoteDecimals),
    quoteReserve: `${swap.quoteReserve}`,
  };
}

/**
 * `POST /coins/:mint/trades`: a quick trade the wallet sent, settled against the chain and read back the moment it is
 * served, so the page shows it before the indexer reports it; the indexer is handed it at once too.
 */
export const reportTrade = (c: Context<AppEnv>) =>
  respond(c, async () => {
    const { cfg } = c.var;
    const { signature } = await body(c, SwapSent, "Send the trade's transaction signature.");
    const { row, graduation, quote: quoteListed } = await heatPool(c);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const until = Date.now() + SETTLE_WAIT_MS;
    const settled = (await settleSignatures(rpc, [signature], SETTLE_WAIT_MS, SETTLE_POLL_MS)).get(signature)!;
    const outcome: SwapOutcome = { signature, status: settled.status, error: settled.error, explorer: explorerUrl(cfg, "tx", signature), trades: [] };
    if (settled.status === "failed") {
      const code = customError(JSON.parse(settled.error ?? "null"));
      const known = graduation ? DAMM_ERRORS : DBC_ERRORS;
      outcome.error = (code !== null && known[code]) || `The trade failed on chain: ${settled.error}.`;
    }
    if (settled.status !== "landed") return outcome;
    c.executionCtx.waitUntil(indexNow(c.env, [signature]));
    let raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    // A node reports a transaction confirmed a moment before it serves it.
    while (!raw && Date.now() < until) {
      await sleep(SETTLE_POLL_MS);
      raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    }
    if (!raw) return outcome;
    // The coin's own config is the only one its trades can be on.
    const configs = new Set<string>([row.config]);
    const graduated = new Map<string, GraduatedPoolRef>(graduation ? [[graduation.pool, { mint: graduation.mint, config: graduation.config }]] : []);
    outcome.trades = decodeTransaction(raw, configs, graduated)
      .swaps.filter((s) => s.mint === row.mint)
      .map((s) => provisionalTrade(s, signature, raw.slot, quoteListed.decimals));
    return outcome;
  });

