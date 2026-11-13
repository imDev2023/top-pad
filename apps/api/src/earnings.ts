// Creator Earnings (spec 4, 7; spec 9, screen 5): what waits for a wallet in each Heat coin whose DBC creator role it
// holds, read from the chain so a page shows exactly what a claim pays, and once a coin has graduated what the creator's
// own position in its DAMM v2 pool has accrued, grouped by the quote each coin is priced in (ADR 0007, #99); the claim
// of both, built here for the wallet to sign and send in one request, one quote's coins a transaction; and its report,
// once sent, read back from the chain and handed to the indexer at once.
import {
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Address as KitAddress,
  type Base58EncodedBytes,
} from "@solana/kit";
import { eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  claimablePool,
  creatorClaimMessages,
  creatorShare,
  DBC_LAYOUT,
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  type ClaimablePool,
  type FeeClaim,
  type GraduatedPosition,
  type HeatCluster,
} from "@top-pad/chain";
import { fetchAllMaybePool, fetchAllMaybePosition } from "@top-pad/clients/damm-v2";
import { getVirtualPoolDecoder, getVirtualPoolSize } from "@top-pad/clients/dbc";
import { fetchAllMaybeCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import {
  Address,
  ClaimRequest,
  ClaimSent,
  type ClaimOutcome,
  type CreatorEarnings,
  type EarningsCoin,
  type EarningsQuote,
  type PreparedClaim,
} from "@top-pad/contract";
import { coins, feeClaims, graduations, launches, lpFeeClaims, pools, type Db } from "@top-pad/db";
import { dammPoolsIn, decodeTransaction, fetchRawTransaction, heatConfigs, rpcConfigReader, type GraduatedPoolRef, type HeatConfigs } from "@top-pad/indexer";
import { unclaimedPositionFees } from "@top-pad/meteora/damm";
import { positionsOf } from "./graduation";
import { explorerUrl, type Config } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";
import { quoteInfoOf } from "./quotes";
import { settleSignatures } from "./send";
import { storedLabels } from "./vampShield";

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
/** How long a report waits for its transactions to confirm, and then to be served, before answering with what it has. */
const SETTLE_WAIT_MS = 30_000;
/** `getMultipleAccounts` takes at most 100 addresses a call. */
const ACCOUNTS_PER_CALL = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base64 = getBase64Encoder();

type Rpc = ReturnType<typeof createSolanaRpc>;

/** An address as `getProgramAccounts` compares it to an account's bytes. */
const asBytes = (address: KitAddress) => address as string as Base58EncodedBytes;

/** Every config Heat's coins can be on now: SOL's pair and every pair the band job has made for another quote. */
const configsOf = (cfg: Config, db: Db, heat: HeatCluster) => heatConfigs(db, heat, rpcConfigReader(cfg.rpcUrl));

/**
 * The pools on Heat's configs whose DBC creator role `wallet` holds now, from DBC's own accounts, each with its config's
 * quote: one `getProgramAccounts` by creator alone, kept to Heat's configs here, so the read does not grow as the band
 * job adds pairs.
 */
async function heldPools(rpc: Rpc, configs: HeatConfigs, wallet: KitAddress): Promise<ClaimablePool[]> {
  const decoder = getVirtualPoolDecoder();
  const found = await rpc
    .getProgramAccounts(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getVirtualPoolSize()) },
        { memcmp: { offset: BigInt(DBC_LAYOUT.poolCreatorOffset), bytes: asBytes(wallet), encoding: "base58" } },
      ],
    })
    .send(limited());
  return found.flatMap(({ pubkey, account }) => {
    const state = decoder.decode(base64.encode(account.data[0])).poolState;
    const config = configs.get(state.config);
    return config ? [claimablePool(pubkey, state, config.quote.mint)] : [];
  });
}

/**
 * The pools a `CoinRecord` lists, Heat coins, with whether each one's window claim has run; a pool made around Heat's
 * flow has no record and is left out, since Heat's pages list only its own coins (spec 2.4, 8).
 */
