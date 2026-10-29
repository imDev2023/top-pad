// The launch service's Instant launch (spec 2.2, 10.2). Preparing builds the creation transaction for the creator's
// coin, signed by a fresh mint key that is then dropped (spec 10.3): only Vamp Shield's verdict and the record's Creator
// wallet stand between a creator and that transaction. Submitting takes it back signed by the Creator wallet, binds that
// wallet to the record if it is the first launch, uploads the coin's metadata, and only then adds the launch key's
// signature, last, and sends it: the launch key co-signs only launches signed by the record's Creator wallet that pass
// Vamp Shield.
import {
  createNoopSigner,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  assertIsFullySignedTransaction,
  isSolanaError,
  partiallySignTransaction,
  partiallySignTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Signature,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { instantLaunchAccounts, instantLaunchMessage } from "@top-pad/chain";
import { findCoinRecordPda } from "@top-pad/clients/fee";
import { LaunchForm, SubmitLaunch, type LaunchStatus, type PreparedLaunch } from "@top-pad/contract";
import { coins, creators, creatorWallets, launches, metadataItems, type Db } from "@top-pad/db";
import { currentCreatorWallet, sessionCreator } from "./auth";
import { instantLaunchSetup, webApp, type Config } from "./env";
import { refuse, type AppEnv } from "./http";
import { loadKeeper } from "./keeper";
import { MetadataUploadFailed, signItems, sniffImageType, storeItems, uploadItem, waitServed } from "./metadata";
import { checkText, firstRefusal } from "./vampShield";

/** How many launches a creator may have waiting to be signed at once, against a flood of prepared transactions. */
const MAX_PENDING = 10;
const PENDING_MINUTES = 10;
/** How long a submit waits for the creation transaction to confirm before answering "sending". */
const CONFIRM_WAIT_MS = 30_000;
/** How long the metadata may take to be served before the transaction goes out anyway (spec 2.1 step 10's hold). */
const SERVE_WAIT_MS = 10_000;
/** Each RPC call's limit: a provider that stalls answers the request with a 503 to retry, never a hung request. */
const RPC_TIMEOUT_MS = 15_000;
const limited = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });

