"use client";

import type { Coin, LiveBatch, Trade } from "@top-pad/contract";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { coinLiveUrl, getCoin, getCoinTrades } from "@/lib/api";
import { ago, coinAmount, compactNumber, scaledFigure, shortAddress } from "@/lib/format";
import { CreatorSummaryCard } from "../creator/CreatorSummaryCard";
import { QuoteLabels } from "../quote/QuoteLabels";
import { CandleChart, type ChartFeed } from "./CandleChart";
import styles from "./Coin.module.css";
import { GraduationPanel } from "./GraduationPanel";
import { QuickTrade } from "./QuickTrade";
import { LooksLikeFlag, LooksLikePanel } from "../vampShield/LooksLike";
import { RadarFlags } from "./RadarFlags";
import { TaxBand } from "./TaxBand";
import { TradeList } from "./TradeList";
import { useLiveRoom } from "./useLiveRoom";

const SHOWN_TRADES = 100;
const REFRESH_MS = 30_000;
const key = (t: Trade) => `${t.signature}:${t.eventIndex}`;
const newer = (a: string, b: string | null) => b === null || BigInt(a) > BigInt(b);

/**
 * A coin's page (spec 9, screen 3): its market, the sniper tax while it runs, its chart, its way to Graduation and its
 * trades, all live. A pool on Heat's configs that our launch key never co-signed says so in red (spec 2.4).
 */
