"use client";

import { countsInOrder, type FairnessCard, type FairnessFlag, type FairnessRow, type QuoteInfo } from "@top-pad/contract";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { getFairness } from "@/lib/api";
import styles from "./Flags.module.css";
import { RadarEvidence, RadarFlagButtons, shownRadarFlag, useRadar, type RadarFlag } from "./Radar";

/** How often the card is read again with nothing reported: the creator's holdings move without an event of the coin's. */
const REFRESH_MS = 60_000;

const CHIP: Record<FairnessFlag, string> = { green: "chip-go", checkered: "chip-neutral", yellow: "chip-caution", red: "chip-stop", neutral: "chip-neutral" };
const COUNT_CHIP = { green: "chip-go", yellow: "chip-caution", red: "chip-stop" } as const;

type Open = { row: FairnessRow["key"] } | { radar: RadarFlag } | "card" | null;

/** A row's flag as a mark: the marshal's flag in its colour, or the checkered one at Graduation. */
function FlagMark({ flag }: { flag: FairnessFlag }) {
  return flag === "checkered" ? <i className={`checkered ${styles.checkered}`} aria-hidden="true" /> : <i className={`${styles.pip} ${styles[`pip_${flag}`]}`} aria-hidden="true" />;
}

/** A link of a row's: a page of Heat's in place, an explorer page in a new tab. */
function RowLink({ href, label, onRadar }: { href: string; label: string; onRadar: () => void }) {
  if (href === "#radar") {
    return (
      <a
        href="#radar"
        onClick={(e) => {
          e.preventDefault();
          onRadar();
        }}
      >
        {label}
      </a>
    );
  }
  if (href.startsWith("/")) return <Link href={href}>{label}</Link>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/** The counts the card opens with (spec 9): any red count first. */
function Counts({ counts }: { counts: FairnessCard["counts"] }) {
  return (
    <span className={styles.counts} data-testid="fairness-counts">
      {countsInOrder(counts).map(({ flag, count }) => (
        <span key={flag} className={`chip ${count ? COUNT_CHIP[flag] : "chip-neutral"} flag`} data-testid={`fairness-count-${flag}`}>
          {count} {flag}
        </span>
      ))}
    </span>
  );
}

/**
 * The coin's Fairness card (spec 9, layout B): a strip of flags above the chart, one a row (green proven on chain,
 * yellow labelled, red a Bundle Radar finding, checkered at Graduation), each opening below on a tap, Bundle Radar's
 * opening its evidence; the whole card one tap away, opening with its counts, any red first and its border red, with
 * the way to share it to X, where its image is the coin's link card. Read again whenever the coin's room reports
 * something the card states (`version`), and every minute.
 */
export function FairnessStrip({
  mint,
  ticker,
  decimals,
  quote,
  initial,
  version,
  radarVersion,
}: {
  mint: string;
  ticker: string;
  decimals: number;
  quote: QuoteInfo;
  initial: FairnessCard | null;
  version: number;
  radarVersion: number;
}) {
  const [card, setCard] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const radar = useRadar(mint, radarVersion);
  const detailId = useId();

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getFairness(mint)
        .then((c) => {
          if (stopped) return;
          setCard(c);
          setFailed(false);
        })
        .catch(() => !stopped && setFailed(true));
    // The first render has the server's card; a change the room reported waits out a burst of them.
    const first = version ? setTimeout(load, 500) : initial ? undefined : setTimeout(load, 0);
    const refresh = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(refresh);
    };
  }, [mint, version, initial]);

  // A link to the card itself, as a board row's flags give (`/coin/<mint>#fairness`), opens it whole.
  const hasCard = card !== null;
  useEffect(() => {
    if (hasCard && window.location.hash === "#fairness") setOpen("card");
  }, [hasCard]);

  const shownRadar = typeof open === "object" && open && "radar" in open ? shownRadarFlag(radar, open.radar) : null;
  const shownRow = typeof open === "object" && open && "row" in open ? (card?.rows.find((r) => r.key === open.row) ?? null) : null;
  const toggle = (next: Exclude<Open, null>) => setOpen((o) => (JSON.stringify(o) === JSON.stringify(next) ? null : next));
  const openRadar = () => {
    if (radar.linked.length) setOpen({ radar: "linked" });
    else if (radar.early.length) setOpen({ radar: "early" });
    document.getElementById("radar")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const red = (card?.counts.red ?? 0) > 0;

  return (
    <section id="fairness" className={styles.fairness} aria-label="Fairness card" data-testid="fairness">
      <div className={styles.stripHead}>
        <button
          type="button"
          className={`${styles.cardToggle} ${red ? styles.cardToggleRed : ""}`}
          aria-expanded={open === "card"}
          aria-controls={detailId}
          onClick={() => toggle("card")}
          disabled={!card}
          data-testid="fairness-toggle"
        >
          <span className="eyebrow">Fairness card</span>
          {card ? <Counts counts={card.counts} /> : <span className="note">{failed ? "unavailable just now" : "reading…"}</span>}
          <i className={styles.caret} aria-hidden="true" />
        </button>
        <Link className="note" href="/enforced">
          How this is enforced
        </Link>
      </div>

      <div className={styles.strip} data-testid="fairness-flags">
        {card?.rows.map((r) =>
          r.key === "radar" ? (
            <RadarFlagButtons
              key={r.key}
              state={radar}
              open={shownRadar}
              onToggle={(flag) => toggle({ radar: flag })}
              controls={detailId}
            />
          ) : (
            <button
              key={r.key}
              type="button"
              className={`chip ${CHIP[r.flag]} ${r.flag === "checkered" ? "" : "flag"} ${styles.flagChip} ${styles.flagButton}`}
              aria-expanded={shownRow?.key === r.key}
              aria-controls={detailId}
              onClick={() => toggle({ row: r.key })}
              data-testid={`fairness-flag-${r.key}`}
              data-flag={r.flag}
            >
              {r.flag === "checkered" && <i className={`checkered ${styles.checkered}`} aria-hidden="true" />}
              <span>{r.short}</span>
              <i className={styles.caret} aria-hidden="true" />
            </button>
          ),
        )}
      </div>

      <div id={detailId} hidden={!shownRow && !shownRadar && !(open === "card" && card)}>
        {shownRadar && <RadarEvidence state={radar} flag={shownRadar} ticker={ticker} decimals={decimals} quote={quote} />}
        {shownRow && (
          <div className={`panel ${styles.detail} ${styles[`detail_${shownRow.flag}`]}`} data-testid="fairness-detail">
            <RowBody row={shownRow} mode={card!.launchMode} onRadar={openRadar} />
          </div>
        )}
        {open === "card" && card && <WholeCard card={card} onRadar={openRadar} />}
      </div>
    </section>
  );
}

