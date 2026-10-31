// Stand-ins for the services the API calls, served through a stubbed `fetch`: X's OAuth and users API, a Solana
// JSON-RPC endpoint holding whatever accounts and transactions a test gives it, Turbo and an Arweave gateway. The API's
// own code runs unchanged against them, and a test reads back what each was sent. The chain itself is tested on devnet
// (tests/devnet).
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  none,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { parseDataItem } from "@top-pad/arweave";
import { DBC_LAYOUT, DEPOSIT_STEP, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS, lowestRung, Tier } from "@top-pad/chain";
import { getVirtualPoolSize, VIRTUAL_POOL_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { getCoinRecordEncoder, LaunchMode } from "@top-pad/clients/fee";
import { getLaunchEncoder, getSeatEncoder, LaunchStatus, type LaunchArgs } from "@top-pad/clients/fair-open";
import type { RawTransaction } from "@top-pad/indexer";
import type { BlobStore, Bindings } from "../env";

export const ORIGINS = {
  web: "http://web.test",
  api: "http://api.test",
  x: "http://x.test",
  rpc: "http://rpc.test",
  turbo: "http://turbo.test",
  gateway: "http://gateway.test",
};

/** A keypair with its 64-byte secret, as a Solana CLI keypair file and the keeper's binding hold it. */
export async function testKeypair(): Promise<{ signer: KeyPairSigner; secret: Uint8Array }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(getAddressEncoder().encode(signer.address), 32);
  return { signer, secret };
}

export class MemoryBlobs implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value.slice());
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer } : null;
  }
}

