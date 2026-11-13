"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board, BoardCoin, CalendarEntry, LiveBatch, SearchResults } from "@top-pad/contract";
import { useLiveRoom } from "@/components/coin/useLiveRoom";
import { boardLiveUrl, getBoard, searchCoins } from "@/lib/api";
import { ago } from "@/lib/format";
import { CalendarCard } from "./CalendarCard";
import { CoinRow } from "./CoinRow";
import styles from "./Board.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A burst of live events reads the board once. */
const RELOAD_DEBOUNCE_MS = 1_500;
/** Windows begin and opens pass on the clock alone: the board reads itself again this often. */
const RELOAD_EVERY_MS = 60_000;

/** A UTC day's heading, relative to today: Today, Tomorrow, or Sat 15 Nov. */
function dayHeading(iso: string, now: number) {
  const days = Math.floor(Date.parse(iso) / DAY_MS) - Math.floor(now / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function Section({ id, title, note, count, children, aside }: { id: string; title: string; note: string; count?: number; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`} data-testid={`section-${id}`}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <h2 id={`${id}-title`}>{title}</h2>
          {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
        </div>
        <p className={styles.sectionNote}>{note}</p>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={`panel ${styles.empty}`}>{children}</div>;
}

function CoinList({ coins, now, show, ranked = false, label }: { coins: BoardCoin[]; now: number; show?: "listed" | "graduated" | "trending"; ranked?: boolean; label: string }) {
  return (
    <ol className={`panel ${styles.coinList}`} aria-label={label}>
      {coins.map((coin, i) => (
        <CoinRow key={coin.mint} coin={coin} now={now} show={show} rank={ranked ? i + 1 : undefined} />
      ))}
    </ol>
  );
}

/**
 * The Discover board (spec 8, 9 screen 1): Live now, Up next, Trending, New and Graduated, each coin row with its flags,
 * and search. Trending arrives from the board's live room every 15 s; a new coin, a Graduation or a calendar change
 * makes the board read itself again; countdowns run on the API's clock.
 */
export function DiscoverBoard({ initial }: { initial: Board | null }) {
  const [board, setBoard] = useState<Board | null>(initial);
  const [failed, setFailed] = useState(false);
  // The API's clock less the browser's, so every countdown counts by the API's clock.
  const offset = useRef(0);
  const [now, setNow] = useState(() => (initial ? Date.parse(initial.serverTime) : 0));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await getBoard();
      offset.current = Date.parse(next.serverTime) - Date.now();
      setBoard(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (initial) offset.current = Date.parse(initial.serverTime) - Date.now();
    else void reload();
    const tick = setInterval(() => setNow(Date.now() + offset.current), 1_000);
    const every = setInterval(() => void reload(), RELOAD_EVERY_MS);
    setNow(Date.now() + offset.current);
    return () => {
      clearInterval(tick);
      clearInterval(every);
    };
  }, [initial, reload]);

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = useCallback(() => {
    pending.current ??= setTimeout(() => {
      pending.current = null;
      void reload();
    }, RELOAD_DEBOUNCE_MS);
  }, [reload]);
  useEffect(() => () => clearTimeout(pending.current ?? undefined), []);

  const live = useLiveRoom(boardLiveUrl(), {
    onOpen: () => void reload(),
    onBatch: ({ events }: LiveBatch) => {
      for (const event of events) {
        if (event.type === "trending") setBoard((b) => (b ? { ...b, trending: event.trending, trendingAt: event.at } : b));
        else if ((event.type === "coin" && event.heat) || event.type === "graduation" || event.type === "calendar") reloadSoon();
      }
    },
  });

  // Search as the visitor types, a quarter second after they stop.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let stopped = false;
    const timer = setTimeout(() => {
      searchCoins(q)
        .then((r) => !stopped && setResults(r))
        .catch(() => !stopped && setResults({ query: q, coins: [] }))
        .finally(() => !stopped && setSearching(false));
    }, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Up next, by UTC day.
  const days = useMemo(() => {
    const groups: { heading: string; entries: CalendarEntry[] }[] = [];
    for (const entry of board?.upNext ?? []) {
      const heading = dayHeading(entry.opensAt, now);
      const last = groups.at(-1);
      if (last?.heading === heading) last.entries.push(entry);
      else groups.push({ heading, entries: [entry] });
    }
    // Each day's featured slots first, then the rest by their time.
    for (const g of groups) g.entries.sort((a, b) => Number(b.featured) - Number(a.featured) || a.opensAt.localeCompare(b.opensAt));
    return groups;
  }, [board?.upNext, now]);

  const liveNow = (board?.liveNow ?? []).filter((e) => Date.parse(e.opensAt) > now);

  return (
    <div className={`page ${styles.board}`}>
      <div className={styles.top}>
        <div className={styles.intro}>
          <span className="eyebrow">Discover</span>
          <h1 className={styles.title}>Everyone starts together.</h1>
          <p className={styles.lead}>Only coins Heat&apos;s launch key co-signed are listed. Fair Opens lead; Trending counts people, not volume.</p>
        </div>
        <form className={styles.search} role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="board-search" className="visually-hidden">
            Search Heat coins
          </label>
          <input
            id="board-search"
            className={`input ${styles.searchInput}`}
            type="search"
            placeholder="Search by name, ticker or mint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
          />
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </form>
      </div>

      {query.trim() && (
        <Section id="search" title="Search" note={searching && !results ? "Searching…" : `Heat coins matching “${query.trim()}”.`}>
          {results && results.coins.length > 0 ? (
            <CoinList coins={results.coins} now={now} label="Search results" />
          ) : results ? (
            <Empty>No Heat coin matches &ldquo;{results.query}&rdquo;. Only coins launched through Heat are listed.</Empty>
          ) : null}
        </Section>
      )}

      {!board ? (
        <Empty>{failed ? "The board could not be read. It tries again on its own." : "Reading the board…"}</Empty>
      ) : (
        <>
          <Section id="live" title="Live now" count={liveNow.length} note="Fair Open windows taking deposits: everyone buys at one price when the window closes.">
            {liveNow.length ? (
              <div className={styles.liveGrid}>
                {liveNow.map((entry) => (
                  <CalendarCard key={entry.launch} entry={entry} now={now} live />
                ))}
              </div>
            ) : (
              <Empty>No Fair Open is taking deposits right now.</Empty>
            )}
          </Section>

          <Section id="next" title="Up next" count={board.upNext.length} note="The sealed calendar for the next 7 days. Each coin stays a question mark until it opens.">
            {days.length ? (
              <div className={styles.days}>
                {days.map((day) => (
                  <div key={day.heading} className={styles.day}>
                    <h3 className={styles.dayHeading}>{day.heading}</h3>
                    <div className={styles.calendarGrid}>
                      {day.entries.map((entry) => (
                        <CalendarCard key={entry.launch} entry={entry} now={now} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>
                Nothing is scheduled for the next 7 days. <Link href="/launch">Schedule a Fair Open</Link>.
              </Empty>
            )}
          </Section>

          <Section
            id="trending"
            title="Trending"
            note="Unique net buyers in the last hour, the newest counting most. Creator-linked wallets and known bots never count."
            aside={
              <span className={styles.liveState} data-state={live} data-testid="trending-state">
                <span className={styles.liveDot} aria-hidden="true" />
                {live === "live" ? `Updated ${ago(now - Date.parse(board.trendingAt))} ago` : live === "connecting" ? "Connecting" : "Reconnecting"}
              </span>
            }
          >
            {board.trending.length ? <CoinList coins={board.trending} now={now} show="trending" ranked label="Trending coins" /> : <Empty>Nobody has bought a Heat coin in the last hour.</Empty>}
          </Section>

          <div className={styles.pair}>
            <Section id="new" title="New" note="Instant launches at creation, Fair Opens at their open.">
              {board.new.length ? <CoinList coins={board.new} now={now} label="New coins" /> : <Empty>No coin has launched yet.</Empty>}
            </Section>
            <Section id="graduated" title="Graduated" note="Coins whose curve filled, their liquidity locked forever.">
              {board.graduated.length ? <CoinList coins={board.graduated} now={now} show="graduated" label="Graduated coins" /> : <Empty>No coin has graduated yet.</Empty>}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