async function heatCoins(rpc: Rpc, pools: ClaimablePool[]): Promise<{ pool: ClaimablePool; windowClaimed: boolean }[]> {
  const listed: { pool: ClaimablePool; windowClaimed: boolean }[] = [];
  for (let i = 0; i < pools.length; i += ACCOUNTS_PER_CALL) {
    const batch = pools.slice(i, i + ACCOUNTS_PER_CALL);
    const records = await Promise.all(batch.map(async (p) => (await findCoinRecordPda({ mint: p.mint }))[0]));
    const accounts = await fetchAllMaybeCoinRecord(rpc, records, limited());
    accounts.forEach((record, j) => {
      if (record.exists) listed.push({ pool: batch[j]!, windowClaimed: record.data.windowClaimed });
    });
  }
  return listed;
}

/** What waits for the wallet in a pool: half its partner fees, once its window claim has run. */
const partnerFeesOf = (coin: { pool: ClaimablePool; windowClaimed: boolean }) => (coin.windowClaimed ? coin.pool.partnerQuoteFee : 0n);

/**
 * The creator's positions in the graduated pools of these coins whose NFT `wallet` holds, as recorded at Graduation,
 * each with what it has accrued in its coin's quote, read from the chain. `quotes` names each coin's quote mint.
 */
async function lpPositions(rpc: Rpc, db: Db, wallet: string, quotes: ReadonlyMap<string, KitAddress>): Promise<Map<string, { position: GraduatedPosition; fees: bigint }>> {
  const mints = [...quotes.keys()];
  const rows = mints.length ? await db.select().from(graduations).where(inArray(graduations.mint, mints)) : [];
  const held = rows.filter((g) => g.creatorPositionOwner === wallet);
  const positions = await Promise.all(held.map(async (g) => (await positionsOf(g, quotes.get(g.mint)!)).creator));
  const found = new Map<string, { position: GraduatedPosition; fees: bigint }>();
  for (let i = 0; i < positions.length; i += ACCOUNTS_PER_CALL / 2) {
    const batch = positions.slice(i, i + ACCOUNTS_PER_CALL / 2);
    const [dammPools, states] = await Promise.all([
      fetchAllMaybePool(rpc, batch.map((p) => p.pool), limited()),
      fetchAllMaybePosition(rpc, batch.map((p) => p.position), limited()),
    ]);
    batch.forEach((position, j) => {
      const pool = dammPools[j]!;
      const state = states[j]!;
      if (pool.exists && state.exists) found.set(position.mint, { position, fees: unclaimedPositionFees(pool.data, state.data).quote });
    });
  }
  return found;
}

/** Each held coin's quote mint, by its mint. */
const quotesOf = (held: { pool: ClaimablePool }[]) => new Map(held.map((h) => [h.pool.mint as string, h.pool.quoteMint]));

/**
 * What every claim has paid `wallet` so far, by coin, with the quote each was paid in (its pool's): curve earnings from
 * the fee program's events and LP fees from DAMM v2's, as the indexer keeps them.
 */
async function paidTo(db: Db, wallet: string): Promise<{ mint: string; quoteMint: string; amount: bigint }[]> {
  const curve = await db
    .select({ mint: feeClaims.mint, quoteMint: pools.quoteMint, amount: sql<string>`sum(${feeClaims.creatorAmount})::text` })
    .from(feeClaims)
    .innerJoin(pools, eq(pools.pool, feeClaims.pool))
    .where(eq(feeClaims.creator, wallet))
    .groupBy(feeClaims.mint, pools.quoteMint);
  const lp = await db
    .select({ mint: lpFeeClaims.mint, quoteMint: pools.quoteMint, amount: sql<string>`sum(${lpFeeClaims.quoteAmount})::text` })
    .from(lpFeeClaims)
    .innerJoin(pools, eq(pools.mint, lpFeeClaims.mint))
    .where(eq(lpFeeClaims.owner, wallet))
    .groupBy(lpFeeClaims.mint, pools.quoteMint);
  return [...curve, ...lp].map((p) => ({ mint: p.mint, quoteMint: p.quoteMint, amount: BigInt(p.amount) }));
}

const sum = (amounts: Iterable<bigint>) => [...amounts].reduce((total, amount) => total + amount, 0n);

const badWallet = (c: Context<AppEnv>) => c.json({ error: "That is not a Solana wallet address." }, 400);

