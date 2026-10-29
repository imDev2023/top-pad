"use client";

import type { CandleSeconds, Trade } from "@top-pad/contract";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { getCoinCandles } from "@/lib/api";
import { compactNumber, tickLabels } from "@/lib/format";
import styles from "./Coin.module.css";

/** The candle lengths a trader picks from, finest first. */
const LENGTHS: { seconds: CandleSeconds; label: string }[] = [
  { seconds: 1, label: "1s" },
  { seconds: 15, label: "15s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 900, label: "15m" },
  { seconds: 3_600, label: "1h" },
  { seconds: 14_400, label: "4h" },
  { seconds: 86_400, label: "1d" },
];

/** The length a coin's chart opens at: seconds while it is minutes old, coarser as it ages. */
export function openingLength(ageSeconds: number): CandleSeconds {
  if (ageSeconds < 5 * 60) return 1;
  if (ageSeconds < 60 * 60) return 15;
  if (ageSeconds < 24 * 60 * 60) return 60;
  return 900;
}

/** What the page hands the chart: trades as they land, folded into the newest candle as the indexer folds them. */
export type ChartFeed = { add(trades: Trade[]): void };

/** The chart's colours, read from the page's tokens, so it follows the theme. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return { bg: token("--panel"), fg: token("--muted"), line: token("--line"), go: token("--go"), stop: token("--stop"), font: token("--font-mono") };
}

/**
 * The coin's market cap in candles (TradingView Lightweight Charts v5, spec 9): the price after each trade times the
 * fixed supply, so the axis reads in SOL rather than in billionths of a lamport.
 */
export function CandleChart({
  mint,
  ageSeconds,
  supply,
  ref,
}: {
  mint: string;
  ageSeconds: number;
  /** Whole coins: the market cap is the price times this. */
  supply: number;
  ref: Ref<ChartFeed>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [seconds, setSeconds] = useState<CandleSeconds>(() => openingLength(ageSeconds));
  const [state, setState] = useState<"loading" | "empty" | "ready" | "failed">("loading");
  const [reloads, setReloads] = useState(0);
  const newest = useRef<CandlestickData<UTCTimestamp> | null>(null);

  useEffect(() => {
    const colors = palette();
    const created = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.fg, fontFamily: colors.font, fontSize: 11 },
      grid: { vertLines: { color: colors.line }, horzLines: { color: colors.line } },
      // No label cut in half at the scale's edge.
      rightPriceScale: { borderColor: colors.line, entireTextOnly: true, scaleMargins: { top: 0.12, bottom: 0.08 } },
      // A steady bar width, the newest bar at the right with a few bars of room, so its time label is never cut.
      timeScale: { borderColor: colors.line, timeVisible: true, secondsVisible: true, rightOffset: 4, barSpacing: 10 },
    });
    const candles = created.addSeries(CandlestickSeries, {
      upColor: colors.go,
      downColor: colors.stop,
      wickUpColor: colors.go,
      wickDownColor: colors.stop,
      borderVisible: false,
      priceFormat: { type: "custom", formatter: (value: number) => compactNumber(value, 6), tickmarksFormatter: tickLabels, minMove: 1e-9 },
    });
    chart.current = created;
    series.current = candles;

    // The theme: the header's toggle sets data-theme, and the system's choice applies until it does.
    const repaint = () => {
      const c = palette();
      created.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.fg },
        grid: { vertLines: { color: c.line }, horzLines: { color: c.line } },
        rightPriceScale: { borderColor: c.line },
        timeScale: { borderColor: c.line },
      });
      candles.applyOptions({ upColor: c.go, downColor: c.stop, wickUpColor: c.go, wickDownColor: c.stop });
    };
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const system = window.matchMedia("(prefers-color-scheme: light)");
    system.addEventListener("change", repaint);
    return () => {
      observer.disconnect();
      system.removeEventListener("change", repaint);
      created.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setState("loading");
    getCoinCandles(mint, seconds)
      .then(({ candles }) => {
        if (!current || !series.current) return;
        const bars = candles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: Number(c.open) * supply,
          high: Number(c.high) * supply,
          low: Number(c.low) * supply,
          close: Number(c.close) * supply,
        }));
        series.current.setData(bars);
        newest.current = bars.at(-1) ?? null;
        chart.current?.timeScale().scrollToRealTime();
        setState(bars.length ? "ready" : "empty");
      })
      .catch(() => current && setState("failed"));
    return () => {
      current = false;
    };
  }, [mint, seconds, supply, reloads]);

  useImperativeHandle(ref, () => ({
    add(trades) {
      for (const trade of trades) {
        if (!series.current) return;
        const last = newest.current;
        // The coin's first candle opens at the curve's start, which the API knows: load the candles afresh.
        if (!last) {
          setReloads((n) => n + 1);
          return;
        }
        const value = Number(trade.price) * supply;
        const time = (Math.floor(Date.parse(trade.at) / 1000 / seconds) * seconds) as UTCTimestamp;
        // A trade older than the newest candle comes in late; the next load places it.
        if (time < last.time) continue;
        // A new candle opens where the last one closed, as the API's do.
        const bar =
          time === last.time
            ? { ...last, high: Math.max(last.high, value), low: Math.min(last.low, value), close: value }
            : { time, open: last.close, high: Math.max(last.close, value), low: Math.min(last.close, value), close: value };
        series.current.update(bar);
        newest.current = bar;
        setState("ready");
      }
    },
  }));

  return (
    <section className={`panel ${styles.chartPanel}`} aria-label="Chart">
      <div className={styles.chartHead}>
        <span className="eyebrow">Market cap, SOL</span>
        <div className={styles.lengths} role="group" aria-label="Candle length">
          {LENGTHS.map((l) => (
            <button key={l.seconds} type="button" className={styles.length} aria-pressed={l.seconds === seconds} onClick={() => setSeconds(l.seconds)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chartBox}>
        <div ref={box} className={styles.chart} />
        {state !== "ready" && (
          <p className={`note ${styles.chartNote}`}>
            {state === "loading"
              ? "Loading the chart…"
              : state === "failed"
                ? "The chart could not be loaded just now."
                : "No trades yet: the chart starts with the first one."}
          </p>
        )}
      </div>
    </section>
  );
}
