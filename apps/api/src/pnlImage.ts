// The P&L share card as an image (spec 9): a trader's position in a Heat coin, 2:1 like the Fairness card so it is X's
// large link card too, drawn with the same WebAssembly, fonts and dark theme (`cardImage.ts`).
import type { Position } from "@top-pad/contract";
import { coinAmount, dayOf, momentOf, pnlPercentText, pnlText, shortAddress } from "@top-pad/contract/format";
import { box, C, drawPng, el, flagIcon, pictureOf, type CardAssets, type El } from "./cardImage";
import { CARD_HEIGHT, CARD_WIDTH } from "./cardSize";
import { valueAt } from "./positionFigures";

/** The tone of a signed amount: green for a gain, red for a loss, plain for nothing either way. */
const toneOf = (signed: string) => (signed.startsWith("-") ? C.stop : signed === "0" ? C.fg : C.go);

/** What the position counts, in words: "1 Fair Open fill and 3 swaps". */
function countsText(p: Position) {
  const parts = [];
  if (p.fills) parts.push(`${p.fills} Fair Open ${p.fills === 1 ? "fill" : "fills"}`);
  if (p.swaps) parts.push(`${p.swaps} ${p.swaps === 1 ? "swap" : "swaps"}`);
  return parts.join(" and ");
}

/** The card's layout: the coin at the top, the P&L large, the figures it comes from, and whose and when at the foot. */
export function pnlLayout(p: Position, o: { cluster: string; web: string; picture: string | null }): El {
  const initials = (p.ticker || p.name || "?").slice(0, 2).toUpperCase();
  const picture = o.picture
    ? el("img", { width: 84, height: 84, borderRadius: 8, objectFit: "cover" }, undefined, { src: o.picture, width: 84, height: 84 })
    : box(
        { width: 84, height: 84, borderRadius: 8, background: C.panel2, border: `1px solid ${C.line}`, alignItems: "center", justifyContent: "center" },
        el("span", { fontFamily: "Saira Condensed", fontSize: 40, fontWeight: 700, color: C.muted }, initials),
      );
  const tone = toneOf(p.pnl);
  const stat = (label: string, value: string, note?: string) =>
    box(
      { flexDirection: "column", gap: 4, flex: 1, padding: "14px 18px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6, minWidth: 0 },
      el("span", { fontSize: 15, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", color: C.faint }, label),
      el("span", { fontFamily: "IBM Plex Mono", fontSize: 23, color: C.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, value),
      note ? el("span", { fontSize: 17, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, note) : null,
    );
  const taxShare = BigInt(p.taxShare) > 0n;
  const host = o.web.replace(/^https?:\/\//, "");
  return box(
    { width: CARD_WIDTH, height: CARD_HEIGHT, background: C.bg },
    box(
      { flex: 1, flexDirection: "column", color: C.fg, fontFamily: "IBM Plex Sans", border: `8px solid ${C.line}`, padding: "24px 40px 18px" },
      box(
        { alignItems: "center", gap: 24 },
        picture,
        box(
          { flexDirection: "column", flex: 1, gap: 4, minWidth: 0 },
          box(
            { alignItems: "baseline", gap: 16 },
            el("span", { fontFamily: "Saira Condensed", fontSize: 50, fontWeight: 700, lineHeight: 1, maxWidth: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, p.name),
            el("span", { fontFamily: "IBM Plex Mono", fontSize: 26, color: C.muted }, `$${p.ticker}`),
          ),
          box(
            { alignItems: "center", gap: 12, fontSize: 20, color: C.muted },
            el("span", {}, p.launchMode === "fair_open" ? "Fair Open" : "Instant launch"),
            el("span", { color: C.faint }, "·"),
            el("span", { fontFamily: "IBM Plex Mono" }, shortAddress(p.mint)),
          ),
        ),
        box(
          { flexDirection: "column", alignItems: "flex-end", gap: 6 },
          box({ alignItems: "center", gap: 10 }, flagIcon("green", 30), el("span", { fontFamily: "Saira Condensed", fontSize: 38, fontWeight: 700, letterSpacing: 1 }, "HEAT")),
          el("span", { fontSize: 16, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", color: C.faint }, o.cluster === "mainnet" ? "P&L card" : `P&L card · ${o.cluster}`),
        ),
      ),
      box({ flex: 1 }),
      box(
        { flexDirection: "column", gap: 0 },
        el("span", { fontSize: 17, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", color: C.faint }, "Profit and loss"),
        box(
          { alignItems: "baseline", gap: 28 },
          el("span", { fontFamily: "Saira Condensed", fontSize: 112, fontWeight: 700, lineHeight: 1.05, color: tone, whiteSpace: "nowrap" }, pnlText(p.pnl, p.quote, { signed: true })),
          p.pnlPercent === null ? null : el("span", { fontFamily: "Saira Condensed", fontSize: 56, fontWeight: 700, color: tone }, pnlPercentText(p.pnlPercent)),
        ),
      ),
      box(
        { gap: 14, marginTop: 14 },
        stat("Spent", pnlText(p.spent, p.quote), `for ${coinAmount(p.bought, p.decimals)} coins`),
        stat("Received", pnlText(p.received, p.quote), taxShare ? `and ${pnlText(p.taxShare, p.quote)} Tax Share` : `for ${coinAmount(p.sold, p.decimals)} coins`),
        stat("Holding", `${coinAmount(p.held, p.decimals)} coins`, `worth ${pnlText(p.value, p.quote)}`),
        stat("Fees paid", pnlText(p.fees, p.quote), "inside spent and received"),
      ),
      box(
        { gap: 12, marginTop: 18, alignItems: "center", fontSize: 19, color: C.muted },
        el("span", {}, `Price ${pnlText(valueAt(1_000_000n * 10n ** BigInt(p.decimals), p.price, p.decimals, p.quote.decimals).toString(), p.quote)} per million ${p.ticker}`),
        el("span", { color: C.faint }, "·"),
        el("span", {}, countsText(p)),
        el("span", { color: C.faint }, "·"),
        el("span", {}, `since ${dayOf(p.firstAt)}`),
      ),
      box({ flex: 1 }),
      box(
        { justifyContent: "space-between", alignItems: "center", gap: 24, borderTop: `1px solid ${C.line}`, paddingTop: 12, fontSize: 17, color: C.muted, whiteSpace: "nowrap" },
        el("span", {}, `Wallet ${shortAddress(p.wallet)} · as of ${momentOf(p.asOf)}`),
        el("span", { fontFamily: "IBM Plex Mono", color: C.fg }, `${host}/coin/${shortAddress(p.mint)}`),
      ),
    ),
  );
}

/** The card as a PNG of `CARD_WIDTH` by `CARD_HEIGHT`. */
export async function renderPnlImage(p: Position, o: { cluster: string; web: string; assets?: () => Promise<CardAssets> }): Promise<Uint8Array> {
  const picture = await pictureOf(p.imageUri);
  return drawPng(pnlLayout(p, { cluster: o.cluster, web: o.web, picture }), o.assets);
}