/** `GET /earnings/:wallet`. */
export async function getEarnings(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return badWallet(c);
  const heat = cfg.heat;
  if (!heat?.configs) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const held = await heatCoins(rpc, await heldPools(rpc, await configsOf(cfg, db, heat), wallet as KitAddress));

  const mints = held.map((h) => h.pool.mint);
  const rows = mints.length
    ? await db.select({ coin: coins, looksLike: launches.looksLike }).from(coins).leftJoin(launches, eq(launches.mint, coins.mint)).where(inArray(coins.mint, mints))
    : [];
  const paid = await paidTo(db, wallet);
  const paidBy = new Map<string, bigint>();
  for (const p of paid) paidBy.set(p.mint, (paidBy.get(p.mint) ?? 0n) + p.amount);
  const lp = await lpPositions(rpc, db, wallet, quotesOf(held));

  const shown = held.flatMap((h) => {
    const row = rows.find((r) => r.coin.mint === h.pool.mint);
    // A coin registered moments ago that the indexer has not written yet shows on the next load.
    if (!row) return [];
    const { coin } = row;
    const partnerFees = partnerFeesOf(h);
    const lpFees = lp.get(coin.mint)?.fees ?? 0n;
    const view: EarningsCoin = {
      mint: coin.mint,
      pool: h.pool.pool,
      name: coin.name,
      ticker: coin.ticker,
      imageUri: coin.imageUri,
      looksLike: storedLabels(row.looksLike),
      partnerFees: partnerFees.toString(),
      lpFees: lpFees.toString(),
      waiting: (creatorShare(partnerFees) + lpFees).toString(),
      windowClaimed: h.windowClaimed,
      claimed: (paidBy.get(coin.mint) ?? 0n).toString(),
    };
    return [{ quoteMint: h.pool.quoteMint as string, view }];
  });
  shown.sort((a, b) => (BigInt(b.view.waiting) > BigInt(a.view.waiting) ? 1 : BigInt(b.view.waiting) < BigInt(a.view.waiting) ? -1 : a.view.name.localeCompare(b.view.name)));

  // SOL always, then each other quote, in the order the cluster lists them, that the wallet holds a coin in or was paid in.
  const quotes: EarningsQuote[] = [];
  for (const [i, listed] of heat.quotes.entries()) {
    const inQuote = shown.filter((s) => s.quoteMint === listed.mint).map((s) => s.view);
    const paidIn = paid.filter((p) => p.quoteMint === listed.mint);
    if (i > 0 && !inQuote.length && !paidIn.length) continue;
    quotes.push({
      quote: await quoteInfoOf(cfg, heat, listed.mint),
      coins: inQuote,
      waiting: sum(inQuote.map((coin) => BigInt(coin.waiting))).toString(),
      claimed: sum(paidIn.map((p) => p.amount)).toString(),
    });
  }
  const body: CreatorEarnings = { wallet, quotes };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/**
 * `POST /earnings/:wallet/claim`: the claim of the coins asked for, each up to the partner fees the page showed, so it
 * pays exactly what the page showed. Refused when a coin's figure is gone (claimed meanwhile, or its role handed over).
 * One claim pays one quote (`creatorClaimInstructions`), so each quote's coins get transactions of their own, all signed
 * in one wallet request.
 */
export async function prepareClaim(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return badWallet(c);
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const request = ClaimRequest.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: "Say which coins to claim, each with the earnings the page showed." }, 400);
  if (new Set(request.data.claims.map((asked) => asked.mint)).size !== request.data.claims.length) {
    return c.json({ error: "Name each coin once." }, 400);
  }

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const held = await heatCoins(rpc, await heldPools(rpc, await configsOf(cfg, db, heat), wallet as KitAddress));
  const asked = new Set(request.data.claims.map((a) => a.mint as string));
  const lp = await lpPositions(rpc, db, wallet, quotesOf(held.filter((h) => asked.has(h.pool.mint))));
  // Each quote's claims, in the order the coins were asked for.
  const byQuote = new Map<string, FeeClaim[]>();
  const pays: { mint: string; quoteMint: string; pays: bigint }[] = [];
  for (const asked of request.data.claims) {
    const coin = held.find((h) => h.pool.mint === asked.mint);
    const shownFees = BigInt(asked.partnerFees);
    const shownLp = BigInt(asked.lpFees);
    if (!coin) return c.json({ error: "This wallet no longer holds the creator role of one of these coins. Refresh to see what waits for it." }, 409);
    if (creatorShare(shownFees) === 0n && shownLp === 0n) return c.json({ error: "Nothing waits for this wallet in one of these coins." }, 409);
    if (partnerFeesOf(coin) < shownFees) return c.json({ error: "These earnings were claimed meanwhile. Refresh to see what waits now." }, 409);
    const position = lp.get(asked.mint);
    if (shownLp > 0n && (!position || position.fees < shownLp)) return c.json({ error: "These LP fees were claimed meanwhile. Refresh to see what waits now." }, 409);
    const quoteMint = coin.pool.quoteMint as string;
    byQuote.set(quoteMint, [...(byQuote.get(quoteMint) ?? []), { pool: coin.pool, heat: true, maxAmount: shownFees, lpPosition: shownLp > 0n ? position!.position : null }]);
    pays.push({ mint: asked.mint, quoteMint, pays: creatorShare(shownFees) + shownLp });
  }
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const creator = createNoopSigner(wallet as KitAddress);
  const transactions: string[] = [];
  for (const claims of byQuote.values()) {
    const messages = await creatorClaimMessages({ creator, claims, treasury: heat.keys.treasury, computeUnitPrice: cfg.computeUnitPrice }, lifetime);
    transactions.push(...messages.map((message) => getBase64EncodedWireTransaction(compileTransaction(message))));
  }
  const body: PreparedClaim = {
    transactions,
    quotes: [...byQuote.keys()].map((mint) => ({ mint, pays: sum(pays.filter((p) => p.quoteMint === mint).map((p) => p.pays)).toString() })),
    coins: pays.map((p) => ({ mint: p.mint, pays: p.pays.toString() })),
  };
  return c.json(body);
}