export type XUser = { id: string; username: string; name: string; profile_image_url?: string };

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Everything the fakes were asked, and the knobs a test turns. */
export class Fakes {
  // X
  xUser: XUser = { id: "1001", username: "lumen_lab", name: "Lumen Lab", profile_image_url: "https://pbs.twimg.com/lumen.png" };
  tokenRequests: URLSearchParams[] = [];
  tokenAuthorizations: string[] = [];
  revoked: string[] = [];
  // Solana
  balance = 5_000_000_000n;
  /** What the simulated transaction leaves the creator holding. */
  balanceAfter = 4_982_000_000n;
  simulationError: unknown = null;
  blockHeight = 900n;
  lastValidBlockHeight = 1_000n;
  signatureStatus: "confirmed" | "none" | "failed" = "confirmed";
  /** The custom error a failed transaction's instruction returned. */
  failedWith = 6005;
  sent: Transaction[] = [];
  simulated: Transaction[] = [];
  /** Called with each transaction sent, after it is recorded, so a test can move the chain as it would land. */
  onSend: ((tx: Transaction) => void) | null = null;
  /** The chain's clock, Unix seconds, as the Clock sysvar holds it; now, unless a test sets it. */
  clock: bigint | null = null;
  /** The block time `getBlockTime` answers, Unix seconds. */
  blockTime: bigint | null = null;
  /** The chain's accounts, by address: what `getAccountInfo`, `getMultipleAccounts` and `getProgramAccounts` read. */
  accounts = new Map<string, { owner: string; data: Uint8Array; lamports?: bigint }>();
  /** Landed transactions, by signature, as `getTransaction` serves them. */
  transactions = new Map<string, RawTransaction>();
  /** Each address's transactions, newest first, as `getSignaturesForAddress` lists them. */
  history = new Map<string, string[]>();
  // Turbo and the gateway
  uploads: string[] = [];
  turboFails = false;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ORIGINS.x) return this.x(url, request);
    if (url.origin === ORIGINS.rpc) return this.rpc((await request.json()) as Json);
    if (url.origin === ORIGINS.turbo) return this.turbo(url, request);
    if (url.origin === ORIGINS.gateway) return new Response(null, { status: this.uploads.includes(url.pathname.slice(1)) ? 200 : 404 });
    throw new Error(`unexpected fetch to ${request.url}`);
  };

  private async x(url: URL, request: Request) {
    if (url.pathname === "/2/oauth2/token") {
      this.tokenRequests.push(new URLSearchParams(await request.text()));
      this.tokenAuthorizations.push(request.headers.get("authorization") ?? "");
      return json({ token_type: "bearer", access_token: "x-access-token", expires_in: 7200, scope: "tweet.read users.read" });
    }
    if (url.pathname === "/2/users/me") {
      if (request.headers.get("authorization") !== "Bearer x-access-token") return json({ title: "Unauthorized" }, 401);
      return json({ data: this.xUser });
    }
    if (url.pathname === "/2/oauth2/revoke") {
      this.revoked.push(new URLSearchParams(await request.text()).get("token") ?? "");
      return json({ revoked: true });
    }
    return json({ title: "Not Found" }, 404);
  }

  private rpc(body: Json) {
    const { id, method, params } = body as { id: number; method: string; params: unknown[] };
    const context = { slot: 123 };
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "getLatestBlockhash":
        return ok({ context, value: { blockhash: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: Number(this.lastValidBlockHeight) } });
      case "getBalance": {
        const account = this.accounts.get(params[0] as string);
        return ok({ context, value: Number(account ? (account.lamports ?? 2_000_000n) : this.balance) });
      }
      case "getBlockHeight":
        return ok(Number(this.blockHeight));
      case "getMinimumBalanceForRentExemption":
        // The rent devnet and mainnet charged on 2026-10-30: 5,080 lamports a byte, with 128 bytes for the account itself.
        return ok((Number(params[0]) + 128) * 5_080);
      case "simulateTransaction": {
        this.simulated.push(decode(params[0] as string));
        if (this.simulationError) return ok({ context, value: { err: this.simulationError, logs: ["Transfer: insufficient lamports 0, need 17000000"], accounts: null, unitsConsumed: 0, returnData: null } });
        const account = { lamports: Number(this.balanceAfter), data: ["", "base64"], owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0 };
        return ok({ context, value: { err: null, logs: [], accounts: [account], unitsConsumed: 147_000, returnData: null } });
      }
      case "sendTransaction": {
        const tx = decode(params[0] as string);
        this.sent.push(tx);
        this.makeNonces(tx);
        this.onSend?.(tx);
        return ok(getBase58Decoder().decode(Object.values(tx.signatures)[0]!));
      }
      case "getSignatureStatuses": {
        const asked = params[0] as string[];
        if (this.signatureStatus === "none") return ok({ context, value: asked.map(() => null) });
        const err = this.signatureStatus === "failed" ? { InstructionError: [2, { Custom: this.failedWith }] } : null;
        const status = { slot: 4_242, confirmations: null, err, confirmationStatus: "confirmed", status: err ? { Err: err } : { Ok: null } };
        return ok({ context, value: asked.map(() => status) });
      }
      case "getAccountInfo":
        return ok({ context, value: this.rpcAccount(params[0] as string) });
      case "getMultipleAccounts":
        return ok({ context, value: (params[0] as string[]).map((address) => this.rpcAccount(address)) });
      case "getProgramAccounts": {
        const [program, { filters = [] }] = params as [string, { filters?: Filter[] }];
        const found = [...this.accounts].filter(([, a]) => a.owner === program && filters.every((f) => passes(f, a.data)));
        return ok(found.map(([pubkey]) => ({ pubkey, account: this.rpcAccount(pubkey) })));
      }
      case "getBlockTime":
        return ok(Number(this.blockTime ?? BigInt(Math.floor(Date.now() / 1000))));
      case "getTransaction":
        return ok(this.transactions.get(params[0] as string) ?? null);
      case "getSignaturesForAddress":
        return ok(
          (this.history.get(params[0] as string) ?? []).map((signature) => ({ signature, slot: 1, err: null, memo: null, blockTime: null, confirmationStatus: "confirmed" })),
        );
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  }

  /** A sent transaction's `InitializeNonceAccount` makes its nonce account, as the System program would. */
  private makeNonces(tx: Transaction) {
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
      staticAccounts: Address[];
      instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    };
    for (const ix of message.instructions) {
      const program = message.staticAccounts[ix.programAddressIndex];
      const data = ix.data ?? new Uint8Array();
      if (program !== SYSTEM_PROGRAM || data.length < 36 || new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 6) continue;
      const nonce = message.staticAccounts[ix.accountIndices![0]!]!;
      this.accounts.set(nonce, nonceAccount(getAddressDecoder().decode(data.slice(4, 36))));
    }
  }

  private rpcAccount(address: string) {
    if (address === CLOCK_SYSVAR && !this.accounts.has(address)) {
      const data = new Uint8Array(40);
      new DataView(data.buffer).setBigInt64(32, this.clock ?? BigInt(Math.floor(Date.now() / 1000)), true);
      return { lamports: 1_169_280, data: [getBase64Decoder().decode(data), "base64"], owner: "Sysvar1111111111111111111111111111111111111", executable: false, rentEpoch: 0, space: 40 };
    }
    const account = this.accounts.get(address);
    if (!account) return null;
    return { lamports: Number(account.lamports ?? 2_000_000n), data: [getBase64Decoder().decode(account.data), "base64"], owner: account.owner, executable: false, rentEpoch: 0, space: account.data.length };
  }

  private async turbo(url: URL, request: Request) {
    if (url.pathname !== "/v1/tx/solana" || request.method !== "POST") return json({ error: "not found" }, 404);
    if (this.turboFails) return new Response("upstream unavailable", { status: 503 });
    const item = await parseDataItem(new Uint8Array(await request.arrayBuffer()));
    if (!item.valid) return new Response("invalid signature", { status: 400 });
    this.uploads.push(item.id);
    return json({ id: item.id, winc: "0", timestamp: Date.now(), version: "0.2.0", deadlineHeight: 1, owner: "keeper", dataCaches: ["arweave.net"], fastFinalityIndexes: [] });
  }
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

