"use client";

import type { BundleRadar, QuoteInfo, RadarBuy, RadarTransfer, RadarWallet } from "@top-pad/contract";
import { useEffect, useId, useState } from "react";
import { getCoinRadar } from "@/lib/api";
import { coinAmount, ordinal, quoteSmall, quoteText, shareOf, shortAddress, sol, span } from "@/lib/format";
import styles from "./Radar.module.css";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Flag = "linked" | "early";

/**
 * Bundle Radar's flags on a coin (spec 6.4, 9): red for wallets directly linked to the Creator wallet that bought, yellow
 * for buys in the creation slot with no such link, each flag opening its evidence, every transaction linked. They are
 * labels, Heat's judgement with the evidence shown, and never move a coin in Heat's listings (spec 8). Read again
 * whenever the coin's room says its labels may have changed.
 */
export function RadarFlags({ mint, ticker, decimals, quote, version }: { mint: string; ticker: string; decimals: number; quote: QuoteInfo; version: number }) {
  const [radar, setRadar] = useState<BundleRadar | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Flag | null>(null);
  const detailId = useId();

  useEffect(() => {
    let stopped = false;
    // A burst of buys asks once.
    const timer = setTimeout(
      () =>
        getCoinRadar(mint)
          .then((r) => {
            if (stopped) return;
            setRadar(r);
            setFailed(false);
          })
          .catch(() => !stopped && setFailed(true)),
      version ? 300 : 0,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [mint, version]);

  const linked = radar?.wallets.filter((w) => w.linked) ?? [];
  const early = radar?.wallets.filter((w) => !w.linked) ?? [];
  const earlyBuys = early.reduce((n, w) => n + w.buys.filter((b) => b.labels.includes("same_slot")).length, 0);
  const shown = open === "linked" && linked.length ? "linked" : open === "early" && early.length ? "early" : null;
  const toggle = (flag: Flag) => setOpen((o) => (o === flag ? null : flag));

  return (
    <section className={styles.radar} aria-label="Bundle Radar" data-testid="radar">
      <div className={styles.strip}>
        <span className="eyebrow">Bundle Radar</span>
        {!radar ? (
          <span className={`chip chip-neutral ${styles.flagChip}`}>{failed ? "Labels unavailable" : "Reading the chain…"}</span>
        ) : !linked.length && !early.length ? (
          <span className={`chip chip-neutral ${styles.flagChip}`} data-testid="radar-clear">
            Nothing labelled
          </span>
        ) : null}
        {linked.length > 0 && (
          <button
            type="button"
            className={`chip chip-stop flag ${styles.flagChip} ${styles.flagButton}`}
            aria-expanded={shown === "linked"}
            aria-controls={detailId}
            onClick={() => toggle("linked")}
            data-testid="radar-linked"
          >
            <span>
              {plural(linked.length, "wallet", "wallets")} linked to the creator{" "}
              <span className={styles.flagFigure}>· {shareOf(radar!.linked.coins, radar!.supply)} of supply</span>
            </span>
            <i className={styles.caret} aria-hidden="true" />
          </button>
        )}
        {early.length > 0 && (
          <button
            type="button"
            className={`chip chip-caution flag ${styles.flagChip} ${styles.flagButton}`}
            aria-expanded={shown === "early"}
            aria-controls={detailId}
            onClick={() => toggle("early")}
            data-testid="radar-same-slot"
          >
            <span>{plural(earlyBuys, "same-slot buy", "same-slot buys")}</span>
            <i className={styles.caret} aria-hidden="true" />
          </button>
        )}
      </div>

      <div id={detailId} hidden={!shown}>
        {shown === "linked" && radar && (
          <div className={`panel ${styles.detail} ${styles.detailStop}`} data-testid="radar-linked-detail">
            <div className={styles.detailHead}>
              <h2>Linked to the Creator wallet</h2>
              <a className="mono note" href={radar.creatorExplorer} target="_blank" rel="noreferrer" title={radar.creatorWallet}>
                {shortAddress(radar.creatorWallet)}
              </a>
            </div>
            <p className={styles.lead}>
              Each wallet here has a direct link to the Creator wallet: funds passed between them in the 7 days before the open or
              after it, the Creator wallet signed or paid for its buy, or its buy was one of the four transactions right after the
              coin&apos;s creation. Between them they bought <b>{shareOf(radar.linked.coins, radar.supply)}</b> of supply in the
              first hour{radar.wallets.some((w) => w.linked && BigInt(w.potCoins) > 0n) ? " and the pot" : ""}.
            </p>
            <ul className={styles.wallets}>
              {linked.map((w) => (
                <WalletRow key={w.wallet} wallet={w} radar={radar} ticker={ticker} decimals={decimals} quote={quote} />
              ))}
            </ul>
            <p className="note">Labels are Heat&apos;s judgement, with the evidence linked. They never move a coin in Heat&apos;s listings.</p>
          </div>
        )}
        {shown === "early" && radar && (
          <div className={`panel ${styles.detail} ${styles.detailCaution}`} data-testid="radar-same-slot-detail">
            <div className={styles.detailHead}>
              <h2>Bought in the creation slot</h2>
              <a className="mono note" href={radar.creation.explorer} target="_blank" rel="noreferrer">
                Slot {radar.creation.slot.toLocaleString("en-US")}
              </a>
            </div>
            <p className={styles.lead}>
              These buys landed in the same slot as the coin&apos;s creation, paying the 99% sniper tax. Buying early is no link to the
              creator on its own, so this is a label only.
            </p>
            <ul className={styles.wallets}>
              {early.map((w) => (
                <WalletRow key={w.wallet} wallet={w} radar={radar} ticker={ticker} decimals={decimals} quote={quote} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** One wallet and the evidence behind its labels, every transaction linked. */
function WalletRow({ wallet: w, radar, ticker, decimals, quote }: { wallet: RadarWallet; radar: BundleRadar; ticker: string; decimals: number; quote: QuoteInfo }) {
  const opened = Date.parse(radar.openedAt);
  const when = (iso: string) => {
    const seconds = (Date.parse(iso) - opened) / 1000;
    if (seconds < 0) return `${span(-seconds)} before the open`;
    // The chain's clock counts whole seconds: a buy in the open's own second says so rather than "0 s after".
    return seconds < 1 ? "in the open's first second" : `${span(seconds)} after the open`;
  };
  const asset = (t: RadarTransfer) =>
    t.asset === "SOL" || t.asset === WRAPPED_SOL
      ? `${sol(t.amount)} SOL`
      : t.asset === radar.mint
        ? `${coinAmount(t.amount, decimals)} ${ticker}`
        : t.asset === quote.mint
          ? quoteText(t.amount, quote)
          : `${t.amount} units of ${shortAddress(t.asset)}`;
  const buyLine = (b: RadarBuy) => {
    const fee = Number(b.fee) / Number(b.quoteAmount);
    const where = [
      b.labels.includes("same_slot") ? "in the creation slot" : when(b.at),
      b.labels.includes("after_creation") && b.position ? `${ordinal(b.position)} after the creation` : null,
      b.labels.includes("jito_bundle") ? "in the creation's Jito bundle" : null,
      b.labels.includes("creator_signed") ? "signed or paid for by the Creator wallet" : null,
    ].filter(Boolean);
    return (
      <>
        Bought <span className="num">{coinAmount(b.baseAmount, decimals)}</span> {ticker} for <span className="num">{quoteSmall(b.quoteAmount, quote)}</span> {quote.symbol},{" "}
        {where.join(", ")}; fee <span className="num">{(fee * 100).toFixed(fee >= 0.1 ? 0 : 2)}%</span>
      </>
    );
  };
  return (
    <li className={styles.wallet} data-testid="radar-wallet">
      <div className={styles.walletHead}>
        <span className="row">
          <a className="mono" href={w.explorer} target="_blank" rel="noreferrer" title={w.wallet}>
            {shortAddress(w.wallet)}
          </a>
          {w.creator && <span className="chip chip-neutral">Creator wallet</span>}
        </span>
        {w.linked && (
          <span className="note">
            <span className="num">{shareOf(w.counted, radar.supply)}</span> of supply counted
          </span>
        )}
      </div>
      <ul className={styles.evidence}>
        {w.transfers.map((t) => (
          <li key={`${t.signature}:${t.direction}:${t.amount}`}>
            <span>
              {t.direction === "from_creator" ? "Got" : "Sent"} {asset(t)} {t.direction === "from_creator" ? "from" : "to"} the Creator wallet, {when(t.at)}
            </span>
            <a href={t.explorer} target="_blank" rel="noreferrer">
              Transfer
            </a>
          </li>
        ))}
        {w.deposits.map((d) => (
          <li key={d.signature}>
            <span>
              Deposited <span className="num">{quoteText(d.amount, quote)}</span> in the pot{d.creatorSigned ? ", signed or paid for by the Creator wallet" : ""}
              {BigInt(w.potCoins) > 0n ? `; its seat bought ${coinAmount(w.potCoins, decimals)} ${ticker}` : ""}
            </span>
            <a href={d.explorer} target="_blank" rel="noreferrer">
              Deposit
            </a>
          </li>
        ))}
        {w.buys.map((b) => (
          <li key={`${b.signature}:${b.eventIndex}`}>
            <span>{buyLine(b)}</span>
            <a href={b.explorer} target="_blank" rel="noreferrer">
              Buy
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
}
