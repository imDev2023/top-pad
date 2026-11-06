// The indexer (spec 10.2) as one Durable Object, on the devnet source: a `logsSubscribe` WebSocket on Heat's configs
// (SOL's pair and every pair the band job has kept for another quote, ADR 0007), its two programs and every DAMM v2
// pool a Heat coin graduated into says which transactions to fetch and index at once, and reconciliation from each
// account's cursor catches whatever the socket missed. An alarm every 15 s keeps the object awake, reopens a dropped
// socket and reconciles every minute, or at once while the socket is down; the cron wakes it after a deploy. The
// socket is only the fast path: a trade the socket never reports is still indexed within a minute.
import { DurableObject } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import type { LiveEvent } from "@top-pad/contract";
import { createDb, graduations, indexedTransactions } from "@top-pad/db";
import {
  blockPositions,
  fetchRawTransaction,
  heatHandler,
  loadHeatConfigs,
  rpcConfigReader,
  solConfigs,
  type HeatConfigs,
  indexTransactions,
  jitoApi,
  logsSubscribeRequest,
  parseLogsMessage,
  reconcileAccount,
  refreshRadar,
  rpcFundingSource,
  rpcSource,
  type Indexed,
  type RadarSources,
  type RawTransaction,
  type TransactionHandler,
} from "@top-pad/indexer";
import { tradeView, windowClaimView } from "./coins";
import { config, type Bindings } from "./env";
import { startGraduation } from "./graduation";
import { startKeeper } from "./windowClaims";

const ALARM_MS = 15_000;
const RECONCILE_MS = 60_000;
/** How often the list of Heat's configs is read again: the band job adds a pair at most every five minutes. */
const CONFIGS_MS = 60_000;
const CONFIGS_SOON_MS = 5_000;
/** At most this many transactions per account in one reconciliation; the next alarm goes on from there. */
const RECONCILE_LIMIT = 200;
/** How long a reported transaction may take to be served by `getTransaction` before reconciliation is left to it. */
const FETCH_WAIT_MS = 8_000;
/**
 * How often to ask for it meanwhile: Helius serves a confirmed transaction about 1.5 to 2 s after its block (devnet,
 * 2026-10-29), so a steady short wait finds it as soon as it is there, where a doubling one found it up to a second late.
 */
const FETCH_EVERY_MS = 300;
/**
 * The most transactions one live Bundle Radar refresh reads of a Creator wallet's history: a fresh wallet's whole window
 * fits, and a busy one is read on by the case job, so the indexer never floods the RPC it shares with launches.
 */
