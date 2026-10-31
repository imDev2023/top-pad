// The launch service's Fair Open (spec 2.1 steps 2 to 8, ADR 0005). Preparing checks the coin, the schedule and the
// teaser, reserves the ticker's strict key, signs the coin's Arweave data items, has our keeper make the launch's durable
// nonce, and builds what the Creator wallet signs in one approval: the schedule, and the ladder of the coin's creation
// transactions, one per rung, on that nonce and signed by a fresh mint key that is then dropped (spec 10.3). Submitting
// takes them back signed, binds the Creator wallet as an Instant launch does, and only then adds our keeper's signatures,
// last, and sends the schedule. The schedule goes out only with every rung signed, or with the creator choosing to sign
// the rung the pot covers at the open, so no launch takes deposits without a way to open.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  createLaunchInstructions,
  dbcPoolAddress,
  fairOpenAccounts,
  fetchLookupTable,
  fetchNonceValue,
  identityHash,
  NONCE_ACCOUNT_SPACE,
  nonceAccountInstructions,
  potCapOf,
  scheduleInstructions,
  signLadder,
  WINDOW_SECONDS,
  type LookupTable,
} from "@top-pad/chain";
import { LaunchForm, SubmitLaunch, type PreparedLaunch } from "@top-pad/contract";
import { fairOpenRungs, launches, metadataItems, type Db } from "@top-pad/db";
import { foldKeys } from "@top-pad/vamp-shield";
import { sessionCreator } from "./auth";
import { fairOpenLaunchSetup, webApp, type Bindings, type Config } from "./env";
import { startFairOpenKeeper } from "./fairOpenKeeper";
import { refuse, type AppEnv } from "./http";
import { loadKeeper, type Keeper } from "./keeper";
import {
  bindCreatorWallet,
  bytesEqual,
  CONFIRM_WAIT_MS,
  json,
  launchProblem,
  limited,
  onLanded,
  ownLaunch,
  readImage,
  Refused,
  sendError,
  settle,
  type Launch,
} from "./launches";
import { signItems, storeItems } from "./metadata";
import { keeperSignatureOn, wireOf } from "./rungs";
import { sendAndConfirm } from "./send";
import { checkTeaser, checkText, firstRefusal } from "./vampShield";

/** How far ahead a window may start (spec 2.1 step 4), as `create_launch` allows it. */
export const MAX_AHEAD_SECONDS = 7 * 24 * 60 * 60;
/** How long before now a window's start may be asked for: "now", from a form filled a moment ago. */
const START_SLACK_SECONDS = 120;

type Creator = { id: string; xHandle: string };
type Form = Awaited<ReturnType<Context<AppEnv>["req"]["parseBody"]>>;
type Rpc = ReturnType<typeof createSolanaRpc>;

const base64 = getBase64Encoder();
const toBase64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const base58 = getBase58Decoder();
const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;

/** Heat's shared lookup table is frozen (spec 2.1 step 6), so each Worker reads it once. */
let tableAsked: Promise<LookupTable> | null = null;
function lookupTable(rpc: Rpc, address: Address) {
  tableAsked ??= fetchLookupTable(rpc, address);
  tableAsked.catch(() => (tableAsked = null));
  return tableAsked;
}

/** The ticker's strict key (spec 6.2): what a Fair Open reserves for its window, so no other can hold the same one. */
export const tickerKeyOf = (ticker: string) => foldKeys(ticker, "ticker").strict;

/** Whether a database error is the ticker reservation's unique index refusing a second holder. */
const reservationTaken = (e: unknown) => {
  const error = (e as { cause?: { code?: string; constraint_name?: string }; code?: string; constraint_name?: string }) ?? {};
  const pg = error.cause ?? error;
  return pg.code === "23505" && pg.constraint_name === "launches_ticker_reserved";
};

