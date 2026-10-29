// Stand-ins for the services the launch service calls, served through a stubbed `fetch`: X's OAuth and users API,
// a Solana JSON-RPC endpoint, Turbo and an Arweave gateway. The API's own code runs unchanged against them, and a test
// reads back what each was sent. The chain itself is tested on devnet (tests/devnet).
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { parseDataItem } from "@top-pad/arweave";
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
  sent: Transaction[] = [];
  simulated: Transaction[] = [];
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
      case "getBalance":
        return ok({ context, value: Number(this.balance) });
      case "getBlockHeight":
        return ok(Number(this.blockHeight));
      case "simulateTransaction": {
        this.simulated.push(decode(params[0] as string));
        if (this.simulationError) return ok({ context, value: { err: this.simulationError, logs: ["Transfer: insufficient lamports 0, need 17000000"], accounts: null, unitsConsumed: 0, returnData: null } });
        const account = { lamports: Number(this.balanceAfter), data: ["", "base64"], owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, space: 0 };
        return ok({ context, value: { err: null, logs: [], accounts: [account], unitsConsumed: 147_000, returnData: null } });
      }
      case "sendTransaction": {
        const tx = decode(params[0] as string);
        this.sent.push(tx);
        return ok(getBase58Decoder().decode(Object.values(tx.signatures)[0]!));
      }
      case "getSignatureStatuses": {
        if (this.signatureStatus === "none") return ok({ context, value: [null] });
        const err = this.signatureStatus === "failed" ? { InstructionError: [2, { Custom: 6005 }] } : null;
        return ok({ context, value: [{ slot: 4_242, confirmations: null, err, confirmationStatus: "confirmed", status: err ? { Err: err } : { Ok: null } }] });
      }
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
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

export const decode = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as Transaction;

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
