// A Fair Open's page and its transactions (spec 2.1 steps 9 to 12 and 15; spec 9, screen 2). The launch is read from its
// account, the one place its pot is always right, with what the pot would buy if the window closed now by the
// reference calculation the program's own must match (spec 2.1 step 11), and once it has opened, what each seat bought.
// Deposits, withdrawals, a seat's claim after the open, the failure and the refund are built here for the wallet to sign
// and send, a deposit carrying its admission; none of it is needed to get a deposit or coins out, which `@top-pad/chain`
// builds from the chain alone (tests/devnet shows it with no Heat server).
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address as KitAddress,
  type Base58EncodedBytes,
  type Instruction,
  type Signature as KitSignature,
} from "@solana/kit";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  allocate,
  claimInstructions,
  COIN_DECIMALS,
  dbcPoolAddress,
  depositInstructions,
  FAIR_OPEN_PROGRAM_ADDRESS,
  fairOpenPhase,
  LATE_OPEN_SECONDS,
  markFailedInstructions,
  rungAtOrBelow,
  SEAT_LAYOUT,
  seatOutcome,
  spentOf,
  Tier,
  tierCap,
  withdrawFailedInstructions,
  withdrawInstructions,
} from "@top-pad/chain";
import { fetchMaybeLaunch, getSeatDecoder, getSeatSize, LaunchStatus, type Launch, type Seat } from "@top-pad/clients/fair-open";
import {
  Address,
  FairOpenMove,
  FairOpenSender,
  FairOpenSent,
  type FairOpen,
  type FairOpenAdmission,
  type FairOpenOutcome,
  type FairOpenPhase,
  type FairOpenRefusal,
  type FairOpenSeat,
  type PreparedFairOpenTransaction,
} from "@top-pad/contract";
import { creators, creatorWallets, fairOpens, pools } from "@top-pad/db";
import { admit, AdmissionRefused, loadAdmissionKey, personOf, refusalOf, tierName } from "./admission";
import { sessionCreator } from "./auth";
import { explorerUrl, fairOpenSetup } from "./env";
import type { AppEnv } from "./http";
import { indexNow } from "./indexing";

const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
/** How long a report waits for its transaction to confirm before answering "pending". */
const SETTLE_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base64 = getBase64Encoder();

