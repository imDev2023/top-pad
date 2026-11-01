"use client";

import type { Coin, LiveBatch, Trade } from "@top-pad/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coinLiveUrl, getCoin, getCoinTrades } from "@/lib/api";
import { ago, coinAmount, compactNumber, shortAddress, sol, solAmount } from "@/lib/format";
import { CandleChart, type ChartFeed } from "./CandleChart";
import styles from "./Coin.module.css";
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
  // The API's clock as the page was served: the server's render and the browser's first one must say the same.
  const [now, setNow] = useState(() => Date.parse(initial.servedAt));
  const newest = useRef<string | null>(initial.market.lastTradeKey);
  const chart = useRef<ChartFeed>(null);

  const decimals = coin.decimals;
  const supply = Number(BigInt(coin.supply)) / 10 ** decimals;

  /** Trades from any source, once each, newest first; the newest moves the market. */
  const merge = useCallback(
    (incoming: Trade[], live: boolean) => {
      if (!incoming.length) return;
      setTrades((shown) => {
        const byKey = new Map((shown ?? []).map((t) => [key(t), t]));
        for (const t of incoming) byKey.set(key(t), t);
        return [...byKey.values()].sort((a, b) => (BigInt(b.orderKey) > BigInt(a.orderKey) ? 1 : -1)).slice(0, SHOWN_TRADES);
      });
      if (live) setFresh((keys) => new Set([...keys, ...incoming.map(key)]));
      const latest = incoming.reduce((a, b) => (BigInt(b.orderKey) > BigInt(a.orderKey) ? b : a));
      if (newer(latest.orderKey, newest.current)) {
        newest.current = latest.orderKey;
        setCoin((c) => ({
          ...c,
          market: {
            ...c.market,
            price: latest.price,
            marketCap: String(Number(latest.price) * supply),
            quoteReserve: latest.quoteReserve,
            lastTradeKey: latest.orderKey,
          },
        }));
      }
    },
    [supply],
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
        merge(latest, false);
      })
      .catch(() => setTrades((shown) => shown ?? []));
  }, [mint, merge]);

  const onBatch = useCallback(
    (batch: LiveBatch) => {
      const landed = batch.events.flatMap((e) => (e.type === "trade" && e.mint === mint ? [e.trade] : []));
      merge(landed, true);
      chart.current?.add(landed);
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
        merge(missed, true);
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
  const progress = Math.min(1, Number(coin.market.quoteReserve) / Number(coin.market.graduationTarget));
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
              {coin.creator.handle && <span className="chip chip-info">@{coin.creator.handle}</span>}
              <a className={`mono note ${styles.mint}`} href={coin.explorer.mint} target="_blank" rel="noreferrer" title={coin.mint}>
                {shortAddress(coin.mint)}
              </a>
            </div>
          </div>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>Price</dt>
            <dd className="num">{compactNumber(Number(coin.market.price))} SOL</dd>
          </div>
          <div>
            <dt>Market cap</dt>
            <dd className="num">{compactNumber(Number(coin.market.marketCap))} SOL</dd>
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

      <TaxBand coin={coin} now={now + offsetMs} />

      <div className={styles.layout}>
        <div className={styles.main}>
          <CandleChart mint={mint} ageSeconds={(now + offsetMs - opened) / 1000} supply={supply} ref={chart} />
          <section className={`panel ${styles.graduation}`} aria-label="Graduation">
            <div className="spread">
              <b>To Graduation</b>
              <span className="num note">
                {Number(coin.market.quoteReserve) === 0 ? "0" : solAmount(coin.market.quoteReserve, 3)} of {sol(coin.market.graduationTarget, 2)} SOL
              </span>
            </div>
            <div className={styles.gradBar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Toward Graduation">
              <div className={styles.gradTrack}>
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="checkered" title="Graduation" />
            </div>
            <p className="note">At {sol(coin.market.graduationTarget, 2)} SOL the coin moves to a Meteora pool, its liquidity locked forever.</p>
          </section>
        </div>

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
                Pool
              </a>
              {coin.heat && (
                <a href={coin.metadataUri} target="_blank" rel="noreferrer">
                  Metadata on Arweave
                </a>
              )}
            </span>
          </div>
        </aside>
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
          <TradeList trades={trades} fresh={fresh} now={now + offsetMs} taxEnds={taxEnds} decimals={decimals} explorerTx={explorerTx} />
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
