// The indexer (spec 10.2) as one Durable Object, on the devnet source: a `logsSubscribe` WebSocket on Heat's two
// configs and its two programs says which transactions to fetch and index at once, and reconciliation from each
// account's cursor catches whatever the socket missed. An alarm every 15 s keeps the object awake, reopens a dropped
// socket and reconciles every minute, or at once while the socket is down; the cron wakes it after a deploy. The
// socket is only the fast path: a trade the socket never reports is still indexed within a minute.
import { DurableObject } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import type { LiveEvent } from "@top-pad/contract";
import { createDb, indexedTransactions } from "@top-pad/db";
import {
  blockPositions,
  fetchRawTransaction,
  heatHandler,
  indexTransactions,
  logsSubscribeRequest,
  parseLogsMessage,
  reconcileAccount,
  rpcSource,
  type Indexed,
  type RawTransaction,
  type TransactionHandler,
} from "@top-pad/indexer";
import { tradeView, windowClaimView } from "./coins";
import { config, type Bindings } from "./env";
import { startKeeper } from "./windowClaims";

const ALARM_MS = 15_000;
const RECONCILE_MS = 60_000;
/** At most this many transactions per account in one reconciliation; the next alarm goes on from there. */
const RECONCILE_LIMIT = 200;
/** How long a reported transaction may take to be served by `getTransaction` before reconciliation is left to it. */
const FETCH_WAIT_MS = 8_000;
/**
 * How often to ask for it meanwhile: Helius serves a confirmed transaction about 1.5 to 2 s after its block (devnet,
 * 2026-10-29), so a steady short wait finds it as soon as it is there, where a doubling one found it up to a second late.
 */
const FETCH_EVERY_MS = 300;

