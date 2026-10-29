// Live rooms (spec 10.2): one Durable Object per coin and one for the board. Browsers hold hibernatable WebSockets on
// a room, so a quiet room costs nothing; the indexer publishes each decoded trade to its rooms, and a room sends what
// arrived in one message every 100 ms. A browser that reconnects catches up through the API from its last trade.
import { DurableObject } from "cloudflare:workers";
import type { LiveBatch, LiveEvent } from "@top-pad/contract";
import type { Bindings } from "./env";

const BATCH_MS = 100;

export class LiveRoom extends DurableObject<Bindings> {
  private pending: LiveEvent[] = [];
  private flushing: ReturnType<typeof setTimeout> | null = null;

  /** A browser joining: the Worker hands the room its WebSocket upgrade. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A live room speaks WebSocket.", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The indexer's new events for this room, sent on within 100 ms with whatever else arrives meanwhile. */
  async publish(events: LiveEvent[]): Promise<void> {
    this.pending.push(...events);
    this.flushing ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush() {
    this.flushing = null;
    if (!this.pending.length) return;
    const message = JSON.stringify({ events: this.pending } satisfies LiveBatch);
    this.pending = [];
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket closing as the batch goes out; its browser catches up when it reconnects.
      }
    }
  }

  /** Browsers only listen. A closing browser needs nothing: the runtime answers its Close frame (compat 2026-04-07). */
  async webSocketMessage(): Promise<void> {}
}
