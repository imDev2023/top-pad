// Creator Earnings (spec 4, 7; spec 9, screen 5): what waits for a wallet in each Heat coin whose DBC creator role it
// holds, read from the chain so a page shows exactly what a claim pays; the claim, built here for the wallet to sign and
// send; and its report, once sent, read back from the chain and handed to the indexer at once.
import {
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Address as KitAddress,
  type Base58EncodedBytes,
  type Signature,
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
  type HeatCluster,
} from "@top-pad/chain";
import { getVirtualPoolDecoder, getVirtualPoolSize } from "@top-pad/clients/dbc";
import { fetchAllMaybeCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import { Address, ClaimRequest, ClaimSent, type ClaimOutcome, type CreatorEarnings, type EarningsCoin, type PreparedClaim } from "@top-pad/contract";
import { coins, feeClaims } from "@top-pad/db";
import { decodeTransaction, fetchRawTransaction } from "@top-pad/indexer";
import { explorerUrl } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";

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

/** The pools on Heat's configs whose DBC creator role `wallet` holds now, from DBC's own accounts. */
async function heldPools(rpc: Rpc, heat: HeatCluster, wallet: KitAddress): Promise<ClaimablePool[]> {
  const decoder = getVirtualPoolDecoder();
  const configs = heat.configs ? [heat.configs.instant, heat.configs.fairOpen] : [];
  const found = await Promise.all(
    configs.map((config) =>
      rpc
        .getProgramAccounts(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, {
          encoding: "base64",
          filters: [
            { dataSize: BigInt(getVirtualPoolSize()) },
            { memcmp: { offset: BigInt(DBC_LAYOUT.poolConfigOffset), bytes: asBytes(config), encoding: "base58" } },
            { memcmp: { offset: BigInt(DBC_LAYOUT.poolCreatorOffset), bytes: asBytes(wallet), encoding: "base58" } },
          ],
        })
        .send(limited()),
    ),
  );
  return found.flat().map(({ pubkey, account }) => claimablePool(pubkey, decoder.decode(base64.encode(account.data[0])).poolState, heat.quote.mint));
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

const badWallet = (c: Context<AppEnv>) => c.json({ error: "That is not a Solana wallet address." }, 400);

/** `GET /earnings/:wallet`. */
export async function getEarnings(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return badWallet(c);
  const heat = cfg.heat;
  if (!heat?.configs) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const held = await heatCoins(rpc, await heldPools(rpc, heat, wallet as KitAddress));

  const mints = held.map((h) => h.pool.mint);
  const rows = mints.length ? await db.select().from(coins).where(inArray(coins.mint, mints)) : [];
  const paid = await db
    .select({ mint: feeClaims.mint, amount: sql<string>`sum(${feeClaims.creatorAmount})::text` })
    .from(feeClaims)
    .where(eq(feeClaims.creator, wallet))
    .groupBy(feeClaims.mint);
  const paidBy = new Map(paid.map((p) => [p.mint, BigInt(p.amount)]));

  const shown: EarningsCoin[] = held.flatMap((h) => {
    const coin = rows.find((r) => r.mint === h.pool.mint);
    // A coin registered moments ago that the indexer has not written yet shows on the next load.
    if (!coin) return [];
    const partnerFees = partnerFeesOf(h);
    return [
      {
        mint: coin.mint,
        pool: h.pool.pool,
        name: coin.name,
        ticker: coin.ticker,
        imageUri: coin.imageUri,
        partnerFees: partnerFees.toString(),
        waiting: creatorShare(partnerFees).toString(),
        windowClaimed: h.windowClaimed,
        claimed: (paidBy.get(coin.mint) ?? 0n).toString(),
      },
    ];
  });
  shown.sort((a, b) => (BigInt(b.waiting) > BigInt(a.waiting) ? 1 : BigInt(b.waiting) < BigInt(a.waiting) ? -1 : a.name.localeCompare(b.name)));
  const body: CreatorEarnings = {
    wallet,
    quote: { symbol: heat.quote.symbol, decimals: heat.quote.decimals },
    coins: shown,
    waiting: shown.reduce((sum, coin) => sum + BigInt(coin.waiting), 0n).toString(),
    claimed: paid.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/**
 * `POST /earnings/:wallet/claim`: the claim of the coins asked for, each up to the partner fees the page showed, so it
 * pays exactly what the page showed. Refused when a coin's figure is gone (claimed meanwhile, or its role handed over).
 */
export async function prepareClaim(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const wallet = c.req.param("wallet")!;
  if (!Address.safeParse(wallet).success) return badWallet(c);
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const request = ClaimRequest.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: "Say which coins to claim, each with the earnings the page showed." }, 400);

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const held = await heatCoins(rpc, await heldPools(rpc, heat, wallet as KitAddress));
  const claims = [];
  for (const asked of request.data.claims) {
    const coin = held.find((h) => h.pool.mint === asked.mint);
    const shownFees = BigInt(asked.partnerFees);
    if (!coin) return c.json({ error: "This wallet no longer holds the creator role of one of these coins. Refresh to see what waits for it." }, 409);
    if (shownFees === 0n || creatorShare(shownFees) === 0n) return c.json({ error: "Nothing waits for this wallet in one of these coins." }, 409);
    if (partnerFeesOf(coin) < shownFees) return c.json({ error: "These earnings were claimed meanwhile. Refresh to see what waits now." }, 409);
    claims.push({ pool: coin.pool, heat: true, maxAmount: shownFees });
  }
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const messages = await creatorClaimMessages(
    { creator: createNoopSigner(wallet as KitAddress), claims, treasury: heat.keys.treasury, computeUnitPrice: cfg.computeUnitPrice },
    lifetime,
  );
  const pays = claims.map((claim) => ({ mint: claim.pool.mint, pays: creatorShare(claim.maxAmount).toString() }));
  const body: PreparedClaim = {
    transactions: messages.map((message) => getBase64EncodedWireTransaction(compileTransaction(message))),
    pays: claims.reduce((sum, claim) => sum + creatorShare(claim.maxAmount), 0n).toString(),
    coins: pays,
  };
  return c.json(body);
}

/**
 * `POST /earnings/claims`: a claim's transactions, sent by the wallet, settled against the chain; what landed is read
 * from the fee program's own events and handed to the indexer, so the creator's page and the coin's show it at once.
 */
export async function reportClaim(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const heat = cfg.heat;
  if (!heat?.configs) return c.json({ error: `Heat has no coins on ${cfg.cluster}.` }, 503);
  const sent = ClaimSent.safeParse(await c.req.json().catch(() => null));
  if (!sent.success) return c.json({ error: "Send the claim's transaction signatures." }, 400);
  const signatures = [...new Set(sent.data.signatures)];
  const rpc = createSolanaRpc(cfg.rpcUrl);

  const until = Date.now() + SETTLE_WAIT_MS;
  const outcome = new Map<string, { status: "landed" | "failed" | "pending"; error: string | null }>();
  for (;;) {
    const { value } = await rpc.getSignatureStatuses(signatures as Signature[], { searchTransactionHistory: true }).send(limited());
    value.forEach((status, i) => {
      if (status?.err) outcome.set(signatures[i]!, { status: "failed", error: JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v)) });
      else if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") outcome.set(signatures[i]!, { status: "landed", error: null });
    });
    if (outcome.size === signatures.length || Date.now() > until) break;
    await sleep(1_000);
  }
  const landed = signatures.filter((s) => outcome.get(s)?.status === "landed");
  c.executionCtx.waitUntil(indexNow(c.env, landed));

  const configs = new Set<string>([heat.configs.instant, heat.configs.fairOpen]);
  const paid = new Map<string, bigint>();
  for (const signature of landed) {
    let raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    // A node reports a transaction confirmed a moment before it serves it.
    while (!raw && Date.now() < until) {
      await sleep(500);
      raw = await fetchRawTransaction(cfg.rpcUrl, signature).catch(() => null);
    }
    for (const claim of raw ? decodeTransaction(raw, configs).feeClaims : []) paid.set(claim.mint, (paid.get(claim.mint) ?? 0n) + claim.creatorAmount);
  }
  const body: ClaimOutcome = {
    transactions: signatures.map((signature) => ({
      signature,
      status: outcome.get(signature)?.status ?? "pending",
      error: outcome.get(signature)?.error ?? null,
      explorer: explorerUrl(cfg, "tx", signature),
    })),
    paid: [...paid.values()].reduce((sum, amount) => sum + amount, 0n).toString(),
    coins: [...paid].map(([mint, amount]) => ({ mint, paid: amount.toString() })),
  };
  return c.json(body);
}