const LIVE_RADAR_READS = 40;
/** How recent a launch or buy must be for the indexer to refresh Bundle Radar live; older ones are the case job's. */
const LIVE_RADAR_RECENT_MS = 10 * 60_000;

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
  /** A transaction's place in its block, its blocks cached: the handler's and Bundle Radar's. */
  private blockIndexOf: ((slot: number, signature: string) => Promise<number>) | null = null;
  /**
   * Coins whose Bundle Radar is to be brought up to date (spec 6.4), each with its earliest buy that asked, or none for a
   * launch; and the run doing it.
   */
  private radarDue = new Map<string, Date | undefined>();
  private radarRunning: Promise<void> | null = null;
  /** Where reconciliation stands on each account, read from Postgres once per instance, then kept here. */
  private cursors = new Map<string, string | null>();
  /**
   * The DAMM v2 pools Heat's coins graduated into, read from Postgres once per instance and added to as Graduations are
   * indexed: a graduated pool's swaps name neither a config nor our programs (spec 2.3).
   */
  private graduated: Set<string> | null = null;
  /** Heat's configs as last read, SOL's pair alone until the first read, and when they were read. */
  private configs: HeatConfigs | null = null;
  private configsAt = 0;

  /** The configs the handler indexes on now. */
  private heatConfigs(): HeatConfigs {
    this.configs ??= solConfigs(config(this.env).heat!);
    return this.configs;
  }

  /**
   * The accounts whose transactions are Heat's: every config (every pool, swap and migration on them), the fee program,
   * the Fair Open program (every launch, deposit, withdrawal and refund), and each graduated pool (its swaps).
   */
  private watching(): string[] {
    if (!config(this.env).heat?.configs) return [];
    return [...this.heatConfigs().addresses(), FEE_PROGRAM_ADDRESS, FAIR_OPEN_PROGRAM_ADDRESS, ...(this.graduated ?? [])];
  }

  /**
   * Reads Heat's configs again, at most every minute (or every few seconds when `soon`, for a transaction on a config
   * not yet known), and watches each new one from now on, on the open socket too.
   */
  private async loadConfigs(soon = false): Promise<HeatConfigs> {
    if (Date.now() - this.configsAt < (soon ? CONFIGS_SOON_MS : CONFIGS_MS)) return this.heatConfigs();
    const cfg = config(this.env);
    const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      const before = new Set(this.watching());
      this.configs = await loadHeatConfigs(db, cfg.heat!, rpcConfigReader(cfg.rpcUrl));
      this.configsAt = Date.now();
      const watching = this.watching();
      watching.forEach((account, i) => {
        if (!before.has(account)) this.socket?.send(logsSubscribeRequest(i + 1, account));
      });
    } finally {
      await close();
    }
    return this.heatConfigs();
  }

  private async loadGraduated() {
    if (this.graduated) return;
    const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      this.graduated = new Set((await db.select({ pool: graduations.pool }).from(graduations)).map((g) => g.pool));
    } finally {
      await close();
    }
  }

  /** A pool a coin just graduated into, watched from now on, on the open socket too. */
  private watchGraduated(pool: string) {
    this.graduated ??= new Set();
    if (this.graduated.has(pool)) return;
    this.graduated.add(pool);
    this.socket?.send(logsSubscribeRequest(this.watching().length, pool));
  }

  private positions() {
    this.blockIndexOf ??= blockPositions(config(this.env).rpcUrl);
    return this.blockIndexOf;
  }

  private handler(): TransactionHandler {
    const cfg = config(this.env);
    this.handle ??= heatHandler({
      heat: cfg.heat!,
      configs: () => this.heatConfigs(),
      refreshConfigs: () => this.loadConfigs(true),
      blockIndexOf: this.positions(),
      onIndexed: (indexed) => this.publish(indexed),
    });
    return this.handle;
  }

  /**
   * Bundle Radar's labels within seconds (spec 6.4, 10.2): when a coin launches or is bought, its Creator wallet's
   * funding window is read on from where it stood, so a wallet the creator funded is linked the moment it buys, and the
   * coin's room is told to read its labels again. Runs beside indexing, never in its way; a failure is left to the next
   * buy and to the case job, which reads the window itself.
   */
  private refreshRadarOf(asks: [mint: string, boughtAt: Date | undefined][]) {
    for (const [mint, at] of asks) {
      const due = this.radarDue.get(mint);
      this.radarDue.set(mint, !this.radarDue.has(mint) || !at || (due && at < due) ? at : due);
    }
    this.radarRunning ??= this.radarRun().finally(() => (this.radarRunning = null));
  }

  private async radarRun() {
    const cfg = config(this.env);
    const sources: RadarSources = { funding: rpcFundingSource(cfg.rpcUrl), blockIndexOf: this.positions(), jito: cfg.cluster === "mainnet" ? jitoApi() : null };
    while (this.radarDue.size) {
      const batch = [...this.radarDue];
      this.radarDue.clear();
      const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        for (const [mint, boughtAt] of batch) {
          try {
            const refreshed = await refreshRadar(db, sources, mint, { boughtAt, maxReads: LIVE_RADAR_READS, recentMs: LIVE_RADAR_RECENT_MS });
            if (refreshed) await this.send(new Map([[`coin:${mint}`, [{ type: "radar", mint }]]]));
          } catch (e) {
            this.failed(`bringing Bundle Radar up to date on ${mint}`, e);
          }
        }
      } finally {
        await close();
      }
    }
  }

  /** Sends each room its events. */
  private async send(events: Map<string, LiveEvent[]>) {
    const rooms = this.env.LIVE_ROOMS;
    if (!rooms) return;
    await Promise.all(
      [...events].map(([room, batch]) =>
        rooms
          .get(rooms.idFromName(room))
          .publish(batch)
          .catch((e) => console.error(`publishing to ${room} failed`, e)),
      ),
    );
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
      await this.loadGraduated();
    } catch (e) {
      this.failed("reading the graduated pools", e);
    }
    try {
      await this.loadConfigs();
    } catch (e) {
      this.failed("reading Heat's configs", e);
    }
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
    await this.loadConfigs().catch((e) => this.failed("reading Heat's configs", e));
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
  private async publish({ signature, pools, coins, trades, windowClaims, fairOpens, fairOpenOpens, seatEvents, fairOpenEnds, taxShares, curveCompletes, graduations: graduated }: Indexed) {
    for (const coin of coins) {
      if (coin.launchMode === "instant") await startKeeper(this.env, coin.mint).catch((e) => console.error(`starting the keeper for ${coin.mint} failed`, e));
    }
    // A curve that completed graduates through the keeper's Workflow, which leaves alone a coin that is not Heat's.
    for (const c of curveCompletes) await startGraduation(this.env, c.mint).catch((e) => console.error(`starting the Graduation of ${c.mint} failed`, e));
    for (const g of graduated) this.watchGraduated(g.pool);
    // A coin launched or bought: Bundle Radar reads on (its coin's room hears once it has).
    const radar: [string, Date | undefined][] = [...coins.map((c): [string, undefined] => [c.mint, undefined]), ...trades.filter((t) => t.side === "buy").map((t): [string, Date] => [t.mint, t.at])];
    if (radar.length) this.refreshRadarOf(radar);
    if (!this.env.LIVE_ROOMS) return;
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
    // A coin's page reads the coin again as its Graduation moves on.
    for (const c of curveCompletes) add(`coin:${c.mint}`, { type: "graduation", mint: c.mint, stage: "curve_complete" });
    for (const g of graduated) {
      const event: LiveEvent = { type: "graduation", mint: g.mint, stage: "graduated" };
      add(`coin:${g.mint}`, event);
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
    await this.send(events);
  }
}
