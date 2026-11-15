"use client";

import type { Position } from "@top-pad/contract";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getPosition } from "@/lib/api";
import { coinAmount, momentOf, pnlPercentText, pnlText } from "@/lib/format";
import { useWallet } from "../WalletProvider";
import styles from "./PositionPanel.module.css";

/** A busy coin trades every second: its position is read again at most this often, and once after the last trade. */
const RELOAD_MS = 3_000;

/** A signed amount's tone: a gain green, a loss red. */
const toneOf = (signed: string) => (signed.startsWith("-") ? styles.loss : signed === "0" ? "" : styles.gain);

/** The share page of a snapshot, which X unfurls as the card's image. */
export const sharePath = (p: Pick<Position, "mint" | "wallet" | "at">) => `/pnl/${p.mint}/${p.wallet}?at=${p.at}`;

/**
 * The connected wallet's own position in the coin and its P&L (spec 9), from its indexed trades and Fair Open fill,
 * priced at the coin's latest trade, read again as the coin trades; and the P&L card to share, frozen at the moment the
 * trader opens it, so the image, the link and the post all say the same.
 */
export function PositionPanel({ mint, lastTradeKey }: { mint: string; lastTradeKey: string | null }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [position, setPosition] = useState<Position | null>(null);
  const [shared, setShared] = useState<Position | null>(null);
  const shareId = useId();

  // Read now, and again as the coin trades, at most every few seconds and always once after the newest trade.
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    if (!wallet) return;
    last.current = Date.now();
    const p = await getPosition(mint, wallet).catch(() => undefined);
    if (p !== undefined) setPosition(p && p.wallet === wallet ? p : null);
  }, [mint, wallet]);
  useEffect(() => {
    setPosition(null);
    setShared(null);
  }, [wallet]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, Math.max(0, last.current + RELOAD_MS - Date.now()));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, lastTradeKey]);

  if (!wallet || !position || position.wallet !== wallet) return null;
  const p = position;
  const taxShare = BigInt(p.taxShare) > 0n;
  return (
    <section className={`panel ${styles.panel}`} aria-labelledby={`${shareId}-title`} data-testid="position">
      <div className={styles.head}>
        <h2 id={`${shareId}-title`} className="eyebrow">
          Your position
        </h2>
        <span className="note">{[p.fills ? "Fair Open fill" : null, p.swaps ? `${p.swaps} ${p.swaps === 1 ? "swap" : "swaps"}` : null].filter(Boolean).join(" + ")}</span>
      </div>
      <p className={styles.pnl}>
        <span className={`num ${styles.pnlFigure} ${toneOf(p.pnl)}`} data-testid="position-pnl">
          {pnlText(p.pnl, p.quote, { signed: true })}
        </span>
        {p.pnlPercent !== null && (
          <span className={`num ${toneOf(p.pnl)}`} data-testid="position-pnl-percent">
            {pnlPercentText(p.pnlPercent)}
          </span>
        )}
      </p>
      <dl className={styles.figures}>
        <div>
          <dt>Holding</dt>
          <dd className="num" data-testid="position-held">
            {coinAmount(p.held, p.decimals)} {p.ticker}
          </dd>
          <dd className="note">worth {pnlText(p.value, p.quote)}</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd className="num" data-testid="position-spent">
            {pnlText(p.spent, p.quote)}
          </dd>
          <dd className="note">fees {pnlText(p.fees, p.quote)}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd className="num" data-testid="position-received">
            {pnlText(p.received, p.quote)}
          </dd>
          {taxShare && <dd className="note">and {pnlText(p.taxShare, p.quote)} Tax Share</dd>}
        </div>
        <div>
          <dt>Realized</dt>
          <dd className={`num ${toneOf(p.realized)}`} data-testid="position-realized">
            {pnlText(p.realized, p.quote, { signed: true })}
          </dd>
          <dd className="note">on coins held {pnlText(p.unrealized, p.quote, { signed: true })}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={shared !== null}
        aria-controls={shareId}
        onClick={() => setShared((s) => (s ? null : p))}
        data-testid="position-share"
      >
        {shared ? "Close the P&L card" : "Share P&L card"}
      </button>
      <div id={shareId} hidden={!shared}>
        {shared && <ShareCard position={shared} newer={p.at !== shared.at} onNewer={() => setShared(p)} />}
      </div>
    </section>
  );
}

/** The card of one snapshot: its image, and the ways to share it. */
function ShareCard({ position: p, newer, onNewer }: { position: Position; newer: boolean; onNewer: () => void }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState<"idle" | "busy" | "failed">("idle");
  const [canShareFiles, setCanShareFiles] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" });
    setCanShareFiles(typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }));
  }, []);
  const link = `${origin}${sharePath(p)}`;
  const words = `My $${p.ticker} P&L on Heat: ${pnlText(p.pnl, p.quote, { signed: true }).replace("\u{a0}", " ")}${p.pnlPercent === null ? "" : ` (${pnlPercentText(p.pnlPercent)})`}`;
  const post = `https://x.com/intent/post?${new URLSearchParams({ text: words, url: link })}`;
  const fileName = `heat-pnl-${p.ticker.toLowerCase()}-${p.at}.png`;

  const file = async () => {
    const res = await fetch(p.card);
    if (!res.ok) throw new Error(`the card answered ${res.status}`);
    return new File([await res.blob()], fileName, { type: "image/png" });
  };
  const download = async () => {
    setSaving("busy");
    try {
      const url = URL.createObjectURL(await file());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaving("idle");
    } catch {
      setSaving("failed");
    }
  };
  const share = async () => {
    try {
      await navigator.share({ files: [await file()], text: words, url: link });
    } catch {
      // The trader closed the sheet, or the device refused the file: nothing to say.
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <figure className={styles.share} data-testid="position-card">
      <img className={styles.image} src={p.card} width={1200} height={600} alt={`${words}, as of ${momentOf(p.asOf)}`} data-testid="position-card-image" />
      <figcaption className="note">
        As of {momentOf(p.asOf)}, priced at the coin&apos;s last trade then. The card and its link stay as they are whatever the price does next.
        {newer && (
          <>
            {" "}
            <button type="button" className={styles.linkButton} onClick={onNewer} data-testid="position-card-newer">
              Card of now
            </button>
          </>
        )}
      </figcaption>
      <div className={styles.actions}>
        <a className="btn btn-sm" href={post} target="_blank" rel="noreferrer" data-testid="position-share-x">
          Share on X
        </a>
        {canShareFiles && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={share} data-testid="position-share-device">
            Share image
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={download} disabled={saving === "busy"} data-testid="position-download">
          {saving === "busy" ? "Saving…" : saving === "failed" ? "Save failed, try again" : "Save image"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={copy} data-testid="position-copy">
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </figure>
  );
}
