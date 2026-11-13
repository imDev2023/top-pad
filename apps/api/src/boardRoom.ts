// The board's live room (spec 8, 10.2, #57): a live room like a coin's, which also keeps Trending. While anyone watches
// the board, an alarm every 15 s runs Trending's one query and pushes the result to every viewer; with nobody watching,
// the alarm stops, and `GET /board` asks the room, which works Trending out at most once every 15 s however many ask.
import type { BoardCoin } from "@top-pad/contract";
import { createDb } from "@top-pad/db";
import { trendingRows, TRENDING_EVERY_MS } from "./board";
import { config } from "./env";
import { LiveRoom } from "./rooms";

type Trending = { trending: BoardCoin[]; at: string };

export class Board extends LiveRoom {
  private latest: Trending | null = null;
  private working: Promise<Trending> | null = null;

  /** A browser joining: its WebSocket, and Trending kept fresh while anyone watches. */
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (response.status === 101 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TRENDING_EVERY_MS);
    return response;
  }

  /** Trending as last worked out, or worked out now when that was 15 s ago or more. */
  async trending(): Promise<Trending> {
    if (this.latest && Date.now() - new Date(this.latest.at).getTime() < TRENDING_EVERY_MS) return this.latest;
    return this.work();
  }

  private work(): Promise<Trending> {
    this.working ??= (async () => {
      const cfg = config(this.env);
      if (!cfg.heat) return { trending: [], at: new Date().toISOString() };
      const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const now = new Date();
        this.latest = { trending: await trendingRows(cfg, cfg.heat, db, now), at: now.toISOString() };
        return this.latest;
      } finally {
        await close();
      }
    })().finally(() => (this.working = null));
    return this.working;
  }

  /** Every 15 s while anyone watches: Trending again, pushed to every viewer. */
  async alarm(): Promise<void> {
    if (!this.ctx.getWebSockets().length) return;
    try {
      const { trending, at } = await this.work();
      await this.publish([{ type: "trending", trending, at }]);
    } catch (e) {
      console.error("working out Trending failed", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TRENDING_EVERY_MS);
    }
  }
}
