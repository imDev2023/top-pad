import { address, type Address } from "@solana/kit";
import { CLUSTERS, type HeatCluster } from "@top-pad/chain";
import { Cluster } from "@top-pad/contract";
import type { Indexer } from "./indexer";
import type { LiveRoom } from "./rooms";
import type { KeeperParams } from "./windowClaims";

/** What the launch service needs from R2: the signed Arweave data items wait there until uploaded (spec 10.4). */
export type BlobStore = {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

/** A Cloudflare Secrets Store binding: the secret is read when needed, never held in a var (spec 10.3). */
export type SecretBinding = { get(): Promise<string> };

export type Bindings = {
  CLUSTER: string;
  WEB_ORIGIN: string;
  /** The API's own public origin: X sends the browser back to `<API_ORIGIN>/auth/x/callback`. */
  API_ORIGIN: string;
  HYPERDRIVE: { connectionString: string };
  /** The Solana RPC endpoint, a provider's: a secret when deployed, since the URL carries the provider's key. */
  RPC_URL?: string;
  /** The X app's OAuth 2.0 client (spec 2.1 step 1); linking X is off until both are set. */
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  /** X's endpoints, overridable so tests can stand in for X. */
  X_AUTHORIZE_URL?: string;
  X_API_URL?: string;
  /**
   * The keeper key, which is also the launch key (spec 10.3), as the 64-byte keypair array a Solana CLI file holds: a
   * Secrets Store binding when deployed, or a plain var that local development passes from ~/.config/top-pad.
   */
  KEEPER_KEY?: SecretBinding | string;
  BLOBS?: BlobStore;
  TURBO_UPLOAD_URL?: string;
  TURBO_PAYMENT_URL?: string;
  /** The Arweave gateway every coin's metadata URI names, forever. */
  ARWEAVE_GATEWAY?: string;
  /** Where operator alerts are posted, a Slack- or Discord-style webhook; alerts are only logged without one. */
  ALERT_WEBHOOK_URL?: string;
  /** Below this the keeper's SOL float raises an alert (spec 10.3). */
  KEEPER_FLOAT_MIN_LAMPORTS?: string;
  /** The priority fee launches pay, in micro-lamports per compute unit. */
  COMPUTE_UNIT_PRICE?: string;
  /** The largest coin image taken, in bytes: under Turbo's free 100 KiB per data item on devnet. */
  MAX_IMAGE_BYTES?: string;
  /** The indexer, one Durable Object (spec 10.2). */
  INDEXER?: DurableObjectNamespace<Indexer>;
  /** The live rooms, a Durable Object per coin and one for the board (spec 10.2). */
  LIVE_ROOMS?: DurableObjectNamespace<LiveRoom>;
  /** The keeper's Workflow for each Instant launch, keyed by its coin (spec 10.2): its window claim at 60 s. */
  INSTANT_LAUNCHES?: Workflow<KeeperParams>;
};

export type XConfig = { clientId: string; clientSecret: string; authorizeUrl: string; apiUrl: string; callbackUrl: string };

export type Config = {
  cluster: Cluster;
  webOrigins: string[];
  apiOrigin: string;
  /** Whether cookies need `Secure`: everywhere but plain-HTTP local development. */
  secureCookies: boolean;
  rpcUrl: string;
  /** Heat on this cluster, or null where Heat has no configs (localnet). */
  heat: HeatCluster | null;
  x: XConfig | null;
  turbo: { upload: string; payment: string };
  arweaveGateway: string;
  alertWebhookUrl: string | null;
  keeperFloatMinLamports: bigint;
  computeUnitPrice: bigint;
  maxImageBytes: number;
};


function origin(value: string, name: string) {
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, "")) throw new Error(`${name} must be an origin, such as https://example.com, not ${value}`);
  return url.origin;
}