type Rpc = ReturnType<typeof createSolanaRpc>;
type LaunchRow = typeof fairOpens.$inferSelect;

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const now = () => BigInt(Math.floor(Date.now() / 1000));
const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const refuse = (c: Context<AppEnv>, status: 400 | 404 | 409 | 403 | 503, body: FairOpenRefusal) => c.json(body, status);
const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(2)} SOL`;

/** What a new seat prepays beyond its deposit, by the cluster's rent: the same every time, so asked once. */
let rentAsked: Promise<{ seat: bigint; coinAccount: bigint }> | null = null;
function rents(rpc: Rpc) {
  rentAsked ??= Promise.all([
    rpc.getMinimumBalanceForRentExemption(BigInt(getSeatSize())).send(limited()),
    rpc.getMinimumBalanceForRentExemption(165n).send(limited()),
  ]).then(([seat, coinAccount]) => ({ seat, coinAccount }));
  rentAsked.catch(() => (rentAsked = null));
  return rentAsked;
}

/** A wallet's seat in a launch, from the chain alone: the seat accounts naming that launch and that wallet. */
async function seatOfWallet(rpc: Rpc, launch: KitAddress, wallet: KitAddress): Promise<{ address: KitAddress; seat: Seat; lamports: bigint } | null> {
  const found = await rpc
    .getProgramAccounts(FAIR_OPEN_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getSeatSize()) },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.launchOffset), bytes: launch as string as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.walletOffset), bytes: wallet as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send(limited());
  const first = found[0];
  if (!first) return null;
  return { address: first.pubkey, seat: getSeatDecoder().decode(base64.encode(first.account.data[0])), lamports: first.account.lamports };
}

/** The phase a page shows: the chain's, and `closed` once the launch account is gone. */
function phaseOf(launch: Launch | null, row: LaunchRow | undefined, at: bigint): { phase: FairOpenPhase; failure: FairOpen["failure"] } {
  if (!launch) return { phase: "closed", failure: row?.failure ?? null };
  const p = fairOpenPhase(launch, at);
  return { phase: p.phase, failure: p.phase === "failing" || p.phase === "failed" ? p.failure : null };
}

/** The Creator wallet's record, if Heat has one: its X handle, name and picture. */
async function creatorOf(c: Context<AppEnv>, wallet: string) {
  const [row] = await c.var.db
    .select({ handle: creators.xHandle, name: creators.xName, avatarUrl: creators.xAvatarUrl })
    .from(creatorWallets)
    .innerJoin(creators, eq(creators.id, creatorWallets.creatorId))
    .where(and(eq(creatorWallets.wallet, wallet), sql`${creatorWallets.endedAt} is null`));
  return { wallet, handle: row?.handle ?? null, name: row?.name ?? null, avatarUrl: row?.avatarUrl ?? null };
}

const badLaunch = (c: Context<AppEnv>) => refuse(c, 400, { error: "That is not a Fair Open's address.", code: "invalid" });
const notFound = (c: Context<AppEnv>) => refuse(c, 404, { error: "There is no Fair Open at this address.", code: "not_found" });

/** `GET /fair-opens/:launch?wallet=`. */
export async function getFairOpen(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const heat = cfg.heat;
  if (!heat) return refuse(c, 503, { error: `Heat runs no Fair Opens on ${cfg.cluster}.`, code: "unavailable" });
  const address = c.req.param("launch")!;
  if (!Address.safeParse(address).success) return badLaunch(c);
  const wallet = c.req.query("wallet");
  if (wallet !== undefined && !Address.safeParse(wallet).success) return refuse(c, 400, { error: "That is not a Solana wallet address.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const [account, [row]] = await Promise.all([fetchMaybeLaunch(rpc, address as KitAddress, limited()), db.select().from(fairOpens).where(eq(fairOpens.launch, address))]);
  if (!account.exists && !row) return notFound(c);
  const launch = account.exists ? account.data : null;
  const at = now();
  const { phase, failure } = phaseOf(launch, row, at);

  // A closed launch's terms come from the indexer, its pot is gone, and every seat has been returned.
  const terms = launch ?? {
    creator: row!.creator as KitAddress,
    identityHash: Uint8Array.from(row!.identityHash.match(/../g)!.map((b) => parseInt(b, 16))),
    depositsOpenAt: BigInt(Math.floor(row!.depositsOpenAt.getTime() / 1000)),
    opensAt: BigInt(Math.floor(row!.opensAt.getTime() / 1000)),
    step: row!.step,
    potCap: row!.potCap,
    minRaise: row!.minRaise,
    lowestRung: row!.lowestRung,
    counts: [] as number[],
    unverifiedCounts: [] as number[],
    seats: 0,
    unverifiedDeposits: 0n,
    scoredDeposits: 0n,
    verifiedDeposits: 0n,
  };
  const a = allocate(terms.counts, terms.unverifiedCounts, terms.step, terms.potCap);
  const rung = rungAtOrBelow(terms.potCap, a.spend);
  const level = (l: typeof a.others) => ({ level: `${l.level}`, filled: `${l.filled}`, limited: l.limited });
  const rent = await rents(rpc);

  let you: FairOpen["you"] = null;
  if (wallet) {
    const session = await sessionCreator(c);
    const person = await personOf(db, wallet as KitAddress, session);
    const seatExists = async (seat: KitAddress) => (await fetchEncodedAccount(rpc, seat, limited())).exists;
    const [refusal, found] = await Promise.all([
      refusalOf(db, { launch: address as KitAddress, creator: terms.creator, step: terms.step }, wallet as KitAddress, person, seatExists),
      launch ? seatOfWallet(rpc, address as KitAddress, wallet as KitAddress) : null,
    ]);
    const tier = Tier[person.tier === "scored" ? "Scored" : person.tier === "verified" ? "Verified" : "Unverified"];
    const admission: FairOpenAdmission = refusal
      ? { admitted: false, reason: refusal }
      : { admitted: true, tier: person.tier, cap: `${tierCap(tier, terms.step)}`, via: person.via, handle: person.handle };
    let seat: FairOpenSeat | null = null;
    if (found) {
      // Once opened, what the seat bought, by the same reference the program delivers it by; before, what it would.
      const opened = launch?.status === LaunchStatus.Opened ? seatOutcome(launch, found.seat.tier, found.seat.deposit) : null;
      const spent = opened?.spent ?? (rung === null ? 0n : spentOf(a, rung, found.seat.tier, found.seat.deposit));
      seat = {
        address: found.address,
        tier: tierName(found.seat.tier),
        cap: `${found.seat.cap}`,
        deposit: `${found.seat.deposit}`,
        seatRent: `${found.lamports}`,
        coinRent: `${found.seat.coinRent}`,
        fill: `${spent}`,
        refund: `${found.seat.deposit - spent}`,
        coins: opened ? `${opened.coins}` : null,
        delivered: found.seat.delivered,
      };
    }
    you = { wallet, admission, seat };
  }

  const body: FairOpen = {
    launch: address,
    creator: await creatorOf(c, terms.creator),
    teaser: row?.teaser ?? null,
    identityHash: hex(terms.identityHash),
    depositsOpenAt: iso(terms.depositsOpenAt),
    opensAt: iso(terms.opensAt),
    lateAt: iso(terms.opensAt + LATE_OPEN_SECONDS),
    phase,
    failure,
    serverTime: new Date().toISOString(),
    quote: { symbol: heat.quote.symbol, decimals: heat.quote.decimals },
    step: `${terms.step}`,
    potCap: `${terms.potCap}`,
    minRaise: `${terms.minRaise}`,
    lowestRung: `${terms.lowestRung}`,
    tierCaps: {
      unverified: `${tierCap(Tier.Unverified, terms.step)}`,
      scored: `${tierCap(Tier.Scored, terms.step)}`,
      verified: `${tierCap(Tier.Verified, terms.step)}`,
    },
    pot: {
      total: `${terms.unverifiedDeposits + terms.scoredDeposits + terms.verifiedDeposits}`,
      seats: terms.seats,
      unverified: `${terms.unverifiedDeposits}`,
      scored: `${terms.scoredDeposits}`,
      verified: `${terms.verifiedDeposits}`,
    },
    allocation: { spend: `${a.spend}`, others: level(a.others), unverified: level(a.unverified), rung: rung === null ? null : `${rung}` },
    open:
      launch?.status === LaunchStatus.Opened
        ? {
            mint: launch.mint,
            pool: await dbcPoolAddress(launch.dbcConfig, launch.mint, launch.quoteMint),
            coin: (await db.select({ name: pools.name, ticker: pools.ticker }).from(pools).where(eq(pools.mint, launch.mint)))[0] ?? null,
            spent: `${launch.spent}`,
            coins: `${launch.coins}`,
            coinDecimals: COIN_DECIMALS,
            delivered: launch.delivered,
          }
        : null,
    rent: { seat: `${rent.seat}`, coinAccount: `${rent.coinAccount}` },
    you,
    explorer: explorerUrl(cfg, "address", address),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
}

/** A transaction message for the wallet to sign, the wallet paying, on a recent blockhash. */
async function prepared(rpc: Rpc, wallet: KitAddress, instructions: Instruction[], admission: PreparedFairOpenTransaction["admission"] = null) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(wallet), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const body: PreparedFairOpenTransaction = { transaction: getBase64EncodedWireTransaction(compileTransaction(message)), admission };
  return body;
}

/** The launch a write is about, read from the chain, or the refusal to answer with. */
async function launchFor(c: Context<AppEnv>, rpc: Rpc) {
  const address = c.req.param("launch")!;
  if (!Address.safeParse(address).success) return { refusal: badLaunch(c) } as const;
  const account = await fetchMaybeLaunch(rpc, address as KitAddress, limited());
  if (!account.exists) return { refusal: notFound(c) } as const;
  return { address: address as KitAddress, launch: account.data } as const;
}

/** A window refusal in words: when it opens, or that it has closed. */
function outsideWindow(c: Context<AppEnv>, launch: Launch, at: bigint) {
  if (at < launch.depositsOpenAt) return refuse(c, 409, { error: `The window opens at ${iso(launch.depositsOpenAt).slice(11, 19)} UTC.`, code: "window" });
  return refuse(c, 409, { error: "The window has closed: deposits are locked until the open, or until the launch fails.", code: "window" });
}

/** An amount in the quote's raw units, in whole deposit steps. */
function stepAmount(raw: string, step: bigint) {
  const amount = BigInt(raw);
  return amount > 0n && amount % step === 0n ? amount : null;
}

/** `POST /fair-opens/:launch/deposit`: the deposit, with the wallet's admission, for the wallet to sign and send. */
export async function prepareDeposit(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const setup = fairOpenSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Deposits are not open here: ${setup.reason}`, code: "unavailable" });
  const move = FairOpenMove.safeParse(await c.req.json().catch(() => null));
  if (!move.success) return refuse(c, 400, { error: "Say which wallet deposits, and how much.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await launchFor(c, rpc);
  if ("refusal" in found) return found.refusal;
  const { address, launch } = found;
  const at = now();
  if (fairOpenPhase(launch, at).phase !== "window") return outsideWindow(c, launch, at);
  const amount = stepAmount(move.data.amount, launch.step);
  if (amount === null) return refuse(c, 400, { error: `Deposits move in steps of ${sol(launch.step)}.`, code: "invalid" });

  const wallet = move.data.wallet as KitAddress;
  const person = await personOf(db, wallet, await sessionCreator(c));
  const key = await loadAdmissionKey(setup.admissionKey, setup.admission);
  const seatExists = async (seat: KitAddress) => (await fetchEncodedAccount(rpc, seat, limited())).exists;
  let admitted;
  try {
    admitted = await admit(db, key, { launch: address, creator: launch.creator, step: launch.step }, wallet, person, at, seatExists);
  } catch (e) {
    if (e instanceof AdmissionRefused) return refuse(c, 403, { error: e.message, code: "not_admitted" });
    throw e;
  }
  const seat = await fetchEncodedAccount(rpc, admitted.seat, limited());
  const held = seat.exists ? getSeatDecoder().decode(seat.data).deposit : 0n;
  if (held + amount > admitted.admission.cap) {
    const room = admitted.admission.cap - held;
    const error = room > 0n ? `You can add at most ${sol(room)}: your cap is ${sol(admitted.admission.cap)}.` : `Your seat holds your whole cap, ${sol(admitted.admission.cap)}.`;
    return refuse(c, 409, { error, code: "over_cap" });
  }
  const instructions = await depositInstructions({
    launch: address,
    wallet: createNoopSigner(wallet),
    amount,
    admission: admitted.admission,
    admissionSigner: setup.admission,
    signature: admitted.signature,
    computeUnitPrice: cfg.computeUnitPrice,
  });
  return c.json(await prepared(rpc, wallet, instructions, { tier: admitted.tier, cap: `${admitted.admission.cap}` }));
}

/** `POST /fair-opens/:launch/withdraw`: taking back part or all of the wallet's deposit while the window is open. */
export async function prepareWithdrawal(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const move = FairOpenMove.safeParse(await c.req.json().catch(() => null));
  if (!move.success) return refuse(c, 400, { error: "Say which wallet withdraws, and how much.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await launchFor(c, rpc);
  if ("refusal" in found) return found.refusal;
  const { address, launch } = found;
  const at = now();
  if (fairOpenPhase(launch, at).phase !== "window") return outsideWindow(c, launch, at);
  const wallet = move.data.wallet as KitAddress;
  const seat = await seatOfWallet(rpc, address, wallet);
  if (!seat) return refuse(c, 404, { error: "This wallet holds no seat in this Fair Open.", code: "no_seat" });
  const amount = stepAmount(move.data.amount, launch.step);
  if (amount === null || amount > seat.seat.deposit) {
    return refuse(c, 400, { error: `You can take back up to ${sol(seat.seat.deposit)}, in steps of ${sol(launch.step)}.`, code: "invalid" });
  }
  const instructions = await withdrawInstructions({ launch: address, seat: seat.address, wallet: createNoopSigner(wallet), amount, computeUnitPrice: cfg.computeUnitPrice });
  return c.json(await prepared(rpc, wallet, instructions));
}

/**
 * `POST /fair-opens/:launch/mark-failed`: marking a launch that cannot open failed, which anyone may send and the wallet
 * pays for; a wallet with a seat takes its deposit and both rents back in the same transaction.
 */
export async function prepareMarkFailed(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const sender = FairOpenSender.safeParse(await c.req.json().catch(() => null));
  if (!sender.success) return refuse(c, 400, { error: "Say which wallet sends it.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await launchFor(c, rpc);
  if ("refusal" in found) return found.refusal;
  const { address, launch } = found;
  const phase = fairOpenPhase(launch, now());
  if (phase.phase !== "failing") {
    const error =
      phase.phase === "failed"
        ? "This Fair Open has already failed: take back your deposit."
        : phase.phase === "due"
          ? `The pot can still open: anyone may mark it failed from ${iso(phase.lateAt).slice(11, 19)} UTC if it has not.`
          : "The window is still open.";
    return refuse(c, 409, { error, code: "cannot_fail" });
  }
  const wallet = sender.data.wallet as KitAddress;
  const seat = await seatOfWallet(rpc, address, wallet);
  const refund = seat ? { seat: seat.address, wallet } : undefined;
  return c.json(await prepared(rpc, wallet, await markFailedInstructions({ launch: address, refund, computeUnitPrice: cfg.computeUnitPrice })));
}

/** `POST /fair-opens/:launch/refund`: a failed launch's deposit and both rents back to the wallet's seat's wallet. */
export async function prepareRefund(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const sender = FairOpenSender.safeParse(await c.req.json().catch(() => null));
  if (!sender.success) return refuse(c, 400, { error: "Say which wallet takes its deposit back.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await launchFor(c, rpc);
  if ("refusal" in found) return found.refusal;
  const { address, launch } = found;
  if (fairOpenPhase(launch, now()).phase !== "failed") return refuse(c, 409, { error: "This Fair Open has not failed: nothing to take back yet.", code: "not_failed" });
  const wallet = sender.data.wallet as KitAddress;
  const seat = await seatOfWallet(rpc, address, wallet);
  if (!seat) return refuse(c, 404, { error: "This wallet holds no seat in this Fair Open.", code: "no_seat" });
  return c.json(await prepared(rpc, wallet, await withdrawFailedInstructions({ launch: address, seat: seat.address, wallet, computeUnitPrice: cfg.computeUnitPrice })));
}

/**
 * `POST /fair-opens/:launch/claim`: once the launch has opened, the wallet's seat takes its coins and refund itself,
 * into the wallet's own coin account, if no push has delivered them yet. The creator's coins go only into the Creator
 * lock.
 */
export async function prepareFairOpenClaim(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const sender = FairOpenSender.safeParse(await c.req.json().catch(() => null));
  if (!sender.success) return refuse(c, 400, { error: "Say which wallet claims.", code: "invalid" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const found = await launchFor(c, rpc);
  if ("refusal" in found) return found.refusal;
  const { address, launch } = found;
  if (launch.status !== LaunchStatus.Opened) return refuse(c, 409, { error: "This Fair Open has not opened: there is nothing to claim yet.", code: "not_opened" });
  const wallet = sender.data.wallet as KitAddress;
  if (wallet === launch.creator) return refuse(c, 409, { error: "The creator's coins go only into the Creator lock.", code: "creators_seat" });
  const seat = await seatOfWallet(rpc, address, wallet);
  if (!seat) return refuse(c, 404, { error: "This wallet holds no seat in this Fair Open.", code: "no_seat" });
  if (seat.seat.delivered) return refuse(c, 409, { error: "Your coins and refund are in your wallet already.", code: "delivered" });
  const instructions = await claimInstructions({ launch: address, mint: launch.mint, seat: seat.address, wallet: createNoopSigner(wallet), computeUnitPrice: cfg.computeUnitPrice });
  return c.json(await prepared(rpc, wallet, instructions));
}

/**
 * `POST /fair-opens/transactions`: a transaction the wallet sent, settled against the chain and handed to the indexer,
 * so the page and every other viewer's show it at once.
 */
export async function reportFairOpenTransaction(c: Context<AppEnv>) {
  const { cfg } = c.var;
  const sent = FairOpenSent.safeParse(await c.req.json().catch(() => null));
  if (!sent.success) return refuse(c, 400, { error: "Send the transaction's signature.", code: "invalid" });
  const signature = sent.data.signature as KitSignature;
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const until = Date.now() + SETTLE_WAIT_MS;
  let outcome: FairOpenOutcome = { signature, status: "pending", error: null, explorer: explorerUrl(cfg, "tx", signature) };
  for (;;) {
    const { value: [status] } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(limited());
    if (status?.err) {
      outcome = { ...outcome, status: "failed", error: JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v)) };
      break;
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      outcome = { ...outcome, status: "landed" };
      c.executionCtx.waitUntil(indexNow(c.env, [signature]));
      break;
    }
    if (Date.now() > until) break;
    await sleep(1_000);
  }
  return c.json(outcome);
}