type Launch = typeof launches.$inferSelect;

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
/** JSON for what an RPC returned, whose numbers Kit reads as bigints. */
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** `POST /launches`: an Instant launch's creation transaction, for the Creator wallet to sign. */
export async function prepareLaunch(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first: every launch needs one.", code: "not_linked" });
  const setup = instantLaunchSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Launching is not open here yet: ${setup.reason}`, code: "unavailable" });

  const body = await c.req.parseBody();
  const form = LaunchForm.safeParse({ mode: body.mode, name: body.name, ticker: body.ticker, wallet: body.wallet });
  if (!form.success) return refuse(c, 400, { error: "The launch form is incomplete: it needs a mode, a name, a ticker and a wallet.", code: "invalid" });
  const { wallet } = form.data;

  const verdict = await checkText(db, form.data.ticker, form.data.name);
  if (!verdict.clear) return refuse(c, 422, { error: firstRefusal(verdict), code: "vamp_shield", verdict });

  const file = body.image;
  if (!(file instanceof File) || file.size === 0) return refuse(c, 422, { error: "Add an image for your coin.", code: "image" });
  if (file.size > cfg.maxImageBytes) {
    return refuse(c, 422, { error: `The image is ${kb(file.size)}; the most a coin's image can be is ${kb(cfg.maxImageBytes)}.`, code: "image" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const imageType = sniffImageType(bytes);
  if (!imageType) return refuse(c, 422, { error: "The image must be a PNG, JPEG, GIF or WebP.", code: "image" });

  // One Creator wallet at a time (spec 7): the record's, or, before its first launch, any wallet no other record holds.
  const current = await currentCreatorWallet(db, creator.id);
  if (current && current !== wallet) {
    return refuse(c, 403, {
      error: `Your Creator wallet is ${short(current)}, the only wallet that can sign your launches. Connect it to launch.`,
      code: "not_the_creator_wallet",
    });
  }
  if (!current) {
    const [held] = await db
      .select({ creatorId: creatorWallets.creatorId })
      .from(creatorWallets)
      .where(and(eq(creatorWallets.wallet, wallet), isNull(creatorWallets.endedAt)));
    if (held && held.creatorId !== creator.id) {
      return refuse(c, 409, { error: "This wallet is another X account's Creator wallet. Connect a wallet of your own.", code: "wallet_taken" });
    }
  }

  const [{ pending } = { pending: 0 }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(launches)
    .where(and(eq(launches.creatorId, creator.id), eq(launches.status, "prepared"), gt(launches.createdAt, sql`now() - make_interval(mins => ${PENDING_MINUTES})`)));
  if (pending >= MAX_PENDING) {
    return refuse(c, 429, { error: "You have too many launches waiting to be signed. Sign one, or wait a few minutes.", code: "too_many_pending" });
  }

  const keeper = await loadKeeper(setup.keeperKey, setup.keeper);
  const mint = await generateKeyPairSigner();
  const id = crypto.randomUUID();
  const coin = { name: verdict.name, ticker: verdict.ticker, mint: mint.address, xHandle: creator.xHandle };
  const items = await signItems(keeper.secret, id, coin, { bytes, type: imageType }, { gateway: cfg.arweaveGateway, site: webApp(cfg) });

  const rpc = createSolanaRpc(cfg.rpcUrl);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(limited());
  const launch = {
    config: setup.config,
    quoteMint: setup.quoteMint,
    creator: createNoopSigner(wallet as Address),
    mint,
    launchKey: createNoopSigner(setup.keeper),
    coin: { name: coin.name, ticker: coin.ticker, uri: items.metadataUri },
    computeUnitPrice: cfg.computeUnitPrice,
  };
  const transaction = await partiallySignTransactionMessageWithSigners(await instantLaunchMessage(launch, lifetime));
  const { pool } = await instantLaunchAccounts(launch);
  const wire = getBase64EncodedWireTransaction(transaction);

  // Simulated before the creator is asked to sign: DBC and the fee program must take it, and the wallet must cover it.
  const { value: before } = await rpc.getBalance(wallet as Address, { commitment: "confirmed" }).send(limited());
  const { value: simulation } = await rpc
    .simulateTransaction(wire, { encoding: "base64", sigVerify: false, commitment: "confirmed", accounts: { addresses: [wallet as Address], encoding: "base64" } })
    .send(limited());
  if (simulation.err) {
    const logs = simulation.logs ?? [];
    const short_of_funds = simulation.err === "InsufficientFundsForFee" || logs.some((l) => /insufficient lamports|insufficient funds/i.test(l));
    console.error("launch simulation failed", json(simulation.err), logs.slice(-12));
    return refuse(c, 422, {
      error: short_of_funds
        ? "Your wallet cannot cover the launch: it pays the rent of the coin's pool and record, about 0.02 SOL, and the network fee."
        : `The launch would fail on chain: ${json(simulation.err)}.`,
      code: "simulation_failed",
    });
  }
  const after = simulation.accounts?.[0]?.lamports ?? before;
  const cost = before - BigInt(after);

  await storeItems(setup.blobs, items);
  const signatureMap = transaction.signatures as Record<string, SignatureBytes | null>;
  const mintSignature = signatureMap[mint.address];
  if (!mintSignature) throw new Error("the mint key did not sign the creation transaction");
  await db.transaction(async (tx) => {
    await tx.insert(launches).values({
      id,
      creatorId: creator.id,
      wallet,
      mode: "instant",
      name: coin.name,
      ticker: coin.ticker,
      mint: mint.address,
      pool,
      config: setup.config,
      metadataUri: items.metadataUri,
      imageUri: items.imageUri,
      message: getBase64Decoder().decode(transaction.messageBytes),
      mintSignature: getBase58Decoder().decode(mintSignature),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
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
  const prepared: PreparedLaunch = {
    id,
    mint: mint.address,
    pool,
    transaction: wire,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    cost: cost.toString(),
  };
  return c.json(prepared, 201);
}

class Refused extends Error {
  constructor(
    readonly status: 403 | 409,
    readonly code: "not_the_creator_wallet" | "wallet_taken",
    message: string,
  ) {
    super(message);
  }
}

/** `POST /launches/:id/submit`: the creation transaction signed by the Creator wallet; co-signs it and sends it. */
export async function submitLaunch(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first: every launch needs one.", code: "not_linked" });
  const launch = await ownLaunch(db, c.req.param("id")!, creator.id);
  if (!launch) return refuse(c, 404, { error: "There is no such launch of yours.", code: "not_found" });
  const rpc = createSolanaRpc(cfg.rpcUrl);
  if (launch.status !== "prepared") return c.json(await settle(db, rpc, cfg, launch));
  const setup = instantLaunchSetup(cfg, c.env);
  if (!setup.ok) return refuse(c, 503, { error: `Launching is not open here yet: ${setup.reason}`, code: "unavailable" });

  const body = SubmitLaunch.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(c, 400, { error: "Send the signed transaction.", code: "invalid" });
  let signed: Transaction;
  try {
    signed = getTransactionDecoder().decode(getBase64Encoder().encode(body.data.transaction)) as Transaction;
  } catch {
    return refuse(c, 400, { error: "That is not a transaction.", code: "invalid" });
  }
  const message = new Uint8Array(getBase64Encoder().encode(launch.message));
  if (!bytesEqual(new Uint8Array(signed.messageBytes), message)) {
    return refuse(c, 400, { error: "The signed transaction is not the one prepared for this launch.", code: "transaction_changed" });
  }
  const creatorSignature = (signed.signatures as Record<string, SignatureBytes | null>)[launch.wallet];
  if (!creatorSignature || !(await verifySignature(await getPublicKeyFromAddress(launch.wallet as Address), creatorSignature, message))) {
    return refuse(c, 400, { error: "The transaction does not carry your Creator wallet's signature.", code: "signature_invalid" });
  }
  const signature = getBase58Decoder().decode(creatorSignature);
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send(limited());
  if (height > launch.lastValidBlockHeight) {
    await db.update(launches).set({ status: "expired" }).where(and(eq(launches.id, launch.id), eq(launches.status, "prepared")));
    return refuse(c, 410, { error: "The signing window closed before the transaction came back. Prepare the launch again.", code: "expired" });
  }

  // The Creator wallet's signature proves it controls the wallet, so a record's first launch binds it, in one step with
  // claiming the launch for sending; the creator row's lock keeps two first launches from binding two wallets.
  let claimed: boolean;
  try {
    claimed = await db.transaction(async (tx) => {
      await tx.select({ id: creators.id }).from(creators).where(eq(creators.id, creator.id)).for("update");
      const current = await currentCreatorWallet(tx, creator.id);
      if (current && current !== launch.wallet) {
        throw new Refused(403, "not_the_creator_wallet", `Your Creator wallet is ${short(current)}, the only wallet that can sign your launches.`);
      }
      if (!current) {
        const taken = await tx
          .select({ id: creatorWallets.id })
          .from(creatorWallets)
          .where(and(eq(creatorWallets.wallet, launch.wallet), isNull(creatorWallets.endedAt)));
        if (taken.length > 0) throw new Refused(409, "wallet_taken", "This wallet is another X account's Creator wallet.");
        await tx.insert(creatorWallets).values({ creatorId: creator.id, wallet: launch.wallet, via: "first_launch", proof: signature });
      }
      const rows = await tx
        .update(launches)
        .set({ status: "sending", signature, submittedAt: sql`now()` })
        .where(and(eq(launches.id, launch.id), eq(launches.status, "prepared")))
        .returning({ id: launches.id });
      return rows.length > 0;
    });
  } catch (e) {
    if (e instanceof Refused) return refuse(c, e.status, { error: e.message, code: e.code });
    throw e;
  }
  if (!claimed) return c.json(await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!));

  // The metadata goes up before the coin exists, so terminals reading the new coin find it.
  try {
    const items = await db.select().from(metadataItems).where(eq(metadataItems.launchId, launch.id)).orderBy(asc(metadataItems.item));
    for (const item of items) {
      if (item.uploadedAt) continue;
      const receipt = await uploadItem(setup.blobs, cfg.turbo, item);
      await db
        .update(metadataItems)
        .set({ uploadedAt: sql`now()`, receipt })
        .where(and(eq(metadataItems.launchId, launch.id), eq(metadataItems.item, item.item)));
    }
  } catch (e) {
    if (!(e instanceof MetadataUploadFailed)) throw e;
    console.error("metadata upload failed", launch.id, e.message);
    // Back to prepared: the creator's signed transaction stays good until it expires, so they can submit it again.
    await db.update(launches).set({ status: "prepared", signature: null, submittedAt: null }).where(eq(launches.id, launch.id));
    return refuse(c, 502, { error: "The coin's image and details could not be stored on Arweave just now. Try again.", code: "metadata_upload_failed" });
  }
  if (!(await waitServed(launch.metadataUri, SERVE_WAIT_MS))) console.warn("metadata not served yet, sending anyway", launch.metadataUri);

  const keeper = await loadKeeper(setup.keeperKey, setup.keeper);
  const withMint: Transaction = {
    messageBytes: signed.messageBytes,
    signatures: { ...signed.signatures, [launch.mint]: getBase58Encoder().encode(launch.mintSignature) as SignatureBytes },
  } as Transaction;
  const full = await partiallySignTransaction([keeper.signer.keyPair], withMint);
  assertIsFullySignedTransaction(full);
  try {
    await rpc.sendTransaction(getBase64EncodedWireTransaction(full), { encoding: "base64", preflightCommitment: "confirmed" }).send(limited());
  } catch (e) {
    // A send that timed out may still have reached the network: the launch stays sending, and its signature settles it.
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
      console.warn("sending the creation transaction timed out; its signature will tell", launch.id);
    } else {
      const reason = sendError(e);
      console.error("sending the creation transaction failed", launch.id, reason);
      await db.update(launches).set({ status: "failed", error: reason }).where(eq(launches.id, launch.id));
      return refuse(c, 422, { error: `The launch failed on chain: ${reason}`, code: "send_failed" });
    }
  }

  const until = Date.now() + CONFIRM_WAIT_MS;
  let status = await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!);
  while (status.status === "sending" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1_000));
    status = await settle(db, rpc, cfg, (await ownLaunch(db, launch.id, creator.id))!);
  }
  return c.json(status);
}