function amount(value: string | undefined, fallback: bigint, name: string) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number, not ${value}`);
  return BigInt(value);
}

/** The Worker's settings, checked: a misconfigured deploy fails on its first request, not halfway through one. */
export function config(env: Bindings): Config {
  const cluster = Cluster.parse(env.CLUSTER);
  const apiOrigin = origin(env.API_ORIGIN, "API_ORIGIN");
  // Solana's public endpoints answer a Worker with 403, "Your IP or provider is blocked" (checked from wrangler dev on
  // 2026-10-29), so a provider's endpoint is the only one the API can use.
  const rpcUrl = env.RPC_URL || (cluster === "localnet" ? "http://127.0.0.1:8899" : null);
  if (!rpcUrl) throw new Error(`RPC_URL is required on ${cluster}: Solana's public endpoints refuse requests from Workers`);
  const x =
    env.X_CLIENT_ID && env.X_CLIENT_SECRET
      ? {
          clientId: env.X_CLIENT_ID,
          clientSecret: env.X_CLIENT_SECRET,
          authorizeUrl: env.X_AUTHORIZE_URL || "https://x.com/i/oauth2/authorize",
          apiUrl: (env.X_API_URL || "https://api.x.com").replace(/\/$/, ""),
          callbackUrl: `${apiOrigin}/auth/x/callback`,
        }
      : null;
  const maxImageBytes = Number(amount(env.MAX_IMAGE_BYTES, 98_304n, "MAX_IMAGE_BYTES"));
  return {
    cluster,
    webOrigins: env.WEB_ORIGIN.split(",").map((o) => origin(o.trim(), "WEB_ORIGIN")).filter(Boolean),
    apiOrigin,
    secureCookies: apiOrigin.startsWith("https://"),
    rpcUrl,
    heat: CLUSTERS[cluster],
    x,
    turbo: { upload: env.TURBO_UPLOAD_URL || "https://upload.ardrive.io", payment: env.TURBO_PAYMENT_URL || "https://payment.ardrive.io" },
    // Turbo's own gateway serves an upload at once, where arweave.net answers 404 until Turbo has bundled it onto Arweave
    // (still 404 three minutes after an upload on 2026-10-29; Stoker's runbook says up to an hour). The URI is in every
    // coin's immutable metadata, and the first minute of a coin's life is its sniper-tax window, when terminals read it.
    arweaveGateway: (env.ARWEAVE_GATEWAY || "https://turbo-gateway.com").replace(/\/$/, ""),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ? new URL(env.ALERT_WEBHOOK_URL).toString() : null,
    keeperFloatMinLamports: amount(env.KEEPER_FLOAT_MIN_LAMPORTS, 250_000_000n, "KEEPER_FLOAT_MIN_LAMPORTS"),
    computeUnitPrice: amount(env.COMPUTE_UNIT_PRICE, 0n, "COMPUTE_UNIT_PRICE"),
    maxImageBytes,
  };
}

/** The first web origin is the web app's own: where X linking sends the browser back to. */
export const webApp = (cfg: Config) => cfg.webOrigins[0]!;

/** What an Instant launch needs on this cluster, or why it cannot run here. */
export function instantLaunchSetup(cfg: Config, env: Bindings):
  | { ok: true; config: Address; quoteMint: Address; keeper: Address; keeperKey: SecretBinding; blobs: BlobStore }
  | { ok: false; reason: string } {
  const heat = cfg.heat;
  if (!heat?.configs || !heat.keys) return { ok: false, reason: `Heat has no launch configs on ${cfg.cluster}.` };
  const keeperKey = env.KEEPER_KEY;
  if (!keeperKey) return { ok: false, reason: "The launch key is not bound to this deployment." };
  if (!env.BLOBS) return { ok: false, reason: "The blob store is not bound to this deployment." };
  return {
    ok: true,
    config: heat.configs.instant,
    quoteMint: heat.quote.mint,
    keeper: address(heat.keys.keeper),
    keeperKey: typeof keeperKey === "string" ? { get: async () => keeperKey } : keeperKey,
    blobs: env.BLOBS,
  };
}

/** A transaction's or an address's page on Solana's explorer, on this cluster. */
export const explorerUrl = (cfg: Config, kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cfg.cluster === "mainnet" ? "" : `?cluster=${cfg.cluster === "localnet" ? "custom" : cfg.cluster}`}`;
