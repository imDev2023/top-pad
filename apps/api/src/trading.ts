// Quick buy and sell (spec 9, screen 3; spec 10.1, "Trading"): a quote read from the pool as it stands, by DBC's own
// maths (`@top-pad/meteora/quote`), with the fee for each second the sniper tax still runs; the swap itself, built here
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
import { priceOfSqrtPrice, referralAccountOf, swapMessage, tokenAccountOf, type HeatCluster } from "@top-pad/chain";
import { getPoolConfigDecoder, getVirtualPoolDecoder, type PoolConfig, type PoolState } from "@top-pad/clients/dbc";
import { TAX_WINDOW_SECONDS } from "@top-pad/clients/fee";
import { Address, Holdings, SwapPrepareRequest, SwapRequest, SwapSent, type PreparedSwap, type QuoteStep, type SwapOutcome, type SwapQuote, type Trade } from "@top-pad/contract";
import { coins, pools } from "@top-pad/db";
import { decodeTransaction, fetchRawTransaction, provisionalOrderKey } from "@top-pad/indexer";
import { minimumOut, quoteSwap, type Quote } from "@top-pad/meteora/quote";
import { explorerUrl, type Config } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";
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
/** The rent an associated token account holds, which a swap pays when it opens one. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** A swap's network fee, one signature, with room for a priority fee on a busy cluster. */
const NETWORK_FEE = 10_000n;
/** DBC's custom errors a quick trade can land with, in the trader's words. */
const DBC_ERRORS: Record<number, string> = {
  6002: "The price moved more than your slippage allows before the trade ran, so nothing was traded. Try again, or allow more slippage.",
  6013: "The coin's curve completed before the trade ran: it trades on Meteora once it graduates.",
};

type Rpc = ReturnType<typeof createSolanaRpc>;
type PoolRow = typeof pools.$inferSelect;

/** What a quote reads, in one call: the pool, its config and the chain's clock, and the wallet's balances if asked. */
type Market = {
  pool: PoolState;
  config: PoolConfig;
  chainTime: bigint;
  wallet: { lamports: bigint; coins: bigint; coinAccountOpen: boolean; quoteAccountOpen: boolean } | null;
};

/** An SPL token account's balance: its amount sits after its mint and owner. */
const tokenAmount = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);