/** `GET /launches/:id`: where one of the creator's launches stands, checked against the chain while it is sending. */
export async function getLaunch(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const creator = await sessionCreator(c);
  if (!creator) return refuse(c, 401, { error: "Link your X account first.", code: "not_linked" });
  const launch = await ownLaunch(db, c.req.param("id")!, creator.id);
  if (!launch) return refuse(c, 404, { error: "There is no such launch of yours.", code: "not_found" });
  return c.json(await settle(db, createSolanaRpc(cfg.rpcUrl), cfg, launch));
}

async function ownLaunch(db: Db, id: string, creatorId: string): Promise<Launch | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [launch] = await db.select().from(launches).where(and(eq(launches.id, id), eq(launches.creatorId, creatorId)));
  return launch ?? null;
}

type Rpc = ReturnType<typeof createSolanaRpc>;

/** Brings a sending launch up to date with the chain: landed, failed, or expired once its blockhash can no longer land. */
async function settle(db: Db, rpc: Rpc, cfg: Config, launch: Launch): Promise<LaunchStatus> {
  if (launch.status === "sending" && launch.signature) {
    const { value: [status] } = await rpc.getSignatureStatuses([launch.signature as Signature], { searchTransactionHistory: true }).send(limited());
    if (status?.err) {
      const error = json(status.err);
      await db.update(launches).set({ status: "failed", error }).where(eq(launches.id, launch.id));
      launch = { ...launch, status: "failed", error };
    } else if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      launch = await recordLanded(db, launch, Number(status.slot));
    } else if (!status && (await rpc.getBlockHeight({ commitment: "confirmed" }).send(limited())) > launch.lastValidBlockHeight) {
      await db.update(launches).set({ status: "expired" }).where(eq(launches.id, launch.id));
      launch = { ...launch, status: "expired" };
    }
  }
  return toStatus(cfg, launch);
}