/**
 * Where "How this is enforced" says what keeps each row's promise and who could still change it (spec 9); none for the
 * creator's holdings, which promise nothing.
 */
function enforcedAnchor(row: FairnessRow, mode: FairnessCard["launchMode"]): string | null {
  switch (row.key) {
    case "launch":
      return mode === "fair_open" ? "fair-open" : "listed";
    case "creator_lock":
      return "creator-lock";
    case "liquidity":
      return "liquidity";
    case "finding":
    case "radar":
    case "creator":
      return "bars";
    case "keeper":
      return "listed";
    case "tax":
      return "fees";
    default:
      return null;
  }
}

/** One row: what it is about, what it states, how it is known, its links, and where Heat says how it is kept. */
function RowBody({ row, mode, onRadar }: { row: FairnessRow; mode: FairnessCard["launchMode"]; onRadar: () => void }) {
  const anchor = enforcedAnchor(row, mode);
  return (
    <>
      <div className={styles.rowHead}>
        <FlagMark flag={row.flag} />
        <span className="eyebrow">{row.title}</span>
      </div>
      <p className={`${styles.rowValue} ${row.flag === "red" ? styles.rowValueRed : ""}`}>{row.value}</p>
      <p className={styles.lead}>{row.detail}</p>
      {(row.links.length > 0 || anchor) && (
        <span className={styles.rowLinks}>
          {row.links.map((l) => (
            <RowLink key={l.href} href={l.href} label={l.label} onRadar={onRadar} />
          ))}
          {anchor && (
            <Link href={`/enforced#${anchor}`} className={styles.enforcedLink} data-testid={`fairness-enforced-${row.key}`}>
              How this is kept
            </Link>
          )}
        </span>
      )}
    </>
  );
}

/** The whole card, as its image says it, with the way to share it. */
function WholeCard({ card, onRadar }: { card: FairnessCard; onRadar: () => void }) {
  const red = card.counts.red > 0;
  const [copied, setCopied] = useState(false);
  const [pageUrl, setPageUrl] = useState(`/coin/${card.mint}`);
  useEffect(() => setPageUrl(`${window.location.origin}/coin/${card.mint}`), [card.mint]);
  const counts = countsInOrder(card.counts)
    .map(({ flag, count }) => `${count} ${flag}`)
    .join(", ");
  const post = `https://x.com/intent/post?${new URLSearchParams({ text: `$${card.ticker} on Heat, its Fairness card: ${counts}`, url: pageUrl })}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <article className={`panel ${styles.card} ${red ? styles.cardRed : ""}`} aria-label={`Fairness card of $${card.ticker}`} data-testid="fairness-card" data-red={red}>
      <header className={styles.cardHead}>
        <h2>Fairness card</h2>
        <Counts counts={card.counts} />
      </header>
      <ul className={styles.cardRows}>
        {card.rows.map((r) => (
          <li key={r.key} className={styles.cardRow} data-testid={`fairness-row-${r.key}`} data-flag={r.flag}>
            <RowBody row={r} mode={card.launchMode} onRadar={onRadar} />
          </li>
        ))}
      </ul>
      <footer className={styles.cardFoot}>
        <Link href="/enforced">How this is enforced</Link>
        <span className={styles.share}>
          <a className="btn btn-sm" href={post} target="_blank" rel="noreferrer" data-testid="fairness-share-x">
            Share on X
          </a>
          <button type="button" className="btn btn-sm btn-ghost" onClick={copy} data-testid="fairness-copy">
            {copied ? "Link copied" : "Copy link"}
          </button>
          <a className="btn btn-sm btn-ghost" href={card.image} target="_blank" rel="noreferrer" data-testid="fairness-image">
            Card image
          </a>
        </span>
      </footer>
    </article>
  );
}