export function CoinPage({ initial }: { initial: Coin }) {
  const mint = initial.mint;
  const [coin, setCoin] = useState(initial);
  const [offsetMs, setOffsetMs] = useState(0);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // Bundle Radar's labels, read again on each change the coin's room reports.
  const [radarVersion, setRadarVersion] = useState(0);
  const [looksLikeOpen, setLooksLikeOpen] = useState(false);
  const looksLikeId = useId();
  // Trades this page sent, shown the moment they confirmed, until the indexer reports them (spec 10.2).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // The API's clock as the page was served: the server's render and the browser's first one must say the same.
  const [now, setNow] = useState(() => Date.parse(initial.servedAt));
  // The newest trade the indexer has reported: where a reconnecting page catches up from.
  const newest = useRef<string | null>(initial.market.lastTradeKey);
  const chart = useRef<ChartFeed>(null);

  const decimals = coin.decimals;
  const supply = Number(BigInt(coin.supply)) / 10 ** decimals;

  /**
   * Trades from any source, once each, newest first. A trade the page sent shows the moment it confirms, with an order
   * key at the end of its slot, and the indexer's report of it replaces it in place: one row, never two, whichever of
   * the two arrives first.
   */
  const indexed = useRef(new Set<string>());
  const merge = useCallback((all: Trade[], o: { live: boolean; provisional?: boolean }) => {
    // The indexer can report a trade before the fast path's answer reaches the page: its row stands.
    const incoming = o.provisional ? all.filter((t) => !indexed.current.has(key(t))) : all;
    if (!o.provisional) for (const t of incoming) indexed.current.add(key(t));
    if (!incoming.length) return;
    setTrades((shown) => {
      const byKey = new Map((shown ?? []).map((t) => [key(t), t]));
      for (const t of incoming) byKey.set(key(t), t);
      return [...byKey.values()].sort((a, b) => (BigInt(b.orderKey) > BigInt(a.orderKey) ? 1 : -1)).slice(0, SHOWN_TRADES);
    });
    setPending((keys) => {
      const next = new Set(keys);
      for (const t of incoming) {
        if (o.provisional) next.add(key(t));
        else next.delete(key(t));
      }
      return next.size === keys.size && [...next].every((k) => keys.has(k)) ? keys : next;
    });
    if (o.live) setFresh((keys) => new Set([...keys, ...incoming.map(key)]));
    if (!o.provisional) {
      const latest = incoming.reduce((a, b) => (BigInt(b.orderKey) > BigInt(a.orderKey) ? b : a));
      if (newer(latest.orderKey, newest.current)) newest.current = latest.orderKey;
    }
  }, []);

  // The market follows the newest trade shown, a trade the page sent included; once the indexer places that one in its
  // block, the newest is read again, so a trade later in the same slot is never shown older than it.
  const provisionalKeys = useRef(new Set<string>());
  useEffect(() => {
    const top = trades?.[0];
    if (!top) return;
    if (pending.has(key(top))) provisionalKeys.current.add(top.orderKey);
    setCoin((c) => {
      const current = c.market.lastTradeKey;
      if (current === top.orderKey) return c;
      const replaced = current !== null && provisionalKeys.current.has(current) && !trades!.some((t) => t.orderKey === current);
      if (!newer(top.orderKey, current) && !replaced) return c;
      return {
        ...c,
        market: { ...c.market, price: top.price, marketCap: String(Number(top.price) * supply), quoteReserve: top.quoteReserve, lastTradeKey: top.orderKey },
      };
    });
  }, [trades, pending, supply]);

  /** A trade this page sent, read back the moment it confirmed. */
  const onTraded = useCallback(
    (sent: Trade[]) => {
      merge(sent, { live: true, provisional: true });
      chart.current?.add(sent);
    },
    [merge],
  );

  // The coin again now and every 30 s: holders, and this browser's clock against the API's.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const asked = Date.now();
      const latest = await getCoin(mint).catch(() => null);
      if (!latest || stopped) return;
      const answered = Date.now();
      setOffsetMs(Date.parse(latest.servedAt) - (asked + answered) / 2);
      setCoin((c) => ({ ...latest, market: newer(latest.market.lastTradeKey ?? "0", c.market.lastTradeKey) ? latest.market : { ...c.market, holders: latest.market.holders } }));
    };
    void load();
    const refresh = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(refresh);
    };
  }, [mint]);

  useEffect(() => {
    getCoinTrades(mint, { limit: 50 })
      .then(({ trades: latest }) => {
        setTrades((shown) => shown ?? []);
        merge(latest, { live: false });
      })
      .catch(() => setTrades((shown) => shown ?? []));
  }, [mint, merge]);

  const onBatch = useCallback(
    (batch: LiveBatch) => {
      const landed = batch.events.flatMap((e) => (e.type === "trade" && e.mint === mint ? [e.trade] : []));
      merge(landed, { live: true });
      chart.current?.add(landed);
      if (batch.events.some((e) => e.type === "radar" && e.mint === mint)) setRadarVersion((v) => v + 1);
      // A Graduation moving on: the coin again, for its new pool and how it stands.
      if (batch.events.some((e) => e.type === "graduation" && e.mint === mint)) {
        void getCoin(mint)
          .then((latest) => setCoin((c) => ({ ...c, graduation: latest.graduation, explorer: latest.explorer })))
          .catch(() => undefined);
      }
      for (const e of batch.events) {
        if (e.type !== "window_claim" || e.mint !== mint) continue;
        setCoin((c) => ({ ...c, windowClaim: e.windowClaim }));
        // A Fair Open's window claim is its Tax Share's collection: the coin again, for what it came to.
        void getCoin(mint)
          .then((latest) => setCoin((c) => ({ ...c, fairOpen: latest.fairOpen })))
          .catch(() => undefined);
      }
    },
    [mint, merge],
  );
  // On every connection, the trades since the newest this page has: none are lost while it was away.
  const onOpen = useCallback(() => {
    const since = newest.current;
    if (since === null) return;
    getCoinTrades(mint, { after: since })
      .then(({ trades: missed }) => {
        merge(missed, { live: true });
        chart.current?.add(missed);
      })
      .catch(() => undefined);
  }, [mint, merge]);
  const live = useLiveRoom(coinLiveUrl(mint), { onBatch, onOpen });

  // The clock, from the first render on: four times a second while the sniper tax runs, so its band keeps time.
  const taxRunsUntil = Date.parse(coin.activatedAt) + coin.tax.periods * coin.tax.periodSeconds * 1000;
  useEffect(() => {
    let tick: ReturnType<typeof setTimeout>;
    const step = () => {
      setNow(Date.now());
      tick = setTimeout(step, Date.now() + offsetMs < taxRunsUntil ? 250 : 1_000);
    };
    step();
    return () => clearTimeout(tick);
  }, [offsetMs, taxRunsUntil]);

  const explorerTx = useMemo(() => {
    const cluster = new URL(coin.explorer.mint).search;
    return (signature: string) => `https://explorer.solana.com/tx/${signature}${cluster}`;
  }, [coin.explorer.mint]);
  const opened = Date.parse(coin.activatedAt);
  const taxEnds = opened + coin.tax.periods * coin.tax.periodSeconds * 1000;
  const initials = (coin.ticker || coin.name || "?").slice(0, 2).toUpperCase();

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.identity}>
          {coin.imageUri ? (
            <img src={coin.imageUri} alt="" className={styles.image} width={56} height={56} />
          ) : (
            <span className={styles.initials} aria-hidden="true">
              {initials}
            </span>
          )}
          <div className={styles.title}>
            <h1>
              {coin.name} <span className={styles.ticker}>${coin.ticker}</span>
            </h1>
            <div className="row">
              {coin.heat && <span className="chip chip-neutral">{coin.launchMode === "fair_open" ? "Fair Open" : "Instant launch"}</span>}
              {coin.graduation?.graduated && (
                <span className={`chip chip-neutral ${styles.graduatedChip}`} data-testid="coin-graduated-flag">
                  <i className="checkered" aria-hidden="true" />
                  Graduated
                </span>
              )}
              {coin.creator.handle && <span className="chip chip-info">@{coin.creator.handle}</span>}
              <LooksLikeFlag labels={coin.looksLike} open={looksLikeOpen} onToggle={() => setLooksLikeOpen((o) => !o)} controls={looksLikeId} />
              <a className={`mono note ${styles.mint}`} href={coin.explorer.mint} target="_blank" rel="noreferrer" title={coin.mint}>
                {shortAddress(coin.mint)}
              </a>
            </div>
          </div>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>Price</dt>
            <dd className="num">
              {compactNumber(scaledFigure(coin.market.price, coin.quote))} {coin.quote.symbol}
            </dd>
          </div>
          <div>
            <dt>Market cap</dt>
            <dd className="num">
              {compactNumber(scaledFigure(coin.market.marketCap, coin.quote))} {coin.quote.symbol}
            </dd>
          </div>
          <div>
            <dt>Holders</dt>
            <dd className="num">{coin.market.holders ?? "…"}</dd>
          </div>
          <div>
            <dt>Age</dt>
            <dd className="num">{ago(now + offsetMs - opened)}</dd>
          </div>
        </dl>
      </header>

      <LooksLikePanel labels={coin.looksLike} open={looksLikeOpen} id={looksLikeId} />

      {!coin.heat && (
        <div className="verdict verdict-stop" role="alert">
          <b>Not launched through Heat</b>
          <span className="note">
            This pool was created directly on Heat&apos;s config, without Heat&apos;s launch key, so none of Heat&apos;s guarantees
            cover it: no copycat check, no Creator record, no listing. The sniper tax and the fee split still bind it, because they
            live in the config.
          </span>
        </div>
      )}

      {coin.heat && <RadarFlags mint={mint} ticker={coin.ticker} decimals={decimals} quote={coin.quote} version={radarVersion} />}

      <TaxBand coin={coin} now={now + offsetMs} />

      <div className={styles.layout}>
        <div className={styles.main}>
          <CandleChart mint={mint} ageSeconds={(now + offsetMs - opened) / 1000} supply={supply} quote={coin.quote} ref={chart} />
          <GraduationPanel coin={coin} />
        </div>

        <div className={styles.side}>
          {coin.heat && (
            <div className={styles.trade}>
              <QuickTrade coin={coin} onTraded={onTraded} />
            </div>
          )}
        <aside className={`panel ${styles.facts}`} aria-label="About this coin">
          <div className={styles.fact}>
            <span className="eyebrow">Launch</span>
            {coin.heat ? (
              <span>
                {coin.fairOpen ? (
                  <a href={`/fair-open/${coin.fairOpen.launch}`}>Fair Open</a>
                ) : coin.launchMode === "fair_open" ? (
                  "Fair Open"
                ) : (
                  "Instant launch, no creator buy"
                )}
              </span>
            ) : (
              <span>Not through Heat</span>
            )}
          </div>
          {coin.fairOpen && (
            <div className={styles.fact} data-testid="coin-creator-lock">
              <span className="eyebrow">Creator lock</span>
              <CreatorLockFact lock={coin.fairOpen.lock} ticker={coin.ticker} decimals={coin.decimals} />
            </div>
          )}
          <div className={styles.fact}>
            <span className="eyebrow">Creator</span>
            <span>
              {coin.creator.handle && (
                <>
                  <a href={`https://x.com/${coin.creator.handle}`} target="_blank" rel="noreferrer">
                    @{coin.creator.handle}
                  </a>{" "}
                </>
              )}
              <span className="mono note">{shortAddress(coin.creator.wallet)}</span>
            </span>
          </div>
          <div className={styles.fact}>
            <span className="eyebrow">On chain</span>
            <span className="row">
              <a href={coin.explorer.mint} target="_blank" rel="noreferrer">
                Coin
              </a>
              <a href={coin.explorer.pool} target="_blank" rel="noreferrer">
                {coin.graduation?.graduated ? "Curve" : "Pool"}
              </a>
              {coin.graduation?.graduated && (
                <a href={coin.graduation.graduated.explorer.pool} target="_blank" rel="noreferrer">
                  DAMM v2 pool
                </a>
              )}
              {coin.heat && (
                <a href={coin.metadataUri} target="_blank" rel="noreferrer">
                  Metadata on Arweave
                </a>
              )}
            </span>
          </div>
        </aside>
          {coin.record && <CreatorSummaryCard summary={coin.record} fallbackWallet={coin.creator.wallet} />}
          <QuoteLabels quote={coin.quote} place="coin" />
        </div>
      </div>

      <section className={`panel ${styles.tradesPanel}`} aria-label="Trades">
        <div className={styles.tradesHead}>
          <h2>Trades</h2>
          <span className={`chip ${live === "live" ? "chip-go" : "chip-caution"} flag`} aria-live="polite">
            {live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
        </div>
        {trades === null ? (
          <p className={`note ${styles.empty}`}>Loading trades…</p>
        ) : (
          <TradeList
            trades={trades}
            fresh={fresh}
            pending={pending}
            now={now + offsetMs}
            taxEnds={taxEnds}
            decimals={decimals}
            quote={coin.quote}
            explorerTx={explorerTx}
          />
        )}
      </section>
    </div>
  );
}

/** The Creator lock as a fact of the coin (spec 9): what it holds and until when, with its escrow. */
function CreatorLockFact({ lock, ticker, decimals }: { lock: NonNullable<Coin["fairOpen"]>["lock"]; ticker: string; decimals: number }) {
  if (lock.status === "locked" && lock.coins && lock.cliffAt && lock.endsAt) {
    const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return (
      <span>
        <span className="num">{coinAmount(lock.coins, decimals)}</span> {ticker} locked until {day(lock.cliffAt)}, all free {day(lock.endsAt)}.{" "}
        {lock.explorer && (
          <a href={lock.explorer} target="_blank" rel="noreferrer">
            Escrow
          </a>
        )}
      </span>
    );
  }
  if (lock.status === "none") return <span>The creator bought nothing in the Fair Open, so nothing is locked.</span>;
  return <span>The creator&apos;s coins go into a Jupiter Lock escrow right after the open, released from day 7 to day 30.</span>;
}