/** `POST /launches` for a Fair Open. */
export async function prepareFairOpen(c: Context<AppEnv>, creator: Creator, body: Form) {
  const { cfg, db } = c.var;
  const setup = fairOpenLaunchSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Fair Opens are not open here yet: ${setup.reason}`, code: "unavailable" });
  const form = LaunchForm.safeParse({
    mode: body.mode,
    name: body.name,
    ticker: body.ticker,
    wallet: body.wallet,
    depositsOpenAt: body.depositsOpenAt,
    minRaise: body.minRaise ?? "0",
    teaser: body.teaser ?? "",
  });
  if (!form.success || form.data.mode !== "fair_open") {
    return refuse(c, 400, { error: "The launch form is incomplete: a Fair Open needs a name, a ticker, a wallet and its window's start.", code: "invalid" });
  }
  const { wallet } = form.data;

  const verdict = await checkText(db, form.data.ticker, form.data.name);
  if (!verdict.clear) return refuse(c, 422, { error: firstRefusal(verdict), code: "vamp_shield", verdict });
  const teaser = await checkTeaser(db, form.data.teaser);
  if (!teaser.ok) return refuse(c, 422, { error: teaser.reason, code: "teaser" });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const depositsOpenAt = BigInt(form.data.depositsOpenAt);
  if (depositsOpenAt < now - BigInt(START_SLACK_SECONDS)) return refuse(c, 422, { error: "The window must start now or later.", code: "schedule" });
  if (depositsOpenAt > now + BigInt(MAX_AHEAD_SECONDS)) return refuse(c, 422, { error: "The window can start at most 7 days ahead.", code: "schedule" });
  const potCap = potCapOf(cfg.heat!.graduationTarget);
  const minRaise = BigInt(form.data.minRaise);
  if (minRaise > potCap) return refuse(c, 422, { error: `The minimum raise can be at most the pot's cap, ${sol(potCap)}.`, code: "schedule" });

  const image = await readImage(c, body);
  if ("error" in image) return refuse(c, 422, image);
  const problem = await launchProblem(db, creator.id, wallet);
  if (problem) return refuse(c, problem.status, problem.refusal);
  const tickerKey = tickerKeyOf(verdict.ticker);
  const reserved = () =>
    refuse(c, 409, {
      error: `Another Fair Open of $${verdict.ticker} is scheduled, and its ticker is reserved until it opens. Choose another ticker, or wait for it.`,
      code: "ticker_reserved",
    });
  // The creator's own draft of the same ticker, prepared and never signed, gives way to this one; its nonce goes back to
  // our keeper with housekeeping.
  await db
    .update(launches)
    .set({ status: "expired", tickerKey: null })
    .where(and(eq(launches.tickerKey, tickerKey), eq(launches.creatorId, creator.id), eq(launches.status, "prepared")));
  const [holder] = await db.select({ id: launches.id }).from(launches).where(eq(launches.tickerKey, tickerKey));
  if (holder) return reserved();

  const keeper = await loadKeeper(setup.keeperKey, setup.keeper);
  const mint = await generateKeyPairSigner();
  const nonce = await generateKeyPairSigner();
  const { launch } = await fairOpenAccounts(nonce.address);
  const id = crypto.randomUUID();
  const coin = { name: verdict.name, ticker: verdict.ticker, mint: mint.address, xHandle: creator.xHandle };
  const items = await signItems(keeper.secret, id, coin, image, { gateway: cfg.arweaveGateway, site: webApp(cfg) });
  const sealed = { name: coin.name, ticker: coin.ticker, uri: items.metadataUri };
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const [nonceRent, table, pool] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SPACE).send(limited()),
    lookupTable(rpc, setup.lookupTable),
    dbcPoolAddress(setup.config, mint.address, setup.quoteMint),
  ]);
  const terms = {
    creator: createNoopSigner(wallet as Address),
    keeper: createNoopSigner(keeper.signer.address),
    dbcConfig: setup.config,
    depositsOpenAt,
    minRaise,
    identityHash: await identityHash(sealed),
    computeUnitPrice: cfg.computeUnitPrice,
  };

  // Simulated before our keeper spends anything: the schedule in one transaction, the creator paying for a nonce made in
  // it, which costs the Creator wallet what the real schedule will, and must pass the Fair Open program.
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const trial = await createLaunchInstructions({ ...terms, nonce: createNoopSigner((await generateKeyPairSigner()).address), nonceRent });
  const { value: before } = await rpc.getBalance(wallet as Address, { commitment: "confirmed" }).send(limited());
  const { value: simulation } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(creatorMessage(wallet, lifetime, trial))), {
      encoding: "base64",
      sigVerify: false,
      commitment: "confirmed",
      accounts: { addresses: [wallet as Address], encoding: "base64" },
    })
    .send(limited());
  if (simulation.err) {
    const logs = simulation.logs ?? [];
    const shortOfFunds = simulation.err === "InsufficientFundsForFee" || logs.some((l) => /insufficient lamports|insufficient funds/i.test(l));
    console.error("schedule simulation failed", json(simulation.err), logs.slice(-12));
    return refuse(c, 422, {
      error: shortOfFunds
        ? "Your wallet cannot cover the schedule: it prepays about 0.03 SOL of rent, nearly all of it returned, and the network fee."
        : `The schedule would fail on chain: ${json(simulation.err)}.`,
      code: "simulation_failed",
    });
  }
  const cost = before - BigInt(simulation.accounts?.[0]?.lamports ?? before);

  // The reservation and the launch together: two creators racing for one ticker leave one of them refused here, before
  // our keeper makes a nonce for it.
  const schedule = compileTransaction(creatorMessage(wallet, lifetime, await scheduleInstructions({ ...terms, nonce: nonce.address, nonceRent })));
  try {
    await db.transaction(async (tx) => {
      await tx.insert(launches).values({
        id,
        creatorId: creator.id,
        wallet,
        mode: "fair_open",
        name: coin.name,
        ticker: coin.ticker,
        mint: mint.address,
        pool,
        config: setup.config,
        metadataUri: items.metadataUri,
        imageUri: items.imageUri,
        message: toBase64(new Uint8Array(schedule.messageBytes)),
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        tickerKey,
        fairOpen: launch,
        nonce: nonce.address,
        depositsOpenAt: new Date(Number(depositsOpenAt) * 1000),
        opensAt: new Date(Number(depositsOpenAt + BigInt(WINDOW_SECONDS)) * 1000),
        minRaise,
        teaser: teaser.teaser === "" ? null : teaser.teaser,
      });
      await tx.insert(metadataItems).values(
        [items.image, items.metadata].map((item) => ({
          launchId: id,
          item: item === items.image ? ("image" as const) : ("metadata" as const),
          arweaveId: item.id,
          contentType: item.contentType,
          bytes: item.bytes.byteLength,
          storageKey: item.storageKey,
        })),
      );
    });
  } catch (e) {
    if (reservationTaken(e)) return reserved();
    throw e;
  }

  // Our keeper makes the nonce now, so the creator can sign the ladder on its value in the same approval as the
  // schedule; the schedule pays the keeper back its rent.
  try {
    await makeNonce(rpc, keeper, nonce, nonceRent);
  } catch (e) {
    console.error("making the launch's nonce failed", id, e);
    await db.update(launches).set({ status: "failed", error: `the nonce: ${(e as Error).message}`, tickerKey: null }).where(eq(launches.id, id));
    return refuse(c, 503, { error: "The Solana network did not take the launch's nonce just now. Try again in a moment.", code: "unavailable" });
  }
  const ladder = await signLadder({
    launch,
    dbcConfig: setup.config,
    quoteMint: setup.quoteMint,
    creator: terms.creator,
    keeper: terms.keeper,
    mint,
    coin: sealed,
    computeUnitPrice: cfg.computeUnitPrice,
    potCap,
    nonce: nonce.address,
    nonceValue: await fetchNonceValue(rpc, nonce.address, limited()),
    table,
  });
  await storeItems(setup.blobs, items);
  await db.insert(fairOpenRungs).values(
    ladder.map((r) => {
      const signed = decode(r.transaction);
      return {
        launchId: id,
        rung: r.rung,
        message: toBase64(new Uint8Array(signed.messageBytes)),
        mintSignature: base58.decode(signed.signatures[mint.address]!),
      };
    }),
  );
  const prepared: PreparedLaunch = {
    mode: "fair_open",
    id,
    launch,
    nonce: nonce.address,
    transaction: getBase64EncodedWireTransaction(schedule),
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    rungs: ladder.map((r) => ({ rung: r.rung.toString(), transaction: r.transaction })),
    cost: cost.toString(),
    depositsOpenAt: new Date(Number(depositsOpenAt) * 1000).toISOString(),
    opensAt: new Date(Number(depositsOpenAt + BigInt(WINDOW_SECONDS)) * 1000).toISOString(),
  };
  return c.json(prepared, 201);
}

