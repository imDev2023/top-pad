"use client";

import { LiveBatch } from "@top-pad/contract";
import { useEffect, useRef, useState } from "react";

export type LiveState = "connecting" | "live" | "reconnecting";

/**
 * A live room's events (spec 10.2), over a WebSocket that reconnects on its own, waiting longer each time up to 15 s.
 * `onOpen` runs on every connection, so a page catches up on what it missed while it was away.
 */
export function useLiveRoom(url: string, handlers: { onBatch: (batch: LiveBatch) => void; onOpen: () => void }): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    const open = () => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempts = 0;
        setState("live");
        latest.current.onOpen();
      };
      socket.onmessage = (event) => {
        try {
          const batch = LiveBatch.safeParse(JSON.parse(String(event.data)));
          if (batch.success) latest.current.onBatch(batch.data);
        } catch {
          // Not a batch: nothing to show.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setState("reconnecting");
        retry = setTimeout(open, Math.min(1_000 * 2 ** attempts++, 15_000));
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [url]);

  return state;
}