/** A landed launch: its coin joins the list of Heat coins, mirroring the record the fee program now holds (spec 8). */
async function recordLanded(db: Db, launch: Launch, slot: number): Promise<Launch> {
  return db.transaction(async (tx) => {
    const [landed] = await tx.update(launches).set({ status: "landed", slot, landedAt: sql`now()` }).where(eq(launches.id, launch.id)).returning();
    await tx
      .insert(coins)
      .values({
        mint: launch.mint,
        pool: launch.pool,
        config: launch.config,
        launchMode: launch.mode,
        launchId: launch.id,
        creatorId: launch.creatorId,
        creatorWallet: launch.wallet,
        name: launch.name,
        ticker: launch.ticker,
        metadataUri: launch.metadataUri,
        imageUri: launch.imageUri,
        createdSignature: launch.signature!,
        createdSlot: slot,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    return landed!;
  });
}

const explorer = (cfg: Config, kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cfg.cluster === "mainnet" ? "" : `?cluster=${cfg.cluster === "localnet" ? "custom" : cfg.cluster}`}`;

async function toStatus(cfg: Config, launch: Launch): Promise<LaunchStatus> {
  const [coinRecord] = await findCoinRecordPda({ mint: launch.mint as Address });
  return {
    id: launch.id,
    status: launch.status,
    name: launch.name,
    ticker: launch.ticker,
    mint: launch.mint,
    pool: launch.pool,
    coinRecord,
    metadataUri: launch.metadataUri,
    imageUri: launch.imageUri,
    signature: launch.signature,
    error: launch.error,
    explorer: { transaction: launch.signature ? explorer(cfg, "tx", launch.signature) : null, mint: explorer(cfg, "address", launch.mint) },
  };
}

/** What a failed send says, with the program's own log lines when preflight caught it. */
function sendError(e: unknown): string {
  if (isSolanaError(e)) {
    const context = e.context as { logs?: string[] } | undefined;
    const cause = (e.cause as Error | undefined)?.message;
    const logs = context?.logs?.filter((l) => /error|failed/i.test(l)).slice(-3).join(" | ");
    return [e.message, cause, logs].filter(Boolean).join(": ");
  }
  return (e as Error).message;
}