/** A message the Creator wallet pays for, on a recent blockhash. */
function creatorMessage(wallet: string, lifetime: { blockhash: string; lastValidBlockHeight: bigint }, instructions: Awaited<ReturnType<typeof scheduleInstructions>>) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(wallet as Address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** Our keeper makes a launch's durable nonce, holding its authority, and waits for it to confirm. */
async function makeNonce(rpc: Rpc, keeper: Keeper, nonce: TransactionSigner, rent: bigint) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const transaction = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(keeper.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(nonceAccountInstructions({ payer: keeper.signer, nonce, authority: keeper.signer.address, rent }), m),
    ),
  );
  await sendAndConfirm(rpc, getBase64EncodedWireTransaction(transaction), getSignatureFromTransaction(transaction));
}

const decode = (wire: string) => getTransactionDecoder().decode(base64.encode(wire)) as Transaction;

/** The launch's rungs, largest first, as prepared. */
const rungsOf = (db: Db, launchId: string) => db.select().from(fairOpenRungs).where(eq(fairOpenRungs.launchId, launchId)).orderBy(desc(fairOpenRungs.rung));

/** A signed transaction's signature by `signer` on exactly `message`, base58, or null if it carries no valid one. */
async function signatureOn(signed: Transaction, message: Uint8Array, signer: string): Promise<string | null> {
  if (!bytesEqual(new Uint8Array(signed.messageBytes), message)) return null;
  const signature = (signed.signatures as Record<string, SignatureBytes | null>)[signer];
  if (!signature || !(await verifySignature(await getPublicKeyFromAddress(signer as Address), signature, message))) return null;
  return base58.decode(signature);
}