/** `GET /indexer`. */
export type IndexerStatus = {
  /** The version of the Worker's code the indexer runs. */
  version: string | null;
  watching: string[];
  /** Whether the logs socket is open, and how many of its subscriptions the RPC accepted. */
  live: boolean;
  subscriptions: number;
  queued: number;
  reconciledAt: string | null;
  lastError: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Indexer extends DurableObject<Bindings> {
  private socket: WebSocket | null = null;
  private subscriptions = 0;
  private queue: string[] = [];
  private draining: Promise<void> | null = null;
  private reconciledAt = 0;
  private lastError: string | null = null;
  private handle: TransactionHandler | null = null;
  /** Where reconciliation stands on each account, read from Postgres once per instance, then kept here. */
  private cursors = new Map<string, string | null>();

  /**
   * The accounts whose transactions are Heat's: both configs (every pool and swap on them), the fee program, and the
   * Fair Open program (every launch, deposit, withdrawal and refund).
   */
  private watching(): string[] {
    const configs = config(this.env).heat?.configs;
    return configs ? [configs.instant, configs.fairOpen, FEE_PROGRAM_ADDRESS, FAIR_OPEN_PROGRAM_ADDRESS] : [];
  }

  private handler(): TransactionHandler {
    const cfg = config(this.env);
    this.handle ??= heatHandler({
      heat: cfg.heat!,
      blockIndexOf: blockPositions(cfg.rpcUrl),
      onIndexed: (indexed) => this.publish(indexed),
    });
    return this.handle;
  }

  /**
   * Starts the alarm loop if it is not running, and says how the indexer stands. A deploy restarts every Durable Object,
   * but one busy with its socket and its alarm, as this one always is, can go on running the code before it: on
   * 2026-10-29 it decoded none of the claims sent in the minutes after the deploy that taught it claims. So given the
   * version of the Worker that calls it, it resets itself when it runs another, and the runtime starts it again on the
   * Worker's version.
   */
  async wake(version?: string): Promise<IndexerStatus> {
    const own = this.env.CF_VERSION_METADATA?.id;
    if (version && own && version !== own) this.ctx.abort(`the indexer runs version ${own}, and the Worker calling it ${version}`);
    if (this.watching().length && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return this.status();
  }

  /** The fast path (spec 10.2): transactions the API knows have landed, indexed now; resolves once they are. */
  async indexNow(signatures: string[]): Promise<void> {
    this.queue.push(...signatures);
    this.draining ??= this.drain().finally(() => (this.draining = null));
    await this.draining;
  }

  status(): IndexerStatus {
    return {
      version: this.env.CF_VERSION_METADATA?.id ?? null,
      watching: this.watching(),
      live: this.socket !== null,
      subscriptions: this.subscriptions,
      queued: this.queue.length,
      reconciledAt: this.reconciledAt ? new Date(this.reconciledAt).toISOString() : null,
      lastError: this.lastError,
    };
  }

  async alarm(): Promise<void> {
    if (!this.watching().length) return;
    try {
      if (!this.socket) await this.openSocket();
    } catch (e) {
      this.failed("opening the logs socket", e);
    }
    try {
      if (!this.socket || this.subscriptions < this.watching().length || Date.now() - this.reconciledAt >= RECONCILE_MS) await this.reconcile();
    } catch (e) {
      this.failed("reconciling", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
  }

  private failed(what: string, e: unknown) {
    this.lastError = `${new Date().toISOString()} ${what}: ${(e as Error).message ?? String(e)}`;
    console.error(`the indexer failed ${what}`, e);
  }

  private async openSocket() {
    const res = await fetch(config(this.env).rpcUrl, { headers: { upgrade: "websocket" } });
    const socket = res.webSocket;
    if (!socket) throw new Error(`the RPC answered ${res.status} to a WebSocket upgrade`);
    socket.accept();
    const dropped = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscriptions = 0;
    };
    socket.addEventListener("message", (event) => this.message(typeof event.data === "string" ? event.data : ""));
    socket.addEventListener("close", dropped);
    socket.addEventListener("error", dropped);
    this.socket = socket;
    this.subscriptions = 0;
    this.watching().forEach((account, i) => socket.send(logsSubscribeRequest(i + 1, account)));
  }

  private message(data: string) {
    const message = parseLogsMessage(data);
    if (message.kind === "subscribed") this.subscriptions++;
    else if (message.kind === "refused") this.failed("subscribing", new Error(message.error));
    else if (message.kind === "transaction" && !message.failed) {
      this.queue.push(message.signature);
      this.draining ??= this.drain().finally(() => (this.draining = null));
    }
  }

  /** Indexes the reported transactions in turn, as each is served. */
  private async drain() {
    while (this.queue.length) {
      const batch = [...new Set(this.queue.splice(0, this.queue.length))];
      const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const known = new Set(
          (await db.select({ signature: indexedTransactions.signature }).from(indexedTransactions).where(inArray(indexedTransactions.signature, batch))).map(
            (r) => r.signature,
          ),
        );
        for (const signature of batch) {
          if (known.has(signature)) continue;
          const raw = await this.served(signature);
          if (!raw) {
            console.warn(`transaction ${signature} was not served in time; reconciliation will index it`);
            continue;
          }
          await indexTransactions(db, this.handler(), [raw]).catch((e) => this.failed(`indexing ${signature}`, e));
        }
      } catch (e) {
        this.failed("indexing reported transactions", e);
      } finally {
        await close();
      }
    }
  }

  /** A reported transaction, asked for until the RPC serves it: a node reports one before it serves it. */
  private async served(signature: string): Promise<RawTransaction | null> {
    const until = Date.now() + FETCH_WAIT_MS;
    for (;;) {
      const raw = await fetchRawTransaction(config(this.env).rpcUrl, signature).catch(() => null);
      if (raw || Date.now() >= until) return raw;
      await sleep(FETCH_EVERY_MS);
    }
  }

  /**
   * Reconciliation, asking the chain first: an account with nothing past its cursor needs no database, so a quiet Heat
   * lets the devnet database sleep (Neon scales to zero after 5 idle minutes; spec 16) rather than waking it every minute.
   */
  private async reconcile() {
    const source = rpcSource(config(this.env).rpcUrl);
    const behind: string[] = [];
    for (const account of this.watching()) {
      const cursor = this.cursors.get(account);
      const quiet = cursor !== undefined && (await source.listSignatures(account, { until: cursor ?? undefined, limit: 1 })).length === 0;
      if (!quiet) behind.push(account);
    }
    if (behind.length) {
      const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        for (const account of behind) {
          const { cursor } = await reconcileAccount(db, source, this.handler(), account, RECONCILE_LIMIT);
          this.cursors.set(account, cursor);
        }
      } finally {
        await close();
      }
    }
    this.reconciledAt = Date.now();
  }

  /**
   * Sends what a transaction added to its coins' rooms and the board's, and a Fair Open's changes to its room, and starts
   * the keeper for each Instant launch registered, which the launch's own landing may not have (a launch whose browser went away, or another deployment's).
   */
  private async publish({ signature, pools, coins, trades, windowClaims, fairOpens, fairOpenOpens, seatEvents, fairOpenEnds, taxShares }: Indexed) {
    for (const coin of coins) {
      if (coin.launchMode === "instant") await startKeeper(this.env, coin.mint).catch((e) => console.error(`starting the keeper for ${coin.mint} failed`, e));
    }
    const rooms = this.env.LIVE_ROOMS;
    if (!rooms) return;
    const events = new Map<string, LiveEvent[]>();
    const add = (room: string, event: LiveEvent) => events.set(room, [...(events.get(room) ?? []), event]);
    for (const pool of pools) {
      const event: LiveEvent = { type: "coin", mint: pool.mint, name: pool.name, ticker: pool.ticker, heat: coins.some((c) => c.mint === pool.mint) };
      add(`coin:${pool.mint}`, event);
      add("board", event);
    }
    for (const trade of trades) {
      const event: LiveEvent = { type: "trade", mint: trade.mint, trade: tradeView(trade) };
      add(`coin:${trade.mint}`, event);
      add("board", event);
    }
    const cfg = config(this.env);
    for (const claim of windowClaims) {
      const windowClaim = windowClaimView(cfg, {
        ...claim,
        windowEndedAt: new Date(Number(claim.windowEndedAt) * 1000),
        claimedAt: new Date(Number(claim.claimedAt) * 1000),
        signature,
        slot: 0,
      });
      add(`coin:${claim.mint}`, { type: "window_claim", mint: claim.mint, windowClaim });
    }
    // A Fair Open's page reads the launch again on any change, so one event per launch and kind is enough.
    const fairOpen = (launch: string, change: Extract<LiveEvent, { type: "fair_open" }>["change"]) => {
      const room = `fair-open:${launch}`;
      if (!events.get(room)?.some((e) => e.type === "fair_open" && e.change === change)) add(room, { type: "fair_open", launch, change });
    };
    for (const f of fairOpens) fairOpen(f.launch, "created");
    for (const o of fairOpenOpens) fairOpen(o.launch, "opened");
    for (const e of seatEvents) fairOpen(e.launch, e.kind);
    for (const end of fairOpenEnds) fairOpen(end.launch, end.kind);
    for (const x of taxShares) fairOpen(x.launch, "tax_share_collected");
    await Promise.all(
      [...events].map(([room, batch]) =>
        rooms
          .get(rooms.idFromName(room))
          .publish(batch)
          .catch((e) => console.error(`publishing to ${room} failed`, e)),
      ),
    );
  }
}