/** A durable nonce account, initialized, whose value only `authority` can advance. */
export function nonceAccount(authority: Address, value: Address = "6ZnF6fe4NUdVRtfjrnW38N7Lk6uTkFJBc9NjqxsN4Ffz" as Address) {
  const data = new Uint8Array(80);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 1, true);
  data.set(getAddressEncoder().encode(authority), 8);
  data.set(getAddressEncoder().encode(value), 40);
  view.setBigUint64(72, 5_000n, true);
  return { owner: SYSTEM_PROGRAM, data };
}

/** An address lookup table holding `addresses`, frozen, as the program lays one out. */
export function lookupTableAccount(addresses: Address[]) {
  const data = new Uint8Array(56 + 32 * addresses.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffffffffffffffffn, true);
  addresses.forEach((a, i) => data.set(getAddressEncoder().encode(a), 56 + 32 * i));
  return { owner: "AddressLookupTab1e1111111111111111111111111", data };
}

export const decode = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as Transaction;

type Filter = { dataSize: number } | { memcmp: { offset: number; bytes: string } };

/** Whether account data passes a `getProgramAccounts` filter, as an RPC node checks it. */
function passes(filter: Filter, data: Uint8Array) {
  if ("dataSize" in filter) return data.length === filter.dataSize;
  const bytes = getBase58Encoder().encode(filter.memcmp.bytes);
  return bytes.every((b, i) => data[filter.memcmp.offset + i] === b);
}

/** A DBC pool as DBC lays it out, with the fields Heat's claims read; every other field is zero. */
export function dbcPool(p: { config: Address; creator: Address; mint: Address; baseVault: Address; quoteVault: Address; partnerQuoteFee: bigint; activationPoint: bigint }) {
  const data = new Uint8Array(getVirtualPoolSize());
  data.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
  const put = (offset: number, address: Address) => data.set(getAddressEncoder().encode(address), offset);
  put(DBC_LAYOUT.poolConfigOffset, p.config);
  put(DBC_LAYOUT.poolCreatorOffset, p.creator);
  put(DBC_LAYOUT.poolBaseMintOffset, p.mint);
  put(168, p.baseVault);
  put(200, p.quoteVault);
  const view = new DataView(data.buffer);
  view.setBigUint64(DBC_LAYOUT.poolPartnerQuoteFeeOffset, p.partnerQuoteFee, true);
  view.setBigUint64(DBC_LAYOUT.poolActivationPointOffset, p.activationPoint, true);
  return { owner: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS as string, data };
}

/** A Heat coin's record, as the fee program's `register_coin` writes it and its window claim leaves it. */
export function coinRecord(p: { mint: Address; pool: Address; windowClaimed: boolean }) {
  const data = getCoinRecordEncoder().encode({
    mint: p.mint,
    pool: p.pool,
    launchMode: LaunchMode.Instant,
    fairOpenLaunch: none(),
    potFee: 0n,
    windowClaimed: p.windowClaimed,
    earningsRecipient: none(),
    registeredAt: 1_793_306_000n,
    bump: 254,
  });
  return { owner: FEE_PROGRAM_ADDRESS as string, data: new Uint8Array(data) };
}

/**
 * A Fair Open's launch account as the program keeps it: a window from `depositsOpenAt`, devnet's 1.7 SOL pot, and the
 * seats `asks` counts, as [deposit in steps, tier] pairs.
 */