/**
 * `POST /earnings/claims`: a claim's transactions, sent by the wallet, settled against the chain; what landed is read
 * from the fee program's own events and handed to the indexer, so the creator's page and the coin's show it at once.
 */
export async function reportClaim(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const heat = cfg.heat;
  if (!heat?.configs) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const sent = ClaimSent.safeParse(await c.req.json().catch(() => null));
  if (!sent.success) return c.json({ error: "Send the claim's transaction signatures." }, 400);
  const signatures = [...new Set(sent.data.signatures)];
  const rpc = createSolanaRpc(cfg.rpcUrl);

  const until = Date.now() + SETTLE_WAIT_MS;
  const outcome = await settleSignatures(rpc, signatures, SETTLE_WAIT_MS);
  const landed = signatures.filter((s) => outcome.get(s)?.status === "landed");
  c.executionCtx.waitUntil(indexNow(c.env, landed));

  const configs = await configsOf(cfg, db, heat);
  const known = configs.set();
  // What each coin was paid, and in which quote: its config's.
  const paid = new Map<string, { quoteMint: string; amount: bigint }>();
  const add = (mint: string, config: string, amount: bigint) => {
    const quoteMint = configs.get(config)?.quote.mint;
    if (!quoteMint) return;
    paid.set(mint, { quoteMint, amount: (paid.get(mint)?.amount ?? 0n) + amount });
  };
  for (const signature of landed) {
    let raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    // A node reports a transaction confirmed a moment before it serves it.
    while (!raw && Date.now() < until) {
      await sleep(500);
      raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    }
    if (!raw) continue;
    // The graduated pools the claim took LP fees from, as Heat knows them.
    const named = dammPoolsIn(raw);
    const rows = named.length ? await db.select().from(graduations).where(inArray(graduations.pool, named)) : [];
    const graduated = new Map<string, GraduatedPoolRef>(rows.map((g) => [g.pool, { mint: g.mint, config: g.config }]));
    const decoded = decodeTransaction(raw, known, graduated);
    for (const claim of decoded.feeClaims) add(claim.mint, claim.config, claim.creatorAmount);
    for (const claim of decoded.lpFeeClaims) add(claim.mint, graduated.get(claim.pool)!.config, claim.quoteAmount);
  }
  const quoteMints = [...new Set([...paid.values()].map((p) => p.quoteMint))];
  const body: ClaimOutcome = {
    transactions: signatures.map((signature) => ({
      signature,
      status: outcome.get(signature)?.status ?? "pending",
      error: outcome.get(signature)?.error ?? null,
      explorer: explorerUrl(cfg, "tx", signature),
    })),
    quotes: quoteMints.map((mint) => ({ mint, paid: sum([...paid.values()].filter((p) => p.quoteMint === mint).map((p) => p.amount)).toString() })),
    coins: [...paid].map(([mint, p]) => ({ mint, paid: p.amount.toString() })),
  };
  return c.json(body);
}