async function readMarket(rpc: Rpc, heat: HeatCluster, row: PoolRow, wallet: KitAddress | null): Promise<Market> {
  const walletAccounts = wallet ? [wallet, await tokenAccountOf(wallet, address(row.mint)), await tokenAccountOf(wallet, heat.quote.mint)] : [];
  const { value } = await rpc
    // At `processed`, the freshest the node has: the price and the second a trade sent now would meet.
    .getMultipleAccounts([address(row.pool), address(row.config), CLOCK_SYSVAR, ...walletAccounts], { encoding: "base64", commitment: "processed" })
    .send(limited());
  const bytes = (i: number) => {
    const account = value[i];
    return account ? (base64.encode(account.data[0]) as Uint8Array) : null;
  };
  const [poolBytes, configBytes, clockBytes] = [bytes(0), bytes(1), bytes(2)];
  if (!poolBytes || !configBytes || !clockBytes) throw new Error(`pool ${row.pool} or its config is missing on chain`);
  const coinBytes = bytes(4);
  return {
    pool: getVirtualPoolDecoder().decode(poolBytes).poolState,
    config: getPoolConfigDecoder().decode(configBytes),
    chainTime: new DataView(clockBytes.buffer, clockBytes.byteOffset).getBigInt64(32, true),
    wallet: wallet
      ? { lamports: value[3]?.lamports ?? 0n, coins: coinBytes ? tokenAmount(coinBytes) : 0n, coinAccountOpen: coinBytes !== null, quoteAccountOpen: value[5] !== null }
      : null,
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

/** The pool of a Heat coin: quick trades are built only for coins our launch key co-signed (spec 2.4). */
async function heatPool(c: Context<AppEnv>): Promise<{ row: PoolRow; heat: HeatCluster }> {
  const { cfg, db } = c.var;
  const mint = c.req.param("mint")!;
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys || !Address.safeParse(mint).success) throw new Refusal(404, "Heat has no coin at this address.");
  const [found] = await db.select({ pool: pools, coin: coins.mint }).from(pools).leftJoin(coins, eq(coins.mint, pools.mint)).where(eq(pools.mint, mint));
  if (!found) throw new Refusal(404, "Heat has no coin at this address.");
  if (!found.coin) throw new Refusal(409, "Heat builds trades only for coins launched through Heat.");
  return { row: found.pool, heat };
}

/** Why a market cannot trade now, if it cannot. */
function closedReason(market: Market): string | null {
  if (market.pool.isMigrated || market.pool.quoteReserve >= market.config.migrationQuoteThreshold) {
    return "This coin's curve is complete: it trades on Meteora once it graduates.";
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
  const taxEndsAt = market.pool.activationPoint + TAX_WINDOW_SECONDS;
  const at = (second: bigint) => quoteSwap({ pool: market.pool, config: market.config, side: request.side, amountIn, currentPoint: second, hasReferral });
  const first = at(market.chainTime);
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
      minimumOut: `${minimumOut(first.amountOut, request.slippageBps)}`,
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
    const { row, heat } = await heatPool(c);
    return quoteOrRefuse(await readMarket(createSolanaRpc(c.var.cfg.rpcUrl), heat, row, null), request).quote;
  });

const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;

/**
 * `POST /coins/:mint/swap`: the quote and its transaction, for the wallet to sign and send. Refused when the wallet
 * cannot pay for it: a buy needs its SOL, the rent of any account it opens and the network fee; a sell needs the coins.
 */
export const prepareSwap = (c: Context<AppEnv>) =>
  respond(c, async () => {
    const { cfg } = c.var;
    const request = await body(c, SwapPrepareRequest, `${BAD_REQUEST} Name the wallet that signs.`);
    const { row, heat } = await heatPool(c);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const wallet = address(request.wallet);
    const market = await readMarket(rpc, heat, row, wallet);
    const { quote, first } = quoteOrRefuse(market, request);
    const held = market.wallet!;
    // The wrapped SOL account a swap opens is closed in the same transaction, its rent back with the proceeds.
    const opening = (held.coinAccountOpen ? 0n : TOKEN_ACCOUNT_RENT) + (held.quoteAccountOpen ? 0n : TOKEN_ACCOUNT_RENT);
    if (request.side === "buy") {
      const needs = first.amountIn + opening + NETWORK_FEE;
      if (held.lamports < needs) throw new Refusal(400, `This wallet holds ${sol(held.lamports)}; the buy needs ${sol(needs)}, with its accounts' rent and the network fee.`);
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
        quoteMint: heat.quote.mint,
        trader: createNoopSigner(wallet),
        side: request.side,
        amountIn: BigInt(request.amount),
        minimumOut: BigInt(quote.minimumOut),
        mode: request.side === "buy" ? "partial_fill" : "exact_in",
        referralAccount: await referralAccountOf(heat.keys!.treasury, heat.quote.mint),
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
    if (!cfg.heat || !Address.safeParse(mint).success || !(await db.select({ mint: pools.mint }).from(pools).where(eq(pools.mint, mint))).length) {
      throw new Refusal(404, "Heat has no coin at this address.");
    }
    const coinAccount = await tokenAccountOf(address(wallet), address(mint));
    const { value } = await createSolanaRpc(cfg.rpcUrl).getMultipleAccounts([address(wallet), coinAccount], { encoding: "base64", commitment: "confirmed" }).send(limited());
    const coinBytes = value[1] ? (base64.encode(value[1].data[0]) as Uint8Array) : null;
    const holdings: Holdings = { wallet, sol: `${value[0]?.lamports ?? 0n}`, coins: `${coinBytes ? tokenAmount(coinBytes) : 0n}` };
    return holdings;
  });

/** A swap decoded from a landed transaction, as the page shows a trade, its order key provisional. */
function provisionalTrade(cfg: Config, swap: ReturnType<typeof decodeTransaction>["swaps"][number], signature: string, slot: number): Trade {
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
    price: priceOfSqrtPrice(swap.sqrtPrice, cfg.heat!.quote.decimals),
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
    const { row, heat } = await heatPool(c);
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const until = Date.now() + SETTLE_WAIT_MS;
    const settled = (await settleSignatures(rpc, [signature], SETTLE_WAIT_MS, SETTLE_POLL_MS)).get(signature)!;
    const outcome: SwapOutcome = { signature, status: settled.status, error: settled.error, explorer: explorerUrl(cfg, "tx", signature), trades: [] };
    if (settled.status === "failed") {
      const code = customError(JSON.parse(settled.error ?? "null"));
      outcome.error = (code !== null && DBC_ERRORS[code]) || `The trade failed on chain: ${settled.error}.`;
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
    const configs = new Set<string>([heat.configs!.instant, heat.configs!.fairOpen]);
    outcome.trades = decodeTransaction(raw, configs)
      .swaps.filter((s) => s.mint === row.mint)
      .map((s) => provisionalTrade(cfg, s, signature, raw.slot));
    return outcome;
  });