export function fairOpenLaunch(p: {
  creator: Address;
  nonce: Address;
  depositsOpenAt: bigint;
  minRaise?: bigint;
  asks?: [number, Tier][];
  failure?: number;
  /** An opened launch: its coin and what its open recorded. */
  opened?: { mint: Address; spend: bigint; spent: bigint; coins: bigint; othersLevel: bigint; unverifiedLevel: bigint; delivered: number };
}) {
  const counts = new Array<number>(200).fill(0);
  const unverifiedCounts = new Array<number>(10).fill(0);
  const deposits = [0n, 0n, 0n];
  for (const [steps, tier] of p.asks ?? []) {
    (tier === Tier.Unverified ? unverifiedCounts : counts)[steps - 1]! += 1;
    deposits[tier]! += BigInt(steps) * DEPOSIT_STEP;
  }
  const launch: LaunchArgs = {
    creator: p.creator,
    dbcConfig: "rPqMj6mwJp9qnZBMeawF8s2iC74EkhpbUSvhWd9XTnC" as Address,
    quoteMint: "So11111111111111111111111111111111111111112" as Address,
    nonce: p.nonce,
    identityHash: new Uint8Array(32).fill(0xab),
    depositsOpenAt: p.depositsOpenAt,
    opensAt: p.depositsOpenAt + 600n,
    minRaise: p.minRaise ?? 0n,
    potCap: 1_700_000_000n,
    lowestRung: lowestRung(1_700_000_000n),
    step: DEPOSIT_STEP,
    status: p.opened ? LaunchStatus.Opened : p.failure === undefined ? LaunchStatus.Scheduled : LaunchStatus.Failed,
    failure: p.failure ?? null,
    failedAt: 0n,
    seats: (p.asks ?? []).length,
    unverifiedDeposits: deposits[0]!,
    scoredDeposits: deposits[1]!,
    verifiedDeposits: deposits[2]!,
    coinRent: BigInt((p.asks ?? []).length) * 2_039_280n,
    counts,
    unverifiedCounts,
    openRent: p.opened ? 0n : 23_517_880n,
    mint: p.opened?.mint ?? ("11111111111111111111111111111111" as Address),
    keeperLamports: 0n,
    spend: p.opened?.spend ?? 0n,
    othersLevel: p.opened?.othersLevel ?? 0n,
    unverifiedLevel: p.opened?.unverifiedLevel ?? 0n,
    spent: p.opened?.spent ?? 0n,
    coins: p.opened?.coins ?? 0n,
    refunded: 0n,
    delivered: p.opened?.delivered ?? 0,
    reserved: new Uint8Array(28),
    bump: 255,
    vaultBump: 254,
  };
  return { owner: FAIR_OPEN_PROGRAM_ADDRESS as string, data: new Uint8Array(getLaunchEncoder().encode(launch)) };
}

/** A seat as the program keeps it; a delivered one with what it bought. */
export function fairOpenSeat(p: {
  launch: Address;
  wallet: Address;
  person: Uint8Array;
  tier: Tier;
  deposit: bigint;
  delivered?: { spent: bigint; coins: bigint; refund: bigint };
}) {
  const data = getSeatEncoder().encode({
    launch: p.launch,
    wallet: p.wallet,
    person: p.person,
    tier: p.tier,
    cap: [10n, 50n, 200n][p.tier]! * DEPOSIT_STEP,
    deposit: p.deposit,
    coinRent: p.delivered ? 0n : 2_039_280n,
    spent: p.delivered?.spent ?? 0n,
    coins: p.delivered?.coins ?? 0n,
    refund: p.delivered?.refund ?? 0n,
    delivered: p.delivered !== undefined,
    reserved: new Uint8Array(23),
    bump: 253,
  });
  return { owner: FAIR_OPEN_PROGRAM_ADDRESS as string, data: new Uint8Array(data) };
}

/** The Worker's bindings for a test: devnet's configs, every outside service faked. */
export function testBindings(connectionString: string, extra: Partial<Bindings> = {}): Bindings {
  return {
    CLUSTER: "devnet",
    WEB_ORIGIN: ORIGINS.web,
    API_ORIGIN: ORIGINS.api,
    HYPERDRIVE: { connectionString },
    RPC_URL: ORIGINS.rpc,
    X_CLIENT_ID: "client-id",
    X_CLIENT_SECRET: "client-secret",
    X_AUTHORIZE_URL: `${ORIGINS.x}/i/oauth2/authorize`,
    X_API_URL: ORIGINS.x,
    TURBO_UPLOAD_URL: ORIGINS.turbo,
    TURBO_PAYMENT_URL: ORIGINS.turbo,
    ARWEAVE_GATEWAY: ORIGINS.gateway,
    ...extra,
  };
}

/** An execution context that keeps every `waitUntil` promise, so a test can wait for them. */
export function testContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(pending),
  };
}
