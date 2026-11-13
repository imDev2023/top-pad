import { z } from "zod";
import { BoardCoin } from "./board";
import { Trade } from "./coin";
import { WindowClaim } from "./earnings";
import { Address } from "./launch";

/**
 * What a live room pushes (spec 10.2): its new trades, coins and window claims, a Fair Open's changes, and on the board
 * Trending and the calendar's changes, batched every 100 ms. A Fair Open's page reads the launch again on its event,
 * since the pot is the launch account's to say.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trade"), mint: Address, trade: Trade }),
  z.object({ type: z.literal("coin"), mint: Address, name: z.string(), ticker: z.string(), heat: z.boolean() }),
  z.object({ type: z.literal("window_claim"), mint: Address, windowClaim: WindowClaim }),
  /** A coin's curve completed, or the coin graduated into DAMM v2 (spec 2.3): its page reads the coin again. */
  z.object({ type: z.literal("graduation"), mint: Address, stage: z.enum(["curve_complete", "graduated"]) }),
  /** What Bundle Radar labels on a coin may have changed (spec 6.4): its page reads them again. */
  z.object({ type: z.literal("radar"), mint: Address }),
  /** The board's Trending, worked out again every 15 s by the board's Durable Object (spec 8, 10.2). */
  z.object({ type: z.literal("trending"), trending: z.array(BoardCoin), at: z.iso.datetime() }),
  /** A Fair Open joined the calendar, opened, failed or was cancelled: the board reads its calendar again. */
  z.object({ type: z.literal("calendar"), launch: Address }),
  z.object({
    type: z.literal("fair_open"),
    launch: Address,
    change: z.enum(["created", "deposit", "withdraw", "opened", "delivery", "lock", "tax_share", "tax_share_collected", "refund", "failed", "closed"]),
  }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** One message on a live room's WebSocket. */
export const LiveBatch = z.object({ events: z.array(LiveEvent) });
export type LiveBatch = z.infer<typeof LiveBatch>;
