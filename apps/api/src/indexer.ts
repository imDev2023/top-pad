// The indexer (spec 10.2) as one Durable Object, on the devnet source: a `logsSubscribe` WebSocket on Heat's two
// configs and the fee program says which transactions to fetch and index at once, and reconciliation from each
// account's cursor catches whatever the socket missed. An alarm every 15 s keeps the object awake, reopens a dropped
// socket and reconciles every minute, or at once while the socket is down; the cron wakes it after a deploy. The
// socket is only the fast path: a trade the socket never reports is still indexed within a minute.
import { DurableObject } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
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
import { tradeView } from "./coins";
import { config, type Bindings } from "./env";

const ALARM_MS = 15_000;
const RECONCILE_MS = 60_000;
/** At most this many transactions per account in one reconciliation; the next alarm goes on from there. */
const RECONCILE_LIMIT = 200;
/** How long a reported transaction may take to be served by `getTransaction` before reconciliation is left to it. */
const FETCH_WAIT_MS = 8_000;

/** `GET /indexer`. */
export type IndexerStatus = {
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

  /** The accounts whose transactions are Heat's: both configs (every pool and swap on them) and the fee program. */
  private watching(): string[] {
    const configs = config(this.env).heat?.configs;
    return configs ? [configs.instant, configs.fairOpen, FEE_PROGRAM_ADDRESS] : [];
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

  /** Starts the alarm loop if it is not running, and says how the indexer stands. */
  async wake(): Promise<IndexerStatus> {
    if (this.watching().length && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return this.status();
  }

  status(): IndexerStatus {
    return {
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

  /** A reported transaction, asked for until the RPC serves it: a node can report one a moment before it serves it. */
  private async served(signature: string): Promise<RawTransaction | null> {
    const until = Date.now() + FETCH_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      const raw = await fetchRawTransaction(config(this.env).rpcUrl, signature).catch(() => null);
      if (raw || Date.now() >= until) return raw;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }

  private async reconcile() {
    const cfg = config(this.env);
    const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      const source = rpcSource(cfg.rpcUrl);
      for (const account of this.watching()) await reconcileAccount(db, source, this.handler(), account, RECONCILE_LIMIT);
      this.reconciledAt = Date.now();
    } finally {
      await close();
    }
  }

  /** Sends what a transaction added to its coins' rooms and the board's. */
  private async publish({ pools, coins, trades }: Indexed) {
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