/** `POST /launches/:id/renew`: a Fair Open's schedule again, on a fresh blockhash, when the first one expired unsigned. */
export async function renewFairOpen(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first.", code: "not_linked" });
  const row = await ownLaunch(db, c.req.param("id")!, creator.id);
  if (!row || row.mode !== "fair_open") return refuse(c, 404, { error: "There is no such Fair Open of yours.", code: "not_found" });
  if (row.status !== "prepared") return refuse(c, 409, { error: "This Fair Open has been submitted already.", code: "invalid" });
  const setup = fairOpenLaunchSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Fair Opens are not open here yet: ${setup.reason}`, code: "unavailable" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const [{ value: lifetime }, nonceRent] = await Promise.all([
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited()),
    rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SPACE).send(limited()),
  ]);
  const depositsOpenAt = BigInt(row.depositsOpenAt!.getTime() / 1000);
  const instructions = await scheduleInstructions({
    creator: createNoopSigner(row.wallet as Address),
    keeper: createNoopSigner(setup.keeper),
    dbcConfig: setup.config,
    depositsOpenAt,
    minRaise: row.minRaise!,
    identityHash: await identityHash({ name: row.name, ticker: row.ticker, uri: row.metadataUri }),
    computeUnitPrice: cfg.computeUnitPrice,
    nonce: row.nonce as Address,
    nonceRent,
  });
  const schedule = compileTransaction(creatorMessage(row.wallet, lifetime, instructions));
  await db
    .update(launches)
    .set({ message: toBase64(new Uint8Array(schedule.messageBytes)), lastValidBlockHeight: lifetime.lastValidBlockHeight })
    .where(and(eq(launches.id, row.id), eq(launches.status, "prepared")));
  const rungs = await rungsOf(db, row.id);
  const prepared: PreparedLaunch = {
    mode: "fair_open",
    id: row.id,
    launch: row.fairOpen! as Address,
    nonce: row.nonce! as Address,
    transaction: getBase64EncodedWireTransaction(schedule),
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    rungs: rungs.map((r) => ({ rung: r.rung.toString(), transaction: wireOf(r, { keeper: setup.keeper, creator: row.wallet, mint: row.mint }) })),
    cost: "0",
    depositsOpenAt: row.depositsOpenAt!.toISOString(),
    opensAt: row.opensAt!.toISOString(),
  };
  return c.json(prepared);
}

/**
 * `POST /launches/:id/submit` for a Fair Open: the schedule signed by the Creator wallet, with every rung of the ladder,
 * or none when it signs the rung the pot covers at the open instead. Our keeper co-signs them all and sends the schedule.
 */
export async function submitFairOpen(c: Context<AppEnv>, creator: Creator, launch: Launch) {
  const { cfg, db } = c.var;
  const setup = fairOpenLaunchSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Fair Opens are not open here yet: ${setup.reason}`, code: "unavailable" });
  const body = SubmitLaunch.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Send the signed schedule, and the signed ladder or null.", code: "invalid" });
  let schedule: Transaction;
  let signedRungs: Transaction[] | null;
  try {
    schedule = decode(body.data.transaction);
    signedRungs = body.data.rungs ? body.data.rungs.map(decode) : null;
  } catch {
    return refuse(c, 400, { error: "That is not a transaction.", code: "invalid" });
  }
  const message = new Uint8Array(base64.encode(launch.message));
  if (!bytesEqual(new Uint8Array(schedule.messageBytes), message)) {
    return refuse(c, 400, { error: "The signed schedule is not the one prepared for this launch.", code: "transaction_changed" });
  }
  const signature = await signatureOn(schedule, message, launch.wallet);
  if (!signature) return refuse(c, 400, { error: "The schedule does not carry your Creator wallet's signature.", code: "signature_invalid" });
  const rungs = await rungsOf(db, launch.id);
  let creatorSignatures: string[] | null = null;
  if (signedRungs) {
    if (signedRungs.length !== rungs.length) return refuse(c, 400, { error: `Sign every rung of the ladder: ${rungs.length} of them.`, code: "invalid" });
    creatorSignatures = [];
    for (const [i, rung] of rungs.entries()) {
      const signed = await signatureOn(signedRungs[i]!, new Uint8Array(base64.encode(rung.message)), launch.wallet);
      if (!signed) return refuse(c, 400, { error: `Rung ${i + 1} of the ladder is not the one prepared, or lacks your signature.`, code: "transaction_changed" });
      creatorSignatures.push(signed);
    }
  }
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send(limited());
  if (height > launch.lastValidBlockHeight) {
    // The launch stays prepared: its ladder holds, and only the schedule is renewed for the wallet to sign again.
    return refuse(c, 410, { error: "The schedule's signing window closed before it came back. Sign the renewed schedule.", code: "expired" });
  }

  const keeper = await loadKeeper(setup.keeperKey, setup.keeper);
  const keeperSignatures = creatorSignatures ? await Promise.all(rungs.map((r) => keeperSignatureOn(keeper, r.message))) : null;
  let claimed: boolean;
  try {
    claimed = await db.transaction(async (tx) => {
      await bindCreatorWallet(tx, creator.id, launch.wallet, signature);
      const rows = await tx
        .update(launches)
        .set({ status: "sending", signature, submittedAt: sql`now()`, ladder: creatorSignatures ? "signed" : "at_open" })
        .where(and(eq(launches.id, launch.id), eq(launches.status, "prepared")))
        .returning({ id: launches.id });
      if (rows.length === 0) return false;
      for (const [i, rung] of rungs.entries()) {
        if (!creatorSignatures) break;
        await tx
          .update(fairOpenRungs)
          .set({ creatorSignature: creatorSignatures[i]!, keeperSignature: keeperSignatures![i]! })
          .where(and(eq(fairOpenRungs.launchId, launch.id), eq(fairOpenRungs.rung, rung.rung)));
      }
      return true;
    });
  } catch (e) {
    if (e instanceof Refused) return refuse(c, e.status, { error: e.message, code: e.code });
    throw e;
  }
  const landed = onLanded(c);
  if (!claimed) return c.json(await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!, landed));

  const full = await partiallySignTransaction([keeper.signer.keyPair], schedule);
  try {
    await rpc.sendTransaction(getBase64EncodedWireTransaction(full), { encoding: "base64", preflightCommitment: "confirmed" }).send(limited());
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
      console.warn("sending the schedule timed out; its signature will tell", launch.id);
    } else {
      const reason = sendError(e);
      console.error("sending the schedule failed", launch.id, reason);
      await db.update(launches).set({ status: "failed", error: reason, tickerKey: null }).where(eq(launches.id, launch.id));
      return refuse(c, 422, { error: `The schedule failed on chain: ${reason}`, code: "send_failed" });
    }
  }
  const until = Date.now() + CONFIRM_WAIT_MS;
  let status = await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!, landed);
  while (status.status === "sending" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1_000));
    status = await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!, landed);
  }
  return c.json(status);
}

/** Starts the keeper's Workflow for a scheduled Fair Open, after an answer; the cron's sweep starts any it missed. */
export async function startFairOpenKeeperSafely(env: Bindings, launch: string) {
  await startFairOpenKeeper(env, launch).catch((e) => console.error("starting the Fair Open keeper failed; the cron's sweep will", launch, e));
}

export type { Config };
